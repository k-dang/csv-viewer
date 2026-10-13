import path from 'node:path';
import { Effect } from 'effect';
import { WorkspaceRequestError } from '@csv-viewer/workspace/errors';

/**
 * Paths the isolated preload derived with `webUtils.getPathForFile`.
 * `csv.acquire-dropped-source` still carries a string from the page. Main opens
 * one only when this preload IPC recorded that exact string, and only once.
 */
export class DroppedPathAuthorization {
  private readonly grants = new Map<string, number>();

  authorize(filePath: string): boolean {
    if (!path.isAbsolute(filePath)) return false;
    this.grants.set(filePath, (this.grants.get(filePath) ?? 0) + 1);
    return true;
  }

  redeem(filePath: string): boolean {
    const grants = this.grants.get(filePath);
    if (grants === undefined) return false;
    if (grants === 1) this.grants.delete(filePath);
    else this.grants.set(filePath, grants - 1);
    return true;
  }

  clear(): void {
    this.grants.clear();
  }
}

/** Records a path for the document webContents. Any other sender is ignored. */
export function recordDroppedPathFromPreload(
  authorization: DroppedPathAuthorization,
  senderId: number,
  documentSenderId: number | undefined,
  filePath: string,
): boolean {
  if (documentSenderId === undefined || senderId !== documentSenderId) return false;
  return authorization.authorize(filePath);
}

export function openAuthorizedDroppedPath<A, E>(
  authorization: DroppedPathAuthorization,
  acquire: (filePath: string) => Effect.Effect<A, E>,
  filePath: string,
): Effect.Effect<A, E | WorkspaceRequestError> {
  if (!authorization.redeem(filePath)) {
    return Effect.fail(new WorkspaceRequestError({ message: 'Drop a file from your device.' }));
  }
  return acquire(filePath);
}
