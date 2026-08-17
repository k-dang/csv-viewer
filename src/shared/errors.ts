/** Narrows an unknown thrown value to an Error, so failures can be collected and re-thrown. */
export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
