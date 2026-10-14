import { Effect } from 'effect';
import type { CsvSourceId } from './csv-viewer';
import { CsvSourceUnavailableError, defaultDelimiterForSourceName, type CsvSourceDescription } from './workspace-host';

export class SourceTable<Body> {
  private readonly records = new Map<CsvSourceId, Body>();

  reserve(body: Body, matches: (existing: Body, incoming: Body) => boolean): CsvSourceId {
    for (const [sourceId, existing] of this.records) {
      if (!matches(existing, body)) continue;
      this.records.set(sourceId, body);
      return sourceId;
    }
    const sourceId = crypto.randomUUID();
    this.records.set(sourceId, body);
    return sourceId;
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
