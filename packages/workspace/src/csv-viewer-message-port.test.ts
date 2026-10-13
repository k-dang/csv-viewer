import { describe, expect, it } from 'vitest';
import type { FromServerEncoded } from 'effect/rpc/RpcMessage';
import { releaseFinishedRequest } from './csv-viewer-message-port';

describe('message port request routes', () => {
  it('keeps a request route through stream chunks and drops it when the Exit arrives', () => {
    const requestClient = new Map<string | number, number>();
    requestClient.set('grid', 4);
    requestClient.set('events', 4);
    const chunk: FromServerEncoded = { _tag: 'Chunk', requestId: 'grid', values: [1] };
    const exit: FromServerEncoded = { _tag: 'Exit', requestId: 'grid', exit: { _tag: 'Success', value: 1 } };
    const defect: FromServerEncoded = { _tag: 'Defect', defect: { name: 'Error', message: 'hidden' } };

    releaseFinishedRequest(requestClient, chunk);
    expect(requestClient.get('grid')).toBe(4);

    releaseFinishedRequest(requestClient, exit);
    releaseFinishedRequest(requestClient, defect);

    expect(requestClient.has('grid')).toBe(false);
    expect(requestClient.get('events')).toBe(4);
  });
});
