import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  WorkspaceContractFactory,
  WorkspaceContractFixture,
} from './workspace-contract';

export function defineCsvViewerRequestContract(
  factory: WorkspaceContractFactory,
): void {
  describe(`${factory.name} CsvViewer request seam`, () => {
    let fixture: WorkspaceContractFixture;

    beforeEach(async () => {
      fixture = await factory.create();
    });

    afterEach(async () => {
      await fixture.dispose();
    });

    it('does not expose workspace ownership through product requests', async () => {
      // SAFETY: This intentionally sends an operation outside the public union to test rejection.
      await expect(
        fixture.viewer.call({ operation: 'workspace.dispose' } as never),
      ).rejects.toThrow('Unsupported CSV Viewer operation: workspace.dispose');
    });
  });
}
