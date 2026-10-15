import { Effect } from 'effect';
import type { CsvSourceId } from './csv-viewer';
import { CsvSourceUnavailableError, defaultDelimiterForSourceName, type CsvSourceDescription } from './workspace-host';

export class SourceTable<Body> {
  private readonly records = new Map<CsvSourceId, Body>();

  /**
   * Reuses the highest-ranked match. `false` and `0` are different records; `true` ranks as a
   * match. A weaker row for that same record is dropped so a later reservation cannot select it,
   * and `merge` decides what the kept row stores.
   */
  reserve(
    body: Body,
    matches: (existing: Body, incoming: Body) => boolean | number,
    merge: (existing: Body, incoming: Body) => Body = (_existing, incoming) => incoming,
  ): CsvSourceId {
    const found: Array<{ sourceId: CsvSourceId; existing: Body; rank: number }> = [];
    for (const [sourceId, existing] of this.records) {
      const rank = matchRank(matches(existing, body));
      if (rank > 0) found.push({ sourceId, existing, rank });
    }
    const [first] = found;
    if (first === undefined) {
      const sourceId = crypto.randomUUID();
      this.records.set(sourceId, body);
      return sourceId;
    }
    let selected = first;
    for (const candidate of found) {
      if (candidate.rank > selected.rank) selected = candidate;
    }
    this.records.set(selected.sourceId, merge(selected.existing, body));
    for (const candidate of found) {
      if (candidate.rank < selected.rank) this.records.delete(candidate.sourceId);
    }
    return selected.sourceId;
  }

  get(sourceId: CsvSourceId): Body | undefined {
    return this.records.get(sourceId);
  }

  find(predicate: (body: Body) => boolean): { sourceId: CsvSourceId; body: Body } | undefined {
    for (const [sourceId, body] of this.records) {
      if (predicate(body)) return { sourceId, body };
    }
    return undefined;
  }

  require(sourceId: CsvSourceId, missing: CsvSourceUnavailableError): Effect.Effect<Body, CsvSourceUnavailableError> {
    return Effect.suspend(() => {
      const body = this.records.get(sourceId);
      return body === undefined ? Effect.fail(missing) : Effect.succeed(body);
    });
  }

  release(sourceId: CsvSourceId): void {
    this.records.delete(sourceId);
  }

  values(): IterableIterator<Body> {
    return this.records.values();
  }
}

function matchRank(match: boolean | number): number {
  if (match === true) return 1;
  if (match === false) return 0;
  return match;
}

export function sourceDescription(
  sourceId: CsvSourceId,
  name: string,
  location: string,
  sizeBytes: number,
): CsvSourceDescription {
  return {
    sourceId,
    name,
    location,
    sizeBytes,
    defaultDelimiter: defaultDelimiterForSourceName(name),
  };
}
