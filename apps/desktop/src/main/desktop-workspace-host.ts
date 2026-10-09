import { Effect, Option, Schema, Semaphore } from 'effect';
import { mkdir, readFile, stat, writeFile, rename, unlink } from 'node:fs/promises';
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

/** The platform write boundary; failures can occur after writing only part of the staging file. */
export type DesktopExportWriter = (temporaryPath: string, contents: string) => Promise<void>;

const writeExportContents: DesktopExportWriter = (temporaryPath, contents) =>
  writeFile(temporaryPath, contents, { encoding: 'utf8', flag: 'wx' });

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
  private readonly recentEntriesLock = Semaphore.makeUnsafe(1);

  constructor(
    private readonly prompts: DesktopWorkspacePrompts,
    private readonly recentSourcesPath: string,
    private readonly writeExport: DesktopExportWriter = writeExportContents,
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

  readonly acquireDroppedSource = Effect.fnUntraced(function* (this: DesktopWorkspaceHost, filePath: string) {
    if (!/\.(csv|tsv|txt)$/i.test(filePath)) {
      return yield* Effect.fail(new WorkspaceRequestError({ message: 'Only CSV, TSV, and TXT files can be dropped.' }));
    }
    const fileStats = yield* filesystemEffect(() => stat(filePath)).pipe(Effect.mapError(toSourceUnavailableError));
    if (!fileStats.isFile()) {
      return yield* Effect.fail(new WorkspaceRequestError({ message: 'Folders cannot be opened. Drop CSV, TSV, or TXT files.' }));
    }
    return yield* this.registerSource(filePath);
  });

  releaseSource(): void {
    // Desktop retains identity for Recent CSV Sources; it holds no open file or byte reservation.
  }

  readonly describeSource = Effect.fnUntraced(function* (this: DesktopWorkspaceHost, sourceId: CsvSourceId) {
    const { filePath } = yield* this.requireSource(sourceId);
    const fileStats = yield* filesystemEffect(() => stat(filePath)).pipe(
      Effect.tapError((cause) => cause.code === 'ENOENT' ? this.forgetRecentPath(filePath) : Effect.void),
      Effect.mapError(toSourceUnavailableError),
    );
    if (!fileStats.isFile()) {
      yield* this.forgetRecentPath(filePath);
      return yield* Effect.fail(new CsvSourceUnavailableError({ code: 'unreadable', message: 'Selected path is not a file.' }));
    }
    return {
      sourceId,
      name: path.basename(filePath),
      location: filePath,
      sizeBytes: fileStats.size,
      defaultDelimiter: defaultDelimiterForSourceName(filePath),
    } satisfies CsvSourceDescription;
  });

  acquireEngineSource(sourceId: CsvSourceId) {
    return scopedEngineSource(
      this.requireSource(sourceId).pipe(Effect.map((source) => source.filePath)),
      () => Effect.void,
    );
  }

  readonly deliverExport = Effect.fnUntraced(function* (this: DesktopWorkspaceHost, request: CsvExportRequestForDelivery) {
    const source = yield* this.requireSource(request.sourceId);
    const defaultPath = path.join(path.dirname(source.filePath), request.kind === 'view' ? request.suggestedName : buildDefaultExportName(request.suggestedName));
    while (true) {
      const destinationPath = yield* Effect.promise(() => this.prompts.chooseExportDestination(defaultPath));
      if (!destinationPath) return { status: 'cancelled' } satisfies CsvExportDelivery;
      const conflicts = yield* filesystemEffect(() => isSourceDestination(source, destinationPath)).pipe(Effect.mapError(toExportDestinationError));
      if (conflicts) {
        yield* Effect.promise(() => this.prompts.showSourceConflict());
        continue;
      }
      const published = yield* filesystemEffect(() => publishExport(source, destinationPath, request.contents, this.writeExport)).pipe(Effect.mapError(toExportDestinationError));
      if (!published) {
        yield* Effect.promise(() => this.prompts.showSourceConflict());
        continue;
      }
      return { status: 'delivered' } satisfies CsvExportDelivery;
    }
  });

  readonly recentSources = Effect.fnUntraced(function* (this: DesktopWorkspaceHost) {
    // Writers truncate before replacing the JSON, so readers share their lock.
    const entries = yield* this.recentEntriesLock.withPermit(this.readRecentEntries());
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

  readonly recordRecentSource = Effect.fnUntraced(function* (this: DesktopWorkspaceHost, sourceId: CsvSourceId) {
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

  confirmDiscardChanges(sourceName: string) {
    return Effect.promise(() => this.prompts.confirmDiscardChanges(sourceName));
  }

  private requireSource(sourceId: CsvSourceId) {
    return Effect.suspend(() => {
      const source = this.sources.get(sourceId);
      return source ? Effect.succeed(source) : Effect.fail(new CsvSourceUnavailableError({ code: 'missing-source', message: 'The CSV Source is not available.' }));
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

  private readonly modifyRecentEntries = Effect.fnUntraced(function* (this: DesktopWorkspaceHost, update: (entries: RecentSourceEntry[]) => RecentSourceEntry[]) {
    const entries = yield* this.readRecentEntries();
    const next = update(entries);
    if (next.length === entries.length && next.every((entry, index) => entry === entries[index])) return entries;
    yield* this.writeRecentEntries(next);
    return next;
  }, this.recentEntriesLock.withPermit, Effect.uninterruptible);

  private readonly writeRecentEntries = Effect.fnUntraced(function* (this: DesktopWorkspaceHost, entries: RecentSourceEntry[]) {
    yield* filesystemEffect(() => mkdir(path.dirname(this.recentSourcesPath), { recursive: true }));
    yield* filesystemEffect(() => writeFile(this.recentSourcesPath, JSON.stringify(entries, null, 2), 'utf8'));
  }, Effect.catch((cause) => Effect.sync(() => warnRecentSourceFailure('write', recentSourceFailureCategory(cause)))));

  private readRecentEntries() {
    return filesystemEffect(() => readFile(this.recentSourcesPath, 'utf8')).pipe(
      Effect.map((contents) => {
        const parsed = decodeRecentSourceList(contents);
        if (Option.isNone(parsed)) {
          warnRecentSourceFailure('read', 'invalid-format');
          return [];
        }
        return parsed.value.filter(isRecentSourceEntry).slice(0, maxRecentSources);
      }),
      Effect.catch((cause) => Effect.sync(() => {
        if (cause.code !== 'ENOENT') warnRecentSourceFailure('read', recentSourceFailureCategory(cause));
        return [];
      })),
    );
  }
}

const RecentSourceEntry = Schema.Struct({
  path: Schema.String,
  name: Schema.String,
  sizeBytes: Schema.Number,
  lastOpenedAt: Schema.String,
});
type RecentSourceEntry = typeof RecentSourceEntry.Type;
const isRecentSourceEntry = Schema.is(RecentSourceEntry);
// Decode the list first so an invalid entry does not discard its valid neighbours.
const decodeRecentSourceList = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.Unknown)));

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

async function isSourceDestination(source: RegisteredSource, destinationPath: string): Promise<boolean> {
  if (normalizeCanonicalPath(path.resolve(destinationPath)) === normalizeCanonicalPath(path.resolve(source.filePath))) return true;
  const destination = await captureFileIdentity(destinationPath);
  return source.identity !== null && destination !== null && sameFileIdentity(source.identity, destination);
}

/** Publish in one rename after a complete write; failures preserve any existing destination. */
async function publishExport(source: RegisteredSource, destinationPath: string, contents: string, write: DesktopExportWriter): Promise<boolean> {
  const temporaryPath = path.join(path.dirname(destinationPath), `.csv-viewer-${crypto.randomUUID()}.tmp`);
  try {
    await write(temporaryPath, contents);
    if (await isSourceDestination(source, destinationPath)) return false;
    await rename(temporaryPath, destinationPath);
    return true;
  } finally {
    await removeStagedExport(temporaryPath);
  }
}

async function removeStagedExport(temporaryPath: string): Promise<void> {
  try { await unlink(temporaryPath); }
  catch (cause) { if (!isFileSystemError(cause) || cause.code !== 'ENOENT') throw cause; }
}

function toSourceUnavailableError(cause: NodeJS.ErrnoException): CsvSourceUnavailableError {
  if (cause.code === 'ENOENT') {
    return new CsvSourceUnavailableError({ code: 'missing-source', message: 'The CSV Source no longer exists.' });
  }
  if (cause.code === 'EACCES' || cause.code === 'EPERM') {
    return new CsvSourceUnavailableError({ code: 'permission-denied', message: 'Permission was denied for the CSV Source.' });
  }
  return new CsvSourceUnavailableError({ code: 'unreadable', message: 'The CSV Source could not be read.' });
}

function toExportDestinationError(cause: NodeJS.ErrnoException): CsvSourceUnavailableError {
  if (cause.code === 'ENOENT') {
    return new CsvSourceUnavailableError({ code: 'missing-source', message: 'The export destination no longer exists.' });
  }
  if (cause.code === 'EACCES' || cause.code === 'EPERM') {
    return new CsvSourceUnavailableError({ code: 'permission-denied', message: 'Permission was denied for the export destination.' });
  }
  return new CsvSourceUnavailableError({ code: 'unreadable', message: 'The export destination could not be accessed.' });
}

/** Only Node filesystem errors are expected at this platform boundary; other exceptions are defects. */
function filesystemEffect<A>(operation: () => Promise<A>): Effect.Effect<A, NodeJS.ErrnoException> {
  return Effect.tryPromise({ try: operation, catch: (cause) => cause }).pipe(
    Effect.catch((cause) => isFileSystemError(cause) ? Effect.fail(cause) : Effect.die(cause)),
  );
}
