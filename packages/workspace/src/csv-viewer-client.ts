import { Context, Effect, Exit, Fiber, Layer, Option, Schema, Scheduler, Scope, Stream } from 'effect';
import { Rpc, RpcClient, RpcGroup, RpcServer, RpcTest } from 'effect/rpc';
import type { RpcClientError } from 'effect/rpc/RpcClientError';
import type {
  CsvSourceId,
  CsvViewer,
  CsvViewerCapabilities,
  CsvViewerEvent,
  CsvViewerRequest,
  CsvViewerResult,
} from './csv-viewer';
import { CsvViewerRequest as CsvViewerRequestSchema } from './csv-viewer-requests';
import { CsvViewerRpcs } from './csv-viewer-rpcs';
import { browserMessagePort, messagePortClientLayer, type CsvViewerMessagePort } from './csv-viewer-message-port';
import {
  genericWorkspaceFailure,
  isExpectedWorkspaceError,
} from './errors';
import type { CsvViewerSession, CsvWorkspaceServer } from './csv-workspace';

const decodeRequest = Schema.decodeUnknownOption(CsvViewerRequestSchema);

type CsvViewerRpcClient = RpcClient.RpcClient<RpcGroup.Rpcs<typeof CsvViewerRpcs>, RpcClientError>;

export interface CsvViewerHandlerHost {
  readonly capabilities: CsvViewerCapabilities;
  readonly handlerContext: Context.Context<Rpc.ToHandler<RpcGroup.Rpcs<typeof CsvViewerRpcs>>>;
}

/**
 * Runs one client effect and keeps declared failures intact. A defect, including one that only
 * looks like a declared failure, becomes the generic message.
 */
export function runWorkspaceRequest<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(Effect.exit(effect)).then((exit) => {
    if (Exit.isSuccess(exit)) return exit.value;
    const [reason] = exit.cause.reasons;
    if (exit.cause.reasons.length === 1 && reason && reason._tag === 'Fail' && isExpectedWorkspaceError(reason.error)) {
      throw reason.error;
    }
    throw new Error(genericWorkspaceFailure);
  });
}

/**
 * The one Promise surface RendererWorkspace, CsvTab, and ComparisonTab already call.
 * React stays on that surface; interruption belongs to the fiber that runs the client.
 */
export function csvViewerFromRpcClient(client: CsvViewerRpcClient, capabilities: CsvViewerCapabilities): CsvViewer {
  const call = <Request extends CsvViewerRequest>(request: Request): Promise<CsvViewerResult<Request>> => {
    // SAFETY: Schema success types are the runtime values CsvViewerResult names. Arrays are mutable.
    return dispatch(client, request) as Promise<CsvViewerResult<Request>>;
  };
  return { capabilities, call, onEvent: (listener) => subscribe(client, listener) };
}

export interface ConnectedCsvViewer extends CsvViewer {
  acquireDroppedPath(path: string): Promise<CsvSourceId>;
  close(): Promise<void>;
}

export function connectRpcTestClient(host: CsvViewerHandlerHost): Promise<ConnectedCsvViewer> {
  return connect(host.capabilities, (scope) => RpcTest.makeClient(CsvViewerRpcs).pipe(
    Effect.provideContext(host.handlerContext),
    Scope.provide(scope),
  ));
}

/** Page and unit tests call this object. Disposal finishes admitted work, then closes the client. */
export async function connectInProcessSession(server: CsvWorkspaceServer): Promise<CsvViewerSession> {
  const client = await connectInProcessClient(server);
  return {
    capabilities: client.capabilities,
    call: (request) => client.call(request),
    onEvent: (listener) => client.onEvent(listener),
    confirmClose: (impact) => server.confirmClose(impact),
    dispose: async () => {
      try {
        await server.dispose();
      } finally {
        await client.close();
      }
    },
  };
}

export function connectInProcessClient(host: CsvViewerHandlerHost): Promise<ConnectedCsvViewer> {
  return connect(host.capabilities, (scope) => inProcessClient(host).pipe(Scope.provide(scope)));
}

export function connectMessagePortClient(
  port: CsvViewerMessagePort,
  capabilities: CsvViewerCapabilities,
): Promise<ConnectedCsvViewer> {
  return connect(capabilities, (scope) => Effect.gen(function* () {
    const protocol = yield* Layer.build(messagePortClientLayer(port));
    return yield* RpcClient.make(CsvViewerRpcs).pipe(Effect.provideContext(protocol));
  }).pipe(Scope.provide(scope)));
}

export function connectBrowserMessagePort(
  port: Pick<MessagePort, 'postMessage' | 'start' | 'close'>,
  capabilities: CsvViewerCapabilities,
): Promise<ConnectedCsvViewer> {
  // SAFETY: The page MessagePort delivers each posted envelope through onmessage.
  return connectMessagePortClient(browserMessagePort(port as Parameters<typeof browserMessagePort>[0]), capabilities);
}

function connect(
  capabilities: CsvViewerCapabilities,
  open: (scope: Scope.Scope) => Effect.Effect<CsvViewerRpcClient, never, never>,
): Promise<ConnectedCsvViewer> {
  return Effect.runPromise(Effect.gen(function* () {
    const scope = yield* Scope.make();
    const client = yield* open(scope);
    const viewer = csvViewerFromRpcClient(client, capabilities);
    return {
      ...viewer,
      acquireDroppedPath: (path: string) => runWorkspaceRequest(client['csv.acquire-dropped-source']({ path })),
      close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
    };
  }));
}

const inProcessClient = Effect.fnUntraced(function* (host: CsvViewerHandlerHost) {
  let client!: Effect.Success<ReturnType<typeof RpcClient.makeNoSerialization<RpcGroup.Rpcs<typeof CsvViewerRpcs>, never, false>>>;
  const server = yield* RpcServer.makeNoSerialization(CsvViewerRpcs, {
    onFromServer: (response) => client.write(response),
  }).pipe(Effect.provideContext(host.handlerContext));
  client = yield* RpcClient.makeNoSerialization(CsvViewerRpcs, {
    supportsAck: true,
    onFromClient: ({ message }) => server.write(0, message),
  });
  // SAFETY: The in-process client has no transport error. Declared failures are the same set.
  return client.client as CsvViewerRpcClient;
});

/**
 * Queue wakeups run before `scheduleTask` returns, so an event emitted inside a call reaches
 * `onEvent` before that call's promise resolves. One dispatcher is shared by every events fiber.
 */
class WorkspaceEventDispatcher implements Scheduler.SchedulerDispatcher {
  private readonly tasks: Array<() => void> = [];
  private running = false;

  scheduleTask(task: () => void, _priority: number): void {
    this.tasks.push(task);
    this.flush();
  }

  flush(): void {
    if (this.running) return;
    this.running = true;
    try {
      while (this.tasks.length > 0) {
        const task = this.tasks.shift();
        task?.();
      }
    } finally {
      this.running = false;
    }
  }
}

class WorkspaceEventScheduler implements Scheduler.Scheduler {
  readonly executionMode = 'async' as const;
  private readonly dispatcher = new WorkspaceEventDispatcher();

  shouldYield(_fiber: Fiber.Fiber<unknown, unknown>): boolean {
    return false;
  }

  makeDispatcher(): Scheduler.SchedulerDispatcher {
    return this.dispatcher;
  }
}

const workspaceEventScheduler = new WorkspaceEventScheduler();

function subscribe(client: CsvViewerRpcClient, listener: (event: CsvViewerEvent) => void): () => void {
  const fiber = Effect.runFork(Stream.runForEach(client['workspace.events']({}), (event) => Effect.sync(() => {
    try {
      // SAFETY: The events RPC success schema is CsvViewerEvent.
      listener(event as CsvViewerEvent);
    } catch {
      // One subscriber cannot end the stream or copy its exception into diagnostics.
    }
  })), { scheduler: workspaceEventScheduler });
  workspaceEventScheduler.makeDispatcher().flush();
  return () => {
    Effect.runFork(Fiber.interrupt(fiber), { scheduler: workspaceEventScheduler });
  };
}

function delivered<A, E>(effect: Effect.Effect<A, E>): Promise<CsvViewerResult<CsvViewerRequest>> {
  // SAFETY: Schema success types are the runtime values CsvViewerResult names. Arrays are mutable.
  return runWorkspaceRequest(effect) as Promise<CsvViewerResult<CsvViewerRequest>>;
}

function dispatch(client: CsvViewerRpcClient, request: CsvViewerRequest): Promise<CsvViewerResult<CsvViewerRequest>> {
  const decoded = decodeRequest(request);
  if (Option.isNone(decoded)) {
    return delivered(client['csvViewer.malformed']({})).then(() => {
      throw new Error(genericWorkspaceFailure);
    });
  }
  const value = decoded.value;
  switch (value.operation) {
    case 'csv.open':
      return delivered(client['csv.open']({ sourceId: value.sourceId, options: value.options }));
    case 'csv.open-recent':
      return delivered(client['csv.open-recent']({ sourceId: value.sourceId, options: value.options }));
    case 'csv.reopen':
      return delivered(client['csv.reopen']({ workingCsvId: value.workingCsvId, options: value.options }));
    case 'csv.get-recent-sources':
      return delivered(client['csv.get-recent-sources']({}));
    case 'csv.get-rows':
      return delivered(client['csv.get-rows'](withoutOperation(value)));
    case 'csv.get-column-values':
      return delivered(client['csv.get-column-values'](withoutOperation(value)));
    case 'csv.get-column-value-counts':
      return delivered(client['csv.get-column-value-counts'](withoutOperation(value)));
    case 'csv.edit-cell':
      return delivered(client['csv.edit-cell'](withoutOperation(value)));
    case 'csv.delete-rows':
      return delivered(client['csv.delete-rows'](withoutOperation(value)));
    case 'csv.insert-row':
      return delivered(client['csv.insert-row'](withoutOperation(value)));
    case 'csv.rename-column':
      return delivered(client['csv.rename-column'](withoutOperation(value)));
    case 'csv.insert-column':
      return delivered(client['csv.insert-column'](withoutOperation(value)));
    case 'csv.delete-column':
      return delivered(client['csv.delete-column'](withoutOperation(value)));
    case 'csv.reorder-columns':
      return delivered(client['csv.reorder-columns'](withoutOperation(value)));
    default:
      return dispatchEdit(client, value);
  }
}

function dispatchEdit(
  client: CsvViewerRpcClient,
  value: Extract<CsvViewerRequest, { operation: 'csv.get-edit-state' | 'csv.undo' | 'csv.redo' | 'csv.export' | 'csv.export-view' | 'csv.close' | `comparison.${string}` }>,
): Promise<CsvViewerResult<CsvViewerRequest>> {
  switch (value.operation) {
    case 'csv.get-edit-state':
      return delivered(client['csv.get-edit-state'](withoutOperation(value)));
    case 'csv.undo':
      return delivered(client['csv.undo'](withoutOperation(value)));
    case 'csv.redo':
      return delivered(client['csv.redo'](withoutOperation(value)));
    case 'csv.export':
      return delivered(client['csv.export'](withoutOperation(value)));
    case 'csv.export-view':
      return delivered(client['csv.export-view'](withoutOperation(value)));
    case 'csv.close':
      return delivered(client['csv.close'](withoutOperation(value)));
    default:
      return dispatchComparison(client, value);
  }
}

function dispatchComparison(
  client: CsvViewerRpcClient,
  value: Extract<CsvViewerRequest, { operation: `comparison.${string}` }>,
): Promise<CsvViewerResult<CsvViewerRequest>> {
  switch (value.operation) {
    case 'comparison.get-candidates':
      return delivered(client['comparison.get-candidates']({ baselineId: value.baselineId }));
    case 'comparison.open':
      return delivered(client['comparison.open'](withoutOperation(value)));
    case 'comparison.begin':
      return value.kind === 'apply-key'
        ? delivered(client['comparison.begin']({ kind: 'apply-key', comparisonId: value.comparisonId, key: [...value.key] }))
        : delivered(client['comparison.begin']({ kind: 'refresh', comparisonId: value.comparisonId }));
    case 'comparison.cancel':
      return delivered(client['comparison.cancel'](withoutOperation(value)));
    case 'comparison.get-window':
      return delivered(client['comparison.get-window'](withoutOperation(value)));
    case 'comparison.swap':
      return delivered(client['comparison.swap']({ comparisonId: value.comparisonId }));
    case 'comparison.close':
      return delivered(client['comparison.close']({ comparisonId: value.comparisonId }));
    default: {
      const exhaustive: never = value;
      return exhaustive;
    }
  }
}

function withoutOperation<Request extends { operation: string }>(request: Request): Omit<Request, 'operation'> {
  const { operation: _operation, ...payload } = request;
  return payload;
}
