import type { ReactElement } from 'react';
import { electronCsvViewerCapabilities } from '../shared/electron-csv-viewer-capabilities';
import type {
  CsvViewer,
  CsvViewerCapabilities,
  CsvViewerOperationMap,
  CsvViewerRequest,
} from '../shared/csv-viewer-contract';
import { CsvViewerProvider } from '../renderer/csv-viewer';

type RequestFor<Operation extends keyof CsvViewerOperationMap> = Extract<CsvViewerRequest, { operation: Operation }>;

type TestCsvViewerHandlers = {
  [Operation in keyof CsvViewerOperationMap]?: (
    request: RequestFor<Operation>,
  ) => Promise<CsvViewerOperationMap[Operation]['result']>;
};

type TestCsvViewerOverrides = {
  capabilities?: Partial<CsvViewerCapabilities>;
  handlers?: TestCsvViewerHandlers;
  onEvent?: CsvViewer['onEvent'];
};

/** A minimal CsvViewer for renderer tests. Tests stub only the protocol calls they exercise. */
export function createTestCsvViewer(overrides: TestCsvViewerOverrides = {}): CsvViewer {
  const dispatch = (request: CsvViewerRequest): Promise<CsvViewerOperationMap[keyof CsvViewerOperationMap]['result']> => {
    // SAFETY: The mapped handlers bind each operation to its exact request and result pair.
    const handler = overrides.handlers?.[request.operation] as
      | ((request: CsvViewerRequest) => Promise<CsvViewerOperationMap[keyof CsvViewerOperationMap]['result']>)
      | undefined;
    if (!handler) {
      throw new Error(`${request.operation} was called but is not stubbed in this test.`);
    }
    return handler(request);
  };

  return {
    capabilities: { ...electronCsvViewerCapabilities, ...overrides.capabilities },
    // SAFETY: dispatch preserves the operation-to-result pairing through TestCsvViewerHandlers.
    call: dispatch as CsvViewer['call'],
    onEvent: overrides.onEvent ?? (() => () => {}),
  };
}

export function withCsvViewer(element: ReactElement, viewer: CsvViewer = createTestCsvViewer()) {
  return <CsvViewerProvider viewer={viewer}>{element}</CsvViewerProvider>;
}
