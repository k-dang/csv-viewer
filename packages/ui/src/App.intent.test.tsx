// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CsvViewerEvent } from '@csv-viewer/workspace/csv-viewer';
import { App, type AppComponents } from './App';
import { CsvViewerProvider } from './csv-viewer';
import { workingCsvFixture } from './test-helpers/csv-views';
import { createTestCsvViewer } from './test-helpers/csv-viewer';

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

beforeEach(() => {
  // jsdom ships neither of these: the App reads matchMedia for the initial theme and confirm on close.
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
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

    render(
      <CsvViewerProvider viewer={viewer}>
        <App components={testComponents} />
      </CsvViewerProvider>,
    );
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

    render(
      <CsvViewerProvider viewer={viewer}>
        <App components={testComponents} />
      </CsvViewerProvider>,
    );
    if (!receiveEvent) throw new Error('App did not subscribe to CsvViewer events.');

    await act(async () => receiveEvent?.({ type: 'intent', intent: 'open-csv' }));
    await act(async () => receiveEvent?.({ type: 'intent', intent: 'open-csv' }));

    await act(async () => {
      screen.getByRole('button', { name: /Compare/ }).click();
    });
    if (!renderedApp.onChooseCandidate) throw new Error('Candidate picker was not rendered.');

    await act(async () => {
      renderedApp.onChooseCandidate?.(baseline.workingCsvId);
      await Promise.resolve();
    });

    expect(screen.getByRole('alert').textContent).toBe('Comparison request failed.');
  });
});
