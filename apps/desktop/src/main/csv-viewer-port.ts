import { MessageChannelMain, type MessagePortMain, type WebContents } from 'electron';
import { Effect, Exit, Layer, Scope } from 'effect';
import { RpcServer } from 'effect/rpc';
import type { CsvWorkspaceServer } from '@csv-viewer/workspace/csv-workspace';
import { CsvViewerRpcs } from '@csv-viewer/workspace/csv-viewer-rpcs';
import { messagePortServerLayer, type CsvViewerMessagePort } from '@csv-viewer/workspace/csv-viewer-message-port';

function mainMessagePort(port: MessagePortMain): CsvViewerMessagePort {
  return {
    postMessage: (message) => port.postMessage(message),
    onMessage: (listener) => {
      port.on('message', (event) => listener(event.data));
    },
    start: () => port.start(),
    close: () => port.close(),
  };
}

/** One MessagePort for the document that owns this workspace. Transfer it once, after the page has loaded. */
export async function serveWorkspacePort(webContents: WebContents, workspace: CsvWorkspaceServer): Promise<() => Promise<void>> {
  const { port1, port2 } = new MessageChannelMain();
  const scope = await Effect.runPromise(Scope.make());
  await Effect.runPromise(Layer.buildWithScope(
    RpcServer.layer(CsvViewerRpcs, { disableFatalDefects: true }).pipe(
      Layer.provide(messagePortServerLayer(mainMessagePort(port1))),
      Layer.provide(Layer.succeedContext(workspace.handlerContext)),
    ),
    scope,
  ));
  let posted = false;
  const post = () => {
    if (posted || webContents.isDestroyed()) return;
    posted = true;
    webContents.postMessage('csv-viewer-port', { type: 'csv-viewer-port' }, [port2]);
  };
  // isLoading() stays true while this event runs, so the handler posts unconditionally.
  webContents.on('did-finish-load', post);
  if (!webContents.isLoading()) post();
  return async () => {
    if (!webContents.isDestroyed()) webContents.removeListener('did-finish-load', post);
    await Effect.runPromise(Scope.close(scope, Exit.void));
  };
}
