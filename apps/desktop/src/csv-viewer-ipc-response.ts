export type CsvViewerIpcResponse<T> = { ok: true; value: T } | { ok: false; message: string };

export function unwrapCsvViewerIpcResponse<T>(response: CsvViewerIpcResponse<T>): T {
  if (response.ok) return response.value;
  throw new Error(response.message);
}
