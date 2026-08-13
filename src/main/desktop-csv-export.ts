import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

type ChooseCsvExportDestinationOptions = {
  chooseDestination: () => Promise<string | null>;
  isSourceDestination: (destinationPath: string) => Promise<boolean>;
  showSourceConflict: () => Promise<void>;
};

export type CanonicalFileIdentity = {
  canonicalPath: string;
  device: bigint;
  inode: bigint;
};

export async function chooseCsvExportDestination({
  chooseDestination,
  isSourceDestination,
  showSourceConflict,
}: ChooseCsvExportDestinationOptions): Promise<string | null> {
  while (true) {
    const destinationPath = await chooseDestination();
    if (!destinationPath) return null;
    if (!(await isSourceDestination(destinationPath))) return destinationPath;
    await showSourceConflict();
  }
}

export async function captureFileIdentity(filePath: string): Promise<CanonicalFileIdentity | null> {
  try {
    const [canonicalPath, fileStats] = await Promise.all([
      realpath(filePath),
      stat(filePath, { bigint: true }),
    ]);
    return { canonicalPath, device: fileStats.dev, inode: fileStats.ino };
  } catch (error: unknown) {
    if (isFileSystemError(error) && error.code === 'ENOENT') return null;
    throw error;
  }
}

export function sameFileIdentity(
  first: CanonicalFileIdentity,
  second: CanonicalFileIdentity,
): boolean {
  return (
    normalizeCanonicalPath(first.canonicalPath) === normalizeCanonicalPath(second.canonicalPath) ||
    (first.inode !== 0n && first.device === second.device && first.inode === second.inode)
  );
}

function normalizeCanonicalPath(filePath: string): string {
  const normalized = path.normalize(filePath);
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function isFileSystemError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
