import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  workspaceContractFactories,
  type WorkspaceContractFixture,
} from '../test-helpers/workspace-contract';

describe.each(workspaceContractFactories)('$name CsvViewer request seam', ({ create }) => {
  let fixture: WorkspaceContractFixture;

  beforeEach(async () => {
    fixture = await create();
  });

  afterEach(async () => {
    await fixture.dispose();
  });

  it('does not expose workspace ownership through product requests', async () => {
    // SAFETY: This intentionally sends an operation outside the public union to test rejection.
    await expect(fixture.viewer.call({ operation: 'workspace.dispose' } as never)).rejects.toThrow(
      'Unsupported CSV Viewer operation: workspace.dispose',
    );
  });
});
