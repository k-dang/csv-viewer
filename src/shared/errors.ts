/** Narrows an unknown thrown value to an Error, so failures can be collected and re-thrown. */
export function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}
