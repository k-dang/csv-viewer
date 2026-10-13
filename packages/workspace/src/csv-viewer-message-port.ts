// The port carries already-encoded RPC envelopes. Callers are the RPC runtime and a hostile
// renderer, so this module routes and strips defect text instead of re-modeling every payload.
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-known-value-widening, anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion */
import { Effect, Exit, Layer, Option, Queue, Schema } from 'effect';
import { Rpc, RpcClient, RpcServer } from 'effect/rpc';
import type { FromClientEncoded, FromServerEncoded } from 'effect/rpc/RpcMessage';
import { genericWorkspaceFailure, malformedRequestMessage, WorkspaceRequestError } from './errors';
import { CsvViewerRpcs } from './csv-viewer-rpcs';

/** The slice of a MessagePort both Electron and the browser can implement. */
export interface CsvViewerMessagePort {
  postMessage(message: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
  onClose(listener: () => void): void;
  start(): void;
  close(): void;
}

const safeDefect = { name: 'Error', message: genericWorkspaceFailure };

/**
 * Node and worker MessagePorts pass the posted value to the `message` listener.
 * Electron's MessagePortMain passes an event whose `data` is that value.
 */
export function dataMessagePort(port: {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (data: unknown) => void): void;
  on(event: 'close', listener: () => void): void;
  start(): void;
  close(): void;
}): CsvViewerMessagePort {
  return {
    postMessage: (message) => port.postMessage(message),
    onMessage: (listener) => { port.on('message', listener); },
    onClose: (listener) => { port.on('close', listener); },
    start: () => port.start(),
    close: () => port.close(),
  };
}

export function browserMessagePort(port: {
  postMessage(message: unknown): void;
  start(): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
}): CsvViewerMessagePort {
  return {
    postMessage: (message) => port.postMessage(message),
    onMessage: (listener) => { port.onmessage = (event) => listener(event.data); },
    onClose: (listener) => { port.onclose = () => listener(); },
    start: () => port.start(),
    close: () => port.close(),
  };
}

const malformedExitByTag = new Map<string, unknown>();

function malformedExit(tag: string): unknown {
  const cached = malformedExitByTag.get(tag);
  if (cached) return cached;
  const rpc = CsvViewerRpcs.requests.get(tag) ?? CsvViewerRpcs.requests.get('csv.open');
  if (!rpc) return undefined;
  const encoded = Schema.encodeSync(Schema.toCodecJson(Rpc.exitSchema(rpc)))(Exit.fail(new WorkspaceRequestError({
    message: malformedRequestMessage,
  })));
  malformedExitByTag.set(tag, encoded);
  return encoded;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Replaces defect text before it can cross the port. Success payloads are left untouched. */
function sanitizeServerMessage(message: FromServerEncoded): FromServerEncoded {
  if (message._tag === 'Defect') return { _tag: 'Defect', defect: safeDefect };
  if (message._tag !== 'Exit') return message;
  return { ...message, exit: sanitizeExit(message.exit) } as FromServerEncoded;
}

function sanitizeExit(exit: unknown): unknown {
  if (!isRecord(exit) || exit._tag !== 'Failure') return exit;
  const cause = exit.cause;
  if (Array.isArray(cause)) return { ...exit, cause: cause.map(sanitizeReason) };
  if (isRecord(cause) && Array.isArray(cause.failures)) {
    return { ...exit, cause: { ...cause, failures: cause.failures.map(sanitizeReason) } };
  }
  return exit;
}

function sanitizeReason(reason: unknown): unknown {
  if (!isRecord(reason) || reason._tag !== 'Die') return reason;
  return { ...reason, defect: safeDefect };
}

/**
 * A payload that does not match its RPC schema becomes the fixed malformed error.
 * The schema issue text never leaves the process.
 */
function rejectMalformed(message: FromClientEncoded): FromServerEncoded | undefined {
  if (message._tag !== 'Request') return undefined;
  const rpc = CsvViewerRpcs.requests.get(message.tag);
  if (!rpc) {
    const exit = malformedExit('csv.open');
    return exit === undefined ? undefined : { _tag: 'Exit', requestId: message.id, exit } as FromServerEncoded;
  }
  const decoded = Schema.decodeUnknownExit(Schema.toCodecJson(rpc.payloadSchema))(message.payload);
  if (Exit.isSuccess(decoded)) return undefined;
  const exit = malformedExit(message.tag);
  return exit === undefined ? undefined : { _tag: 'Exit', requestId: message.id, exit } as FromServerEncoded;
}

export const makeMessagePortServerProtocol = (port: CsvViewerMessagePort) =>
  RpcServer.Protocol.make(Effect.fnUntraced(function* (writeRequest) {
    const disconnects = yield* Queue.unbounded<number>();
    const clientIds = new Set<number>([0]);
    // One renderer owns this port, so its client id is 0. RpcServer interrupts that client only when the queue receives the id.
    port.onClose(() => {
      Queue.offerUnsafe(disconnects, 0);
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => port.close()));
    port.onMessage((message) => {
      if (!isRecord(message) || typeof message._tag !== 'string') return;
      const clientMessage = message as unknown as FromClientEncoded;
      const rejected = rejectMalformed(clientMessage);
      if (rejected) {
        port.postMessage(rejected);
        return;
      }
      Effect.runFork(writeRequest(0, clientMessage));
    });
    port.start();
    return {
      disconnects,
      send: (_clientId: number, response: FromServerEncoded) => Effect.sync(() => {
        port.postMessage(sanitizeServerMessage(response));
      }),
      end: () => Effect.sync(() => port.close()),
      clientIds: Effect.sync(() => clientIds),
      initialMessage: Effect.succeed(Option.none()),
      supportsAck: true,
      supportsTransferables: false,
      supportsSpanPropagation: false,
      supportsNotifications: true,
      codecFor: Schema.toCodecJson as RpcServer.Protocol['Service']['codecFor'],
    };
  }));

export const messagePortServerLayer = (port: CsvViewerMessagePort) =>
  Layer.effect(RpcServer.Protocol)(makeMessagePortServerProtocol(port));

function requestIdOf(message: FromServerEncoded): string | number | undefined {
  if (message._tag === 'Exit' || message._tag === 'Chunk') return message.requestId;
  return undefined;
}

/** Exit is the terminal envelope for one request. Chunks keep the route until that Exit arrives. */
export function releaseFinishedRequest(
  requestClient: Map<string | number, number>,
  message: FromServerEncoded,
): void {
  switch (message._tag) {
    case 'Exit':
      requestClient.delete(message.requestId);
      return;
    case 'Chunk':
    case 'Defect':
    case 'Pong':
    case 'ClientProtocolError':
    case 'Request':
      return;
    default: {
      const unexpected: never = message;
      return unexpected;
    }
  }
}

export const makeMessagePortClientProtocol = (port: CsvViewerMessagePort) =>
  RpcClient.Protocol.make(Effect.fnUntraced(function* (writeResponse, clientIds) {
    const requestClient = new Map<string | number, number>();
    yield* Effect.addFinalizer(() => Effect.sync(() => port.close()));
    const deliver = (clientId: number, message: FromServerEncoded) => writeResponse(clientId, message);
    port.onMessage((message) => {
      if (!isRecord(message) || typeof message._tag !== 'string') return;
      const response = message as unknown as FromServerEncoded;
      const requestId = requestIdOf(response);
      const clientId = requestId === undefined ? undefined : requestClient.get(requestId);
      releaseFinishedRequest(requestClient, response);
      const targets = clientId === undefined ? clientIds : [clientId];
      Effect.runFork(Effect.forEach(targets, (id) => deliver(id, response), { discard: true }));
    });
    port.start();
    return {
      send: (clientId: number, request: FromClientEncoded) => Effect.sync(() => {
        if (request._tag === 'Request' || request._tag === 'Interrupt' || request._tag === 'Ack') {
          const id = request._tag === 'Request' ? request.id : request.requestId;
          requestClient.set(id, clientId);
        }
        port.postMessage(request);
      }),
      supportsAck: true,
      supportsTransferables: false,
      codecFor: Schema.toCodecJson as RpcClient.Protocol['Service']['codecFor'],
    };
  }));

export const messagePortClientLayer = (port: CsvViewerMessagePort) =>
  Layer.effect(RpcClient.Protocol)(makeMessagePortClientProtocol(port));
