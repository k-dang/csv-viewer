import { Effect, Exit } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceRequestError } from '@csv-viewer/workspace/errors';
import {
  DroppedPathAuthorization,
  openAuthorizedDroppedPath,
  recordDroppedPathFromPreload,
} from './dropped-path-authorization';

const refused = new WorkspaceRequestError({ message: 'Drop a file from your device.' });

describe('dropped path authorization', () => {
  it('refuses a path the page invented and does not open it', async () => {
    const acquire = vi.fn(() => Effect.succeed('source'));
    const authorization = new DroppedPathAuthorization();

    const exit = await Effect.runPromiseExit(openAuthorizedDroppedPath(authorization, acquire, '/tmp/secret.csv'));

    expect(exit).toEqual(Exit.fail(refused));
    expect(acquire).not.toHaveBeenCalled();
  });

  it('opens a preload-recorded path once', async () => {
    const acquire = vi.fn(() => Effect.succeed('source'));
    const authorization = new DroppedPathAuthorization();
    expect(recordDroppedPathFromPreload(authorization, 4, 4, '/tmp/people.csv')).toBe(true);

    const opened = await Effect.runPromiseExit(openAuthorizedDroppedPath(authorization, acquire, '/tmp/people.csv'));
    const reused = await Effect.runPromiseExit(openAuthorizedDroppedPath(authorization, acquire, '/tmp/people.csv'));

    expect(opened).toEqual(Exit.succeed('source'));
    expect(acquire).toHaveBeenCalledExactlyOnceWith('/tmp/people.csv');
    expect(reused).toEqual(Exit.fail(refused));
  });

  it('ignores a relative path, another webContents, and a document that is not open', () => {
    const authorization = new DroppedPathAuthorization();

    expect(recordDroppedPathFromPreload(authorization, 4, 4, 'people.csv')).toBe(false);
    expect(recordDroppedPathFromPreload(authorization, 4, 9, '/tmp/people.csv')).toBe(false);
    expect(recordDroppedPathFromPreload(authorization, 4, undefined, '/tmp/people.csv')).toBe(false);
    expect(authorization.redeem('/tmp/people.csv')).toBe(false);
    expect(authorization.redeem('people.csv')).toBe(false);
  });

  it('drops unused grants when the document is replaced', () => {
    const authorization = new DroppedPathAuthorization();
    authorization.authorize('/tmp/people.csv');

    authorization.clear();

    expect(authorization.redeem('/tmp/people.csv')).toBe(false);
  });
});
