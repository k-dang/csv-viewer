import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CsvViewerEvent } from '../shared/csv-viewer-contract';
import { App } from './App';
import { CsvViewerProvider } from './csv-viewer';
import { enableActEnvironment } from './testing/act-environment';
import { workingCsvFixture } from './testing/csv-fixtures';
import { createTestCsvViewer } from './testing/test-csv-viewer';

const renderedMetadata = vi.hoisted(() => ({ exportRequestSequence: 0 }));

vi.mock('@/components/comparison-candidate-dialog', () => ({ ComparisonCandidateDialog: () => null }));
vi.mock('@/components/comparison-tab', () => ({ ComparisonTab: () => null }));
vi.mock('@/components/csv-metadata-view', () => ({
  CsvMetadataView: (props: { exportRequestSequence: number }) => {
    renderedMetadata.exportRequestSequence = props.exportRequestSequence;
    return null;
  },
}));
vi.mock('@/components/dialect-controls', () => ({ DialectControls: () => null }));
vi.mock('@/components/empty-csv-state', () => ({ EmptyCsvState: () => null }));
vi.mock('@/components/tab-strip', () => ({ TabStrip: () => null }));

enableActEnvironment();

afterEach(() => {
  vi.unstubAllGlobals();
  renderedMetadata.exportRequestSequence = 0;
});

describe('App CsvViewer intents', () => {
  it('maps all four menu intents to the active CsvViewer behavior', async () => {
    const workingCsv = workingCsvFixture();
    const open = vi.fn(async () => ({ status: 'opened' as const, workingCsv }));
    const reopen = vi.fn(async () => ({ status: 'opened' as const, workingCsv }));
    const close = vi.fn(async () => ({
      status: 'closed' as const,
      closedWorkingCsvId: workingCsv.workingCsvId,
      closedComparisonIds: [],
    }));
    let receiveEvent: ((event: CsvViewerEvent) => void) | undefined;
    const viewer = createTestCsvViewer({
      handlers: {
        'csv.open': open,
        'csv.reopen': reopen,
        'csv.close': close,
      },
      onEvent: (listener) => {
        receiveEvent = listener;
        return () => {};
      },
    });
    vi.stubGlobal('window', {
      localStorage: { getItem: () => null, setItem: vi.fn() },
      matchMedia: () => ({ matches: false }),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      confirm: vi.fn(() => true),
    });
    vi.stubGlobal('document', {
      documentElement: { classList: { toggle: vi.fn() }, style: {} },
    });
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        <CsvViewerProvider viewer={viewer}>
          <App />
        </CsvViewerProvider>,
      );
    });
    if (!receiveEvent) throw new Error('App did not subscribe to CsvViewer events.');

    await act(async () => receiveEvent?.({ type: 'intent', intent: 'open-csv' }));
    expect(open).toHaveBeenCalledWith({ operation: 'csv.open', options: {} });

    await act(async () => receiveEvent?.({ type: 'intent', intent: 'reopen-csv' }));
    expect(reopen).toHaveBeenCalledWith({
      operation: 'csv.reopen',
      workingCsvId: workingCsv.workingCsvId,
      options: {},
    });

    await act(async () => receiveEvent?.({ type: 'intent', intent: 'export-csv' }));
    expect(renderedMetadata.exportRequestSequence).toBe(1);

    await act(async () => receiveEvent?.({ type: 'intent', intent: 'close-tab' }));
    expect(close).toHaveBeenCalledWith({
      operation: 'csv.close',
      workingCsvId: workingCsv.workingCsvId,
    });

    await act(async () => renderer.unmount());
  });
});
