import type { Stats } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { toError } from '@csv-viewer/workspace/errors';
import { electronCsvViewerCapabilities } from '../electron-csv-viewer-capabilities';
import type { CsvSourceId, RecentCsvSource } from '@csv-viewer/workspace/csv-viewer';
import {
  CsvSourceUnavailableError,
  defaultDelimiterForSourceName,
  type CsvExportDelivery,
  type CsvExportRequestForDelivery,
  type CsvSourceDescription,
  type CsvWorkspaceHost,
} from '@csv-viewer/workspace/workspace-host';
import {
  captureFileIdentity,
  chooseCsvExportDestination,
  isFileSystemError,
  normalizeCanonicalPath,
  sameFileIdentity,
  type CanonicalFileIdentity,
} from './desktop-csv-export';

const maxRecentSources = 8;

export type DesktopWorkspacePrompts = {
  /** Ask for one CSV Source to open. Resolves to null when cancelled. */
  chooseSource(): Promise<string | null>;
  /** Ask where to write an exported CSV. Resolves to null when cancelled. */
  chooseExportDestination(defaultPath: string): Promise<string | null>;
  /** Tell the user their chosen destination is the CSV Source, then re-prompt. */
  showSourceConflict(): Promise<void>;
  /** Ask whether Unexported Changes may be discarded before reopening a Working CSV. */
  confirmDiscardChanges(sourceName: string): Promise<boolean>;
};

type RegisteredSource = {
  sourceId: CsvSourceId;
  filePath: string;
  identity: CanonicalFileIdentity | null;
};

/**
 * Desktop implementation of the workspace host. Canonical file identity, Node filesystem access,
 * and Electron prompts stay here; the workspace only ever sees opaque CSV Source identity.
 */
export class DesktopWorkspaceHost implements CsvWorkspaceHost {
  readonly capabilities = electronCsvViewerCapabilities;
  private readonly sources = new Map<CsvSourceId, RegisteredSource>();
  private readonly sourceIdsByIdentity = new Map<string, CsvSourceId>();
  private recentEntriesUpdate: Promise<void> = Promise.resolve();

  constructor(
    private readonly prompts: DesktopWorkspacePrompts,
    private readonly recentSourcesPath: string,
  ) {}

  /** Maps a file path to its stable, opaque CSV Source identity for this workspace session. */
  async registerSource(filePath: string): Promise<CsvSourceId> {
    const identity = await captureFileIdentity(filePath);
    const identityKey = buildIdentityKey(identity, filePath);
    const existingId = this.sourceIdsByIdentity.get(identityKey);
    if (existingId) {
      this.sources.set(existingId, { sourceId: existingId, filePath, identity });
      return existingId;
    }

    const sourceId = crypto.randomUUID();
    this.sources.set(sourceId, { sourceId, filePath, identity });
    this.sourceIdsByIdentity.set(identityKey, sourceId);
    return sourceId;
  }

  async acquireSource(): Promise<CsvSourceId | null> {
    const filePath = await this.prompts.chooseSource();
    return filePath ? this.registerSource(filePath) : null;
  }

  async acquireDroppedSource(filePath: string): Promise<CsvSourceId> {
    if (!/\.(csv|tsv|txt)$/i.test(filePath)) throw new Error('Only CSV, TSV, and TXT files can be dropped.');
    const fileStats = await stat(filePath);
    if (!fileStats.isFile()) throw new Error('Folders cannot be opened. Drop CSV, TSV, or TXT files.');
    return this.registerSource(filePath);
  }

  releaseSource(): void {
    // Desktop retains identity for Recent CSV Sources; it holds no open file or byte reservation.
  }

  async describeSource(sourceId: CsvSourceId): Promise<CsvSourceDescription> {
    const filePath = this.requireSource(sourceId).filePath;
    let fileStats: Stats;
    try {
      fileStats = await stat(filePath);
    } catch (cause: unknown) {
      if (isFileSystemError(cause) && cause.code === 'ENOENT') await this.forgetRecentPath(filePath);
      throw toSourceUnavailableError(cause);
    }
    if (!fileStats.isFile()) {
      await this.forgetRecentPath(filePath);
      throw new CsvSourceUnavailableError('unreadable', 'Selected path is not a file.');
    }

    return {
      sourceId,
      name: path.basename(filePath),
      location: filePath,
      sizeBytes: fileStats.size,
      defaultDelimiter: defaultDelimiterForSourceName(filePath),
    };
  }

  async withEngineSource<T>(sourceId: CsvSourceId, use: (engineSourceReference: string) => Promise<T>): Promise<T> {
    return use(this.requireSource(sourceId).filePath);
  }

  async deliverExport(request: CsvExportRequestForDelivery): Promise<CsvExportDelivery> {
    const defaultPath = path.join(
      path.dirname(this.requireSource(request.sourceId).filePath),
      buildDefaultExportName(request.suggestedName),
    );
    const destinationPath = await chooseCsvExportDestination({
      chooseDestination: () => this.prompts.chooseExportDestination(defaultPath),
      isSourceDestination: (candidatePath) => this.isSourceDestination(request.sourceId, candidatePath),
      showSourceConflict: () => this.prompts.showSourceConflict(),
    });
    if (!destinationPath) return { status: 'cancelled' };

    await writeFile(destinationPath, request.contents, 'utf8');
    return { status: 'delivered' };
  }

  async recentSources(): Promise<RecentCsvSource[]> {
    const entries = await this.readRecentEntries();
    const gone = new Set<string>();
    const hidden = new Set<string>();
    for (const entry of entries) {
      const resolvedPath = path.resolve(entry.path);
      const state = await this.classifyRecentPath(entry.path);
      switch (state) {
        case 'file':
          break;
        case 'gone':
          gone.add(resolvedPath);
          break;
        case 'inaccessible':
          hidden.add(resolvedPath);
          break;
        default: {
          const unreachable: never = state;
          throw new Error(`Unexpected recent path state: ${unreachable}`);
        }
      }
    }

    const current = gone.size === 0
      ? entries
      : await this.modifyRecentEntries((latest) => latest.filter((entry) => !gone.has(path.resolve(entry.path))));
    const available = current.filter((entry) => {
      const resolvedPath = path.resolve(entry.path);
      return !gone.has(resolvedPath) && !hidden.has(resolvedPath);
    });

    return Promise.all(
      available.map(async (entry) => ({
        sourceId: await this.registerSource(entry.path),
        name: entry.name,
        location: entry.path,
        sizeBytes: entry.sizeBytes,
        lastOpenedAt: entry.lastOpenedAt,
      })),
    );
  }

  async recordRecentSource(sourceId: CsvSourceId): Promise<void> {
    const source = this.sources.get(sourceId);
    if (!source) return;
    const normalizedPath = path.resolve(source.filePath);
    const fileStats = await stat(normalizedPath).catch(() => null);
    const nextEntry: RecentSourceEntry = {
      path: normalizedPath,
      name: path.basename(normalizedPath),
      sizeBytes: fileStats?.size ?? 0,
      lastOpenedAt: new Date().toISOString(),
    };
    await this.modifyRecentEntries((entries) =>
      [nextEntry, ...entries.filter((entry) => path.resolve(entry.path) !== normalizedPath)].slice(0, maxRecentSources),
    );
  }

  confirmDiscardChanges(sourceName: string): Promise<boolean> {
    return this.prompts.confirmDiscardChanges(sourceName);
  }

  private async isSourceDestination(sourceId: CsvSourceId, destinationPath: string): Promise<boolean> {
    const sourceIdentity = this.sources.get(sourceId)?.identity;
    if (!sourceIdentity) return false;
    const destinationIdentity = await captureFileIdentity(destinationPath);
    return destinationIdentity ? sameFileIdentity(sourceIdentity, destinationIdentity) : false;
  }

  private requireSource(sourceId: CsvSourceId): RegisteredSource {
    const source = this.sources.get(sourceId);
    if (!source) {
      throw new CsvSourceUnavailableError('missing-source', 'The CSV Source is not available.');
    }
    return source;
  }

  private async classifyRecentPath(filePath: string): Promise<'file' | 'gone' | 'inaccessible'> {
    try {
      return (await stat(filePath)).isFile() ? 'file' : 'gone';
    } catch (cause: unknown) {
      if (!isFileSystemError(cause)) throw cause;
      if (cause.code === 'ENOENT' || cause.code === 'ENOTDIR') return 'gone';
      if (cause.code === 'EACCES' || cause.code === 'EPERM') return 'inaccessible';
      throw cause;
    }
  }

  private forgetRecentPath(filePath: string): Promise<RecentSourceEntry[]> {
    const resolvedPath = path.resolve(filePath);
    return this.modifyRecentEntries((entries) => entries.filter((entry) => path.resolve(entry.path) !== resolvedPath));
  }

  private modifyRecentEntries(
    update: (entries: RecentSourceEntry[]) => RecentSourceEntry[],
  ): Promise<RecentSourceEntry[]> {
    const run = this.recentEntriesUpdate.then(async () => {
      const entries = await this.readRecentEntries();
      const next = update(entries);
      if (next.length === entries.length && next.every((entry, index) => entry === entries[index])) return entries;
      await this.writeRecentEntries(next);
      return next;
    });
    this.recentEntriesUpdate = run.then(() => undefined, () => undefined);
    return run;
  }

  private async writeRecentEntries(entries: RecentSourceEntry[]): Promise<void> {
    try {
      await mkdir(path.dirname(this.recentSourcesPath), { recursive: true });
      await writeFile(this.recentSourcesPath, JSON.stringify(entries, null, 2), 'utf8');
    } catch (cause: unknown) {
      console.warn('Unable to write Recent CSV Sources.', cause);
    }
  }

  private async readRecentEntries(): Promise<RecentSourceEntry[]> {
    try {
      const parsed = JSON.parse(await readFile(this.recentSourcesPath, 'utf8'));
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isRecentSourceEntry).slice(0, maxRecentSources);
    } catch (cause: unknown) {
      if (isFileSystemError(cause) && cause.code === 'ENOENT') return [];
      console.warn('Unable to read Recent CSV Sources.', cause);
      return [];
    }
  }
}

type RecentSourceEntry = {
  path: string;
  name: string;
  sizeBytes: number;
  lastOpenedAt: string;
};

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function buildIdentityKey(identity: CanonicalFileIdentity | null, filePath: string): string {
  if (identity && identity.inode !== 0n) return `inode:${identity.device}:${identity.inode}`;
  return `path:${normalizeCanonicalPath(identity?.canonicalPath ?? path.resolve(filePath))}`;
}

function buildDefaultExportName(sourceName: string): string {
  const parsed = path.parse(sourceName);
  return `${parsed.name}-edited${parsed.ext || '.csv'}`;
}

function toSourceUnavailableError(cause: unknown): Error {
  if (!isFileSystemError(cause)) return toError(cause);
  if (cause.code === 'ENOENT') {
    return new CsvSourceUnavailableError('missing-source', 'The CSV Source no longer exists.');
  }
  if (cause.code === 'EACCES' || cause.code === 'EPERM') {
    return new CsvSourceUnavailableError('permission-denied', 'Permission was denied for the CSV Source.');
  }
  console.error('Unable to read the CSV Source.', cause);
  return new CsvSourceUnavailableError('unreadable', 'The CSV Source could not be read.');
}

function isRecentSourceEntry(value: JsonValue): value is RecentSourceEntry {
  if (!(value instanceof Object) || Array.isArray(value)) return false;
  const pathValue = Object.getOwnPropertyDescriptor(value, 'path')?.value;
  const name = Object.getOwnPropertyDescriptor(value, 'name')?.value;
  const sizeBytes = Object.getOwnPropertyDescriptor(value, 'sizeBytes')?.value;
  const lastOpenedAt = Object.getOwnPropertyDescriptor(value, 'lastOpenedAt')?.value;
  return (
    Object.prototype.toString.call(pathValue) === '[object String]' &&
    Object.prototype.toString.call(name) === '[object String]' &&
    Object.prototype.toString.call(sizeBytes) === '[object Number]' &&
    Object.prototype.toString.call(lastOpenedAt) === '[object String]'
  );
}
