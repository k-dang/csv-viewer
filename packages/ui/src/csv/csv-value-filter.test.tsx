// @vitest-environment jsdom
import { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { CustomFilterProps } from 'ag-grid-react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CsvRow } from '@csv-viewer/workspace/csv-viewer';
import { workingCsvFixture } from '../test-helpers/csv-views';
import { createTestCsvViewer } from '../test-helpers/csv-viewer';
import { CsvTab } from './csv-tab';
import { CsvValueFilter, type CsvValueFilterParams } from './csv-value-filter';
import type { ValueFilterModel } from './value-filter-model';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('CsvValueFilter', () => {
  it('commits a typed search under StrictMode', async () => {
    vi.useFakeTimers();
    const onModelChange = vi.fn();
    const tab = new CsvTab(createTestCsvViewer(), workingCsvFixture({
      columns: [{ name: 'name', type: 'VARCHAR' }],
    }));
    // SAFETY: the popup reads column.getColId and ignores the rest of the grid filter params.
    const props = {
      model: null,
      onModelChange,
      onUiChange: () => undefined,
      column: { getColId: () => 'name' },
      tab,
    } as CustomFilterProps<CsvRow, unknown, ValueFilterModel> & CsvValueFilterParams;

    render(<StrictMode><CsvValueFilter {...props} /></StrictMode>);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search values' }), { target: { value: 'ada' } });
    await vi.advanceTimersByTimeAsync(150);

    expect(onModelChange).toHaveBeenCalledWith({ filterType: 'values', contains: 'ada' });
    tab.dispose();
  });
});
