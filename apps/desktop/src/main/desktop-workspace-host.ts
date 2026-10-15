import { Effect, Layer, Option, Schema, Semaphore } from 'effect';
import { mkdir, readFile, stat, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { WorkspaceRequestError } from '@csv-viewer/workspace/errors';
import { scopedEngineSource } from '@csv-viewer/workspace/engine-source';
import { SourceTable, sourceDescription } from '@csv-viewer/workspace/source-table';
import { electronCsvViewerCapabilities } from '../electron-csv-viewer-capabilities';
import type { CsvSourceId } from '@csv-viewer/workspace/csv-viewer';
import {
  buildWorkspaceHost,
  CsvSourceUnavailableError,
  ExportSink,
  Prompts,
  RecentSources,
  SourceRegistry,
  workspaceHostLayer,
  type CsvExportDelivery,
  type CsvExportRequestForDelivery,
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

type RegisteredFile = {
  filePath: string;
  identity: CanonicalFileIdentity | null;
};

export type DesktopWorkspaceSession = CsvWorkspaceHost & {
  registerSource(filePath: string): Effect.Effect<CsvSourceId, CsvSourceUnavailableError>;
  acquireDroppedSource(filePath: string): Effect.Effect<CsvSourceId, WorkspaceRequestError | CsvSourceUnavailableError>;
};

export function openDesktopWorkspace(
  prompts: DesktopWorkspacePrompts,
  recentSourcesPath: string,
  writeExport: DesktopExportWriter = writeExportContents,
): DesktopWorkspaceSession {
  const sources = new SourceTable<RegisteredFile>();
  const recentEntriesLock = Semaphore.makeUnsafe(1);
  const unavailable = () => new CsvSourceUnavailableError({ code: 'missing-source', message: 'The CSV Source is not available.' });

  const registerSource = (filePath: string) => filesystemEffect(() => captureFileIdentity(filePath)).pipe(
    Effect.mapError(toSourceUnavailableError),
    Effect.map((identity) => sources.reserve({ filePath, identity }, sameRegisteredFile, mergeRegisteredFile)),
  );

  const requireSource = (sourceId: CsvSourceId) => sources.require(sourceId, unavailable());

  const classifyRecentPath = (filePath: string) => filesystemEffect(() => stat(filePath)).pipe(
    Effect.map((fileStats) => fileStats.isFile() ? 'file' as const : 'gone' as const),
    Effect.catch((cause) => {
      if (cause.code === 'ENOENT' || cause.code === 'ENOTDIR') return Effect.succeed('gone' as const);
      if (cause.code === 'EACCES' || cause.code === 'EPERM') return Effect.succeed('inaccessible' as const);
      return Effect.fail(toSourceUnavailableError(cause));
    }),
  );

  const readRecentEntries = () => filesystemEffect(() => readFile(recentSourcesPath, 'utf8')).pipe(
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

  const writeRecentEntries = (entries: RecentSourceEntry[]) => filesystemEffect(() => mkdir(path.dirname(recentSourcesPath), { recursive: true })).pipe(
    Effect.andThen(filesystemEffect(() => writeFile(recentSourcesPath, JSON.stringify(entries, null, 2), 'utf8'))),
    Effect.catch((cause) => Effect.sync(() => warnRecentSourceFailure('write', recentSourceFailureCategory(cause)))),
  );

  const modifyRecentEntries = (update: (entries: RecentSourceEntry[]) => RecentSourceEntry[]) => Effect.uninterruptible(
    recentEntriesLock.withPermit(Effect.gen(function* () {
      const entries = yield* readRecentEntries();
      const next = update(entries);
      if (next.length === entries.length && next.every((entry, index) => entry === entries[index])) return entries;
      yield* writeRecentEntries(next);
      return next;
    })),
  );

  const forgetRecentPath = (filePath: string) => {
    const resolvedPath = path.resolve(filePath);
    return modifyRecentEntries((entries) => entries.filter((entry) => path.resolve(entry.path) !== resolvedPath));
  };

  const sourceRegistry: SourceRegistry = {
    acquireSource: () => promptEffect(() => prompts.chooseSource()).pipe(
      Effect.flatMap((filePath) => filePath ? registerSource(filePath) : Effect.succeed(null)),
    ),
    releaseSource() {},
    describeSource: Effect.fnUntraced(function* (sourceId: CsvSourceId) {
      const { filePath } = yield* requireSource(sourceId);
      const fileStats = yield* filesystemEffect(() => stat(filePath)).pipe(
        Effect.tapError((cause) => cause.code === 'ENOENT' ? forgetRecentPath(filePath) : Effect.void),
        Effect.mapError(toSourceUnavailableError),
      );
      if (!fileStats.isFile()) {
        yield* forgetRecentPath(filePath);
        return yield* Effect.fail(new CsvSourceUnavailableError({ code: 'unreadable', message: 'Selected path is not a file.' }));
      }
      return sourceDescription(sourceId, path.basename(filePath), filePath, fileStats.size);
    }),
    acquireEngineSource: (sourceId) => scopedEngineSource(
      requireSource(sourceId).pipe(Effect.map((source) => source.filePath)),
      () => Effect.void,
    ),
  };

  const exportSink: ExportSink = {
    deliverExport: Effect.fnUntraced(function* (request: CsvExportRequestForDelivery) {
      const source = yield* requireSource(request.sourceId);
      const defaultPath = path.join(path.dirname(source.filePath), request.kind === 'view' ? request.suggestedName : buildDefaultExportName(request.suggestedName));
      while (true) {
        const destinationPath = yield* promptEffect(() => prompts.chooseExportDestination(defaultPath));
        if (!destinationPath) return { status: 'cancelled' } satisfies CsvExportDelivery;
        const conflicts = yield* filesystemEffect(() => isSourceDestination(source, destinationPath)).pipe(Effect.mapError(toExportDestinationError));
        if (conflicts) {
          yield* promptEffect(() => prompts.showSourceConflict());
          continue;
        }
        const published = yield* filesystemEffect(() => publishExport(source, destinationPath, request.contents, writeExport)).pipe(Effect.mapError(toExportDestinationError));
        if (!published) {
          yield* promptEffect(() => prompts.showSourceConflict());
          continue;
        }
        return { status: 'delivered' } satisfies CsvExportDelivery;
      }
    }),
  };

  const recentSources: RecentSources = {
    recentSources: Effect.fnUntraced(function* () {
      const entries = yield* recentEntriesLock.withPermit(readRecentEntries());
      const gone = new Set<string>();
      const hidden = new Set<string>();
      for (const entry of entries) {
        const resolvedPath = path.resolve(entry.path);
        const state = yield* classifyRecentPath(entry.path);
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
        : yield* modifyRecentEntries((latest) => latest.filter((entry) => !gone.has(path.resolve(entry.path))));
      const available = current.filter((entry) => {
        const resolvedPath = path.resolve(entry.path);
        return !gone.has(resolvedPath) && !hidden.has(resolvedPath);
      });
      return yield* Effect.forEach(available, (entry) => registerSource(entry.path).pipe(
        Effect.map((sourceId) => ({
          sourceId,
          name: entry.name,
          location: entry.path,
          sizeBytes: entry.sizeBytes,
          lastOpenedAt: entry.lastOpenedAt,
        })),
      ), { concurrency: 'unbounded' });
    }),
    recordRecentSource: Effect.fnUntraced(function* (sourceId: CsvSourceId) {
      const source = sources.get(sourceId);
      if (!source) return;
      const normalizedPath = path.resolve(source.filePath);
      const fileStats = yield* filesystemEffect(() => stat(normalizedPath)).pipe(Effect.catch(() => Effect.succeed(null)));
      const nextEntry: RecentSourceEntry = {
        path: normalizedPath,
        name: path.basename(normalizedPath),
        sizeBytes: fileStats?.size ?? 0,
        lastOpenedAt: new Date().toISOString(),
      };
      yield* modifyRecentEntries((entries) =>
        [nextEntry, ...entries.filter((entry) => path.resolve(entry.path) !== normalizedPath)].slice(0, maxRecentSources),
      );
    }),
  };

  const promptService: Prompts = {
    confirmDiscardChanges: (sourceName) => promptEffect(() => prompts.confirmDiscardChanges(sourceName)),
  };

  const acquireDroppedSource = Effect.fnUntraced(function* (filePath: string) {
    if (!/\.(csv|tsv|txt)$/i.test(filePath)) {
      return yield* Effect.fail(new WorkspaceRequestError({ message: 'Only CSV, TSV, and TXT files can be dropped.' }));
    }
    const fileStats = yield* filesystemEffect(() => stat(filePath)).pipe(Effect.mapError(toSourceUnavailableError));
    if (!fileStats.isFile()) {
      return yield* Effect.fail(new WorkspaceRequestError({ message: 'Folders cannot be opened. Drop CSV, TSV, or TXT files.' }));
    }
    return yield* registerSource(filePath);
  });

  const host = buildWorkspaceHost(workspaceHostLayer(electronCsvViewerCapabilities).pipe(
    Layer.provide(Layer.mergeAll(
      Layer.succeed(SourceRegistry, sourceRegistry),
      Layer.succeed(ExportSink, exportSink),
      Layer.succeed(RecentSources, recentSources),
      Layer.succeed(Prompts, promptService),
    )),
  ));
  return Object.assign(host, { registerSource, acquireDroppedSource });
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

/** Inode equality outranks a path so a null path row cannot hide a hard link of the same file. */
function sameRegisteredFile(existing: RegisteredFile, incoming: RegisteredFile): number {
  const sameInode = existing.identity !== null
    && incoming.identity !== null
    && sameFileIdentity(existing.identity, incoming.identity);
  if (sameInode) return 2;
  const samePath = normalizeCanonicalPath(path.resolve(existing.filePath)) === normalizeCanonicalPath(path.resolve(incoming.filePath));
  return samePath ? 1 : 0;
}

/** A missed capture is null and must not erase an inode already stored for this file. */
function mergeRegisteredFile(existing: RegisteredFile, incoming: RegisteredFile): RegisteredFile {
  return {
    filePath: incoming.filePath,
    identity: incoming.identity ?? existing.identity,
  };
}

function buildDefaultExportName(sourceName: string): string {
  const parsed = path.parse(sourceName);
  return `${parsed.name}-edited${parsed.ext || '.csv'}`;
}

async function isSourceDestination(source: RegisteredFile, destinationPath: string): Promise<boolean> {
  if (normalizeCanonicalPath(path.resolve(destinationPath)) === normalizeCanonicalPath(path.resolve(source.filePath))) return true;
  const destination = await captureFileIdentity(destinationPath);
  return source.identity !== null && destination !== null && sameFileIdentity(source.identity, destination);
}

/** Publish in one rename after a complete write; failures preserve any existing destination. */
async function publishExport(source: RegisteredFile, destinationPath: string, contents: string, write: DesktopExportWriter): Promise<boolean> {
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

/** A native dialog that cannot be shown rejects the request with a message the user can act on. */
function promptEffect<A>(prompt: () => Promise<A>): Effect.Effect<A, WorkspaceRequestError> {
  return Effect.tryPromise({
    try: prompt,
    catch: (cause) => new WorkspaceRequestError({ message: 'CSV Viewer could not show the dialog. Try again.', cause }),
  });
}

/** Only Node filesystem errors are expected at this platform boundary; other exceptions are defects. */
function filesystemEffect<A>(operation: () => Promise<A>): Effect.Effect<A, NodeJS.ErrnoException> {
  return Effect.tryPromise({ try: operation, catch: (cause) => cause }).pipe(
    Effect.catch((cause) => isFileSystemError(cause) ? Effect.fail(cause) : Effect.die(cause)),
  );
}
