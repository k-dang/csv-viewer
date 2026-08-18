import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { toError } from '../shared/errors';
import type { CsvSourceId, RecentCsvSource } from '../shared/ipc';
import {
  CsvSourceUnavailableError,
  type CsvExportDelivery,
  type CsvExportRequestForDelivery,
  type CsvSourceDescription,
  type CsvWorkspaceHost,
} from '../workspace/workspace-host';
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
  private readonly sources = new Map<CsvSourceId, RegisteredSource>();
  private readonly sourceIdsByIdentity = new Map<string, CsvSourceId>();

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

  async describeSource(sourceId: CsvSourceId): Promise<CsvSourceDescription> {
    const filePath = this.requireSource(sourceId).filePath;
    const fileStats = await stat(filePath).catch((error: unknown) => {
      throw toSourceUnavailableError(error);
    });
    if (!fileStats.isFile()) {
      throw new CsvSourceUnavailableError('unreadable', 'Selected path is not a file.');
    }

    return {
      sourceId,
      name: path.basename(filePath),
      location: filePath,
      sizeBytes: fileStats.size,
      defaultDelimiter: path.extname(filePath).toLowerCase() === '.tsv' ? '\t' : ',',
    };
  }

  async withEngineSource<T>(
    sourceId: CsvSourceId,
    use: (engineSourceReference: string) => Promise<T>,
  ): Promise<T> {
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
    return Promise.all(
      entries.map(async (entry) => ({
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
    const entries = await this.readRecentEntries();
    const nextEntries = [
      {
        path: normalizedPath,
        name: path.basename(normalizedPath),
        sizeBytes: fileStats?.size ?? 0,
        lastOpenedAt: new Date().toISOString(),
      },
      ...entries.filter((entry) => path.resolve(entry.path) !== normalizedPath),
    ].slice(0, maxRecentSources);

    try {
      await mkdir(path.dirname(this.recentSourcesPath), { recursive: true });
      await writeFile(this.recentSourcesPath, JSON.stringify(nextEntries, null, 2), 'utf8');
    } catch (error: unknown) {
      console.warn('Unable to write Recent CSV Sources.', error);
    }
  }

  private async isSourceDestination(
    sourceId: CsvSourceId,
    destinationPath: string,
  ): Promise<boolean> {
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

  private async readRecentEntries(): Promise<RecentSourceEntry[]> {
    try {
      const parsed = JSON.parse(await readFile(this.recentSourcesPath, 'utf8')) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isRecentSourceEntry).slice(0, maxRecentSources);
    } catch (error: unknown) {
      if (isFileSystemError(error) && error.code === 'ENOENT') return [];
      console.warn('Unable to read Recent CSV Sources.', error);
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

function buildIdentityKey(identity: CanonicalFileIdentity | null, filePath: string): string {
  if (identity && identity.inode !== 0n) return `inode:${identity.device}:${identity.inode}`;
  return `path:${normalizeCanonicalPath(identity?.canonicalPath ?? path.resolve(filePath))}`;
}

function buildDefaultExportName(sourceName: string): string {
  const parsed = path.parse(sourceName);
  return `${parsed.name}-edited${parsed.ext || '.csv'}`;
}

function toSourceUnavailableError(error: unknown): Error {
  if (!isFileSystemError(error)) return toError(error);
  if (error.code === 'ENOENT') {
    return new CsvSourceUnavailableError('missing-source', 'The CSV Source no longer exists.');
  }
  if (error.code === 'EACCES' || error.code === 'EPERM') {
    return new CsvSourceUnavailableError(
      'permission-denied',
      'Permission was denied for the CSV Source.',
    );
  }
  console.error('Unable to read the CSV Source.', error);
  return new CsvSourceUnavailableError('unreadable', 'The CSV Source could not be read.');
}

function isRecentSourceEntry(value: unknown): value is RecentSourceEntry {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<RecentSourceEntry>;
  return (
    typeof candidate.path === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.sizeBytes === 'number' &&
    typeof candidate.lastOpenedAt === 'string'
  );
}
