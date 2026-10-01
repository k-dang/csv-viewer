import { Effect } from 'effect';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WorkspaceRequestError } from '@csv-viewer/workspace/errors';
import { scopedEngineSource } from '@csv-viewer/workspace/engine-source';
import { electronCsvViewerCapabilities } from '../electron-csv-viewer-capabilities';
import type { CsvSourceId } from '@csv-viewer/workspace/csv-viewer';
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
  registerSource(filePath: string) {
    return filesystemEffect(() => captureFileIdentity(filePath)).pipe(
      Effect.mapError(toSourceUnavailableError),
      Effect.map((identity) => {
        const identityKey = buildIdentityKey(identity, filePath);
        const existingId = this.sourceIdsByIdentity.get(identityKey);
        const sourceId = existingId ?? crypto.randomUUID();
        this.sources.set(sourceId, { sourceId, filePath, identity });
        this.sourceIdsByIdentity.set(identityKey, sourceId);
        return sourceId;
      }),
    );
  }

  acquireSource() {
    return Effect.promise(() => this.prompts.chooseSource()).pipe(
      Effect.flatMap((filePath) => filePath ? this.registerSource(filePath) : Effect.succeed(null)),
    );
  }

  acquireDroppedSource(filePath: string) {
    return Effect.gen({ self: this }, function* () {
      if (!/\.(csv|tsv|txt)$/i.test(filePath)) {
        return yield* Effect.fail(new WorkspaceRequestError({ message: 'Only CSV, TSV, and TXT files can be dropped.' }));
      }
      const fileStats = yield* filesystemEffect(() => stat(filePath)).pipe(Effect.mapError(toSourceUnavailableError));
      if (!fileStats.isFile()) {
        return yield* Effect.fail(new WorkspaceRequestError({ message: 'Folders cannot be opened. Drop CSV, TSV, or TXT files.' }));
      }
      return yield* this.registerSource(filePath);
    });
  }

  releaseSource(): void {
    // Desktop retains identity for Recent CSV Sources; it holds no open file or byte reservation.
  }

  describeSource(sourceId: CsvSourceId) {
    return Effect.gen({ self: this }, function* () {
      const { filePath } = yield* this.requireSource(sourceId);
      const fileStats = yield* filesystemEffect(() => stat(filePath)).pipe(
        Effect.tapError((cause) => cause.code === 'ENOENT' ? this.forgetRecentPath(filePath) : Effect.void),
        Effect.mapError(toSourceUnavailableError),
      );
      if (!fileStats.isFile()) {
        yield* this.forgetRecentPath(filePath);
        return yield* Effect.fail(new CsvSourceUnavailableError('unreadable', 'Selected path is not a file.'));
      }
      return {
        sourceId,
        name: path.basename(filePath),
        location: filePath,
        sizeBytes: fileStats.size,
        defaultDelimiter: defaultDelimiterForSourceName(filePath),
      } satisfies CsvSourceDescription;
    });
  }

  acquireEngineSource(sourceId: CsvSourceId) {
    return scopedEngineSource(
      this.requireSource(sourceId).pipe(Effect.map((source) => source.filePath)),
      () => Effect.void,
    );
  }

  deliverExport(request: CsvExportRequestForDelivery) {
    return Effect.gen({ self: this }, function* () {
      const source = yield* this.requireSource(request.sourceId);
      const defaultPath = path.join(path.dirname(source.filePath), buildDefaultExportName(request.suggestedName));
      while (true) {
        const destinationPath = yield* Effect.promise(() => this.prompts.chooseExportDestination(defaultPath));
        if (!destinationPath) return { status: 'cancelled' } satisfies CsvExportDelivery;
        const conflicts = yield* this.isSourceDestination(request.sourceId, destinationPath);
        if (conflicts) {
          yield* Effect.promise(() => this.prompts.showSourceConflict());
          continue;
        }
        yield* filesystemEffect(() => writeFile(destinationPath, request.contents, 'utf8')).pipe(Effect.mapError(toSourceUnavailableError));
        return { status: 'delivered' } satisfies CsvExportDelivery;
      }
    });
  }

  recentSources() {
    return Effect.gen({ self: this }, function* () {
      const entries = yield* this.readRecentEntries();
      const gone = new Set<string>();
      const hidden = new Set<string>();
      for (const entry of entries) {
        const resolvedPath = path.resolve(entry.path);
        const state = yield* this.classifyRecentPath(entry.path);
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
        : yield* this.modifyRecentEntries((latest) => latest.filter((entry) => !gone.has(path.resolve(entry.path))));
      const available = current.filter((entry) => {
        const resolvedPath = path.resolve(entry.path);
        return !gone.has(resolvedPath) && !hidden.has(resolvedPath);
      });
      return yield* Effect.forEach(available, (entry) => this.registerSource(entry.path).pipe(
        Effect.map((sourceId) => ({
          sourceId,
          name: entry.name,
          location: entry.path,
          sizeBytes: entry.sizeBytes,
          lastOpenedAt: entry.lastOpenedAt,
        })),
      ), { concurrency: 'unbounded' });
    });
  }

  recordRecentSource(sourceId: CsvSourceId) {
    return Effect.gen({ self: this }, function* () {
      const source = this.sources.get(sourceId);
      if (!source) return;
      const normalizedPath = path.resolve(source.filePath);
      const fileStats = yield* filesystemEffect(() => stat(normalizedPath)).pipe(Effect.catch(() => Effect.succeed(null)));
      const nextEntry: RecentSourceEntry = {
        path: normalizedPath,
        name: path.basename(normalizedPath),
        sizeBytes: fileStats?.size ?? 0,
        lastOpenedAt: new Date().toISOString(),
      };
      yield* this.modifyRecentEntries((entries) =>
        [nextEntry, ...entries.filter((entry) => path.resolve(entry.path) !== normalizedPath)].slice(0, maxRecentSources),
      );
    });
  }

  confirmDiscardChanges(sourceName: string) {
    return Effect.promise(() => this.prompts.confirmDiscardChanges(sourceName));
  }

  private isSourceDestination(sourceId: CsvSourceId, destinationPath: string) {
    return Effect.suspend(() => {
      const sourceIdentity = this.sources.get(sourceId)?.identity;
      if (!sourceIdentity) return Effect.succeed(false);
      return filesystemEffect(() => captureFileIdentity(destinationPath)).pipe(
        Effect.mapError(toSourceUnavailableError),
        Effect.map((destinationIdentity) => destinationIdentity ? sameFileIdentity(sourceIdentity, destinationIdentity) : false),
      );
    });
  }

  private requireSource(sourceId: CsvSourceId) {
    return Effect.suspend(() => {
      const source = this.sources.get(sourceId);
      return source ? Effect.succeed(source) : Effect.fail(new CsvSourceUnavailableError('missing-source', 'The CSV Source is not available.'));
    });
  }

  private classifyRecentPath(filePath: string) {
    return filesystemEffect(() => stat(filePath)).pipe(
      Effect.map((fileStats) => fileStats.isFile() ? 'file' as const : 'gone' as const),
      Effect.catch((cause) => {
        if (cause.code === 'ENOENT' || cause.code === 'ENOTDIR') return Effect.succeed('gone' as const);
        if (cause.code === 'EACCES' || cause.code === 'EPERM') return Effect.succeed('inaccessible' as const);
        return Effect.fail(toSourceUnavailableError(cause));
      }),
    );
  }

  private forgetRecentPath(filePath: string) {
    const resolvedPath = path.resolve(filePath);
    return this.modifyRecentEntries((entries) => entries.filter((entry) => path.resolve(entry.path) !== resolvedPath));
  }

  private modifyRecentEntries(update: (entries: RecentSourceEntry[]) => RecentSourceEntry[]) {
    return Effect.suspend(() => {
      const run = this.recentEntriesUpdate.then(() => Effect.runPromiseExit(Effect.gen({ self: this }, function* () {
        const entries = yield* this.readRecentEntries();
        const next = update(entries);
        if (next.length === entries.length && next.every((entry, index) => entry === entries[index])) return entries;
        yield* this.writeRecentEntries(next);
        return next;
      })));
      this.recentEntriesUpdate = run.then(() => undefined);
      return Effect.promise(() => run).pipe(Effect.flatten);
    });
  }

  private writeRecentEntries(entries: RecentSourceEntry[]) {
    return Effect.gen({ self: this }, function* () {
      yield* filesystemEffect(() => mkdir(path.dirname(this.recentSourcesPath), { recursive: true }));
      yield* filesystemEffect(() => writeFile(this.recentSourcesPath, JSON.stringify(entries, null, 2), 'utf8'));
    }).pipe(Effect.catch((cause) => Effect.sync(() => warnRecentSourceFailure('write', recentSourceFailureCategory(cause)))));
  }

  private readRecentEntries() {
    return filesystemEffect(() => readFile(this.recentSourcesPath, 'utf8')).pipe(
      Effect.map((contents) => {
        let parsed: JsonValue;
        try {
          parsed = JSON.parse(contents);
        } catch (cause) {
          if (!(cause instanceof SyntaxError)) throw cause;
          warnRecentSourceFailure('read', 'invalid-format');
          return [];
        }
        if (!Array.isArray(parsed)) {
          warnRecentSourceFailure('read', 'invalid-format');
          return [];
        }
        return parsed.filter(isRecentSourceEntry).slice(0, maxRecentSources);
      }),
      Effect.catch((cause) => Effect.sync(() => {
        if (cause.code !== 'ENOENT') warnRecentSourceFailure('read', recentSourceFailureCategory(cause));
        return [];
      })),
    );
  }
}

type RecentSourceEntry = {
  path: string;
  name: string;
  sizeBytes: number;
  lastOpenedAt: string;
};

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function recentSourceFailureCategory(cause: NodeJS.ErrnoException): 'permission-denied' | 'io-failure' {
  return cause.code === 'EACCES' || cause.code === 'EPERM' ? 'permission-denied' : 'io-failure';
}

function warnRecentSourceFailure(action: 'read' | 'write', category: 'invalid-format' | ReturnType<typeof recentSourceFailureCategory>): void {
  console.warn(`Unable to ${action} Recent CSV Sources (${category}).`);
}

function buildIdentityKey(identity: CanonicalFileIdentity | null, filePath: string): string {
  if (identity && identity.inode !== 0n) return `inode:${identity.device}:${identity.inode}`;
  return `path:${normalizeCanonicalPath(identity?.canonicalPath ?? path.resolve(filePath))}`;
}

function buildDefaultExportName(sourceName: string): string {
  const parsed = path.parse(sourceName);
  return `${parsed.name}-edited${parsed.ext || '.csv'}`;
}

function toSourceUnavailableError(cause: NodeJS.ErrnoException): CsvSourceUnavailableError {
  if (cause.code === 'ENOENT') {
    return new CsvSourceUnavailableError('missing-source', 'The CSV Source no longer exists.');
  }
  if (cause.code === 'EACCES' || cause.code === 'EPERM') {
    return new CsvSourceUnavailableError('permission-denied', 'Permission was denied for the CSV Source.');
  }
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

/** Only Node filesystem errors are expected at this platform boundary; other exceptions are defects. */
function filesystemEffect<A>(operation: () => Promise<A>): Effect.Effect<A, NodeJS.ErrnoException> {
  return Effect.tryPromise({ try: operation, catch: (cause) => cause }).pipe(
    Effect.catch((cause) => isFileSystemError(cause) ? Effect.fail(cause) : Effect.die(cause)),
  );
}
