import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CsvViewerEvent } from '../shared/csv-viewer-contract';
import { App, type AppComponents } from './App';
import { CsvViewerProvider } from './csv-viewer';
import { workingCsvFixture } from '../test-helpers/csv-views';
import { createTestCsvViewer } from '../test-helpers/csv-viewer';

type RenderedAppState = {
  exportRequestSequence: number;
  onChooseCandidate: ((candidateId: string) => void) | undefined;
};

const renderedApp: RenderedAppState = {
  exportRequestSequence: 0,
  onChooseCandidate: undefined,
};

const testComponents: AppComponents = {
  ComparisonCandidateDialog: ({ onChoose }) => {
    renderedApp.onChooseCandidate = onChoose;
    return <></>;
  },
  ComparisonTab: () => <></>,
  CsvMetadataView: ({ exportRequestSequence = 0 }) => {
    renderedApp.exportRequestSequence = exportRequestSequence;
    return <></>;
  },
  DialectControls: () => <></>,
  EmptyCsvState: () => <></>,
  TabStrip: () => <></>,
};

afterEach(() => {
  vi.unstubAllGlobals();
  renderedApp.exportRequestSequence = 0;
  renderedApp.onChooseCandidate = undefined;
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
          <App components={testComponents} />
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
    expect(renderedApp.exportRequestSequence).toBe(1);

    await act(async () => receiveEvent?.({ type: 'intent', intent: 'close-tab' }));
    expect(close).toHaveBeenCalledWith({
      operation: 'csv.close',
      workingCsvId: workingCsv.workingCsvId,
    });

    await act(async () => renderer.unmount());
  });

  it('shows an error when opening a Comparison rejects', async () => {
    const baseline = workingCsvFixture({ workingCsvId: 'baseline' });
    const candidate = workingCsvFixture({ workingCsvId: 'candidate' });
    const openedCsvs = [baseline, candidate];
    let receiveEvent: ((event: CsvViewerEvent) => void) | undefined;
    const viewer = createTestCsvViewer({
      handlers: {
        'csv.open': async () => ({ status: 'opened', workingCsv: openedCsvs.shift() ?? candidate }),
        'comparison.get-candidates': async () => [
          { workingCsv: baseline, compatibility: { kind: 'compatible' } },
        ],
        'comparison.open': async () => {
          throw new Error('Comparison request failed.');
        },
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
    });
    vi.stubGlobal('document', {
      documentElement: { classList: { toggle: vi.fn() }, style: {} },
    });
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        <CsvViewerProvider viewer={viewer}>
          <App components={testComponents} />
        </CsvViewerProvider>,
      );
    });
    if (!receiveEvent) throw new Error('App did not subscribe to CsvViewer events.');

    await act(async () => receiveEvent?.({ type: 'intent', intent: 'open-csv' }));
    await act(async () => receiveEvent?.({ type: 'intent', intent: 'open-csv' }));
    const compareButton = renderer.root
      .findAllByType('button')
      .find((button) => button.children.includes('Compare…'));
    if (!compareButton) throw new Error('Compare button was not rendered.');
    await act(async () => compareButton.props.onClick());
    if (!renderedApp.onChooseCandidate) throw new Error('Candidate picker was not rendered.');

    await act(async () => {
      renderedApp.onChooseCandidate?.(baseline.workingCsvId);
      await Promise.resolve();
    });

    expect(renderer.root.findByProps({ role: 'alert' }).children).toEqual(['Comparison request failed.']);
    await act(async () => renderer.unmount());
  });
});
