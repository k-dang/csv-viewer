import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chooseCsvExportDestination } from './desktop-csv-export';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'csv-viewer-export-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('chooseCsvExportDestination', () => {
  it('rejects a destination with the CSV Source identity and re-prompts', async () => {
    const sourceAliasPath = path.join(tempDir, 'source-alias.csv');
    const outputPath = path.join(tempDir, 'output.csv');
    const chooseDestination = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce(sourceAliasPath)
      .mockResolvedValueOnce(outputPath);
    const showSourceConflict = vi.fn<() => Promise<void>>().mockResolvedValue();

    const isSourceDestination = vi
      .fn<(destinationPath: string) => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await expect(
      chooseCsvExportDestination({ chooseDestination, isSourceDestination, showSourceConflict }),
    ).resolves.toBe(outputPath);
    expect(chooseDestination).toHaveBeenCalledTimes(2);
    expect(isSourceDestination).toHaveBeenNthCalledWith(1, sourceAliasPath);
    expect(isSourceDestination).toHaveBeenNthCalledWith(2, outputPath);
    expect(showSourceConflict).toHaveBeenCalledOnce();
  });
});
