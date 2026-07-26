import { randomUUID } from 'node:crypto';
import type {
  BeginComparisonRequest,
  BeginComparisonResult,
  CancelComparisonResult,
  CloseComparisonResult,
  ComparisonCandidate,
  ComparisonEvent,
  ComparisonFault,
  ComparisonKeyDiagnostics,
  ComparisonMutationOutcome,
  ComparisonSide,
  ComparisonSummary,
  ComparisonView,
  ComparisonWindowOutcome,
  ComparisonWindowRequest,
  CsvSessionMetadata,
  OpenComparisonResult,
} from '../shared/ipc';
import { orderComparisonValueColumns } from '../shared/comparison-presentation';
import type { ComparisonExecutor } from './comparison-executor';

export interface ComparisonCsvStore {
  getSession(sessionId: string): CsvSessionMetadata | null;
  listSessions(): CsvSessionMetadata[];
  isClosing(sessionId: string): boolean;
  subscribeToDataChanges(listener: (sessionId: string) => void): () => void;
}

type Snapshot = {
  artifactId: string;
  resultToken: string;
  key: string[];
  valueColumns: string[];
  summary: ComparisonSummary;
  swapped: boolean;
  revisions: { baseline: number; candidate: number };
  freshness: { kind: 'current' } | { kind: 'outdated'; changedSides: ComparisonSide[] };
};

type Operation = {
  operationId: string;
  intent: 'apply-key' | 'refresh';
  phase: 'validating' | 'comparing' | 'summarizing';
  cancelRequested: boolean;
};

type ComparisonActivity =
  | { kind: 'idle'; lastAttempt: ComparisonView['lastAttempt'] }
  | { kind: 'running'; operation: Operation; completion: Promise<void> };

type ComparisonRecord = {
  comparisonId: string;
  version: number;
  baselineId: string;
  candidateId: string;
  snapshot: Snapshot | null;
  activity: ComparisonActivity;
};

export class CsvComparisonService {
  private readonly entities = new Map<string, ComparisonRecord>();
  private readonly pairIndex = new Map<string, string>();
  private readonly listeners = new Set<(event: ComparisonEvent) => void>();
  private readonly pendingRetirements = new Set<string>();
  private readonly unsubscribeFromDataChanges: () => void;

  constructor(
    private readonly csvs: ComparisonCsvStore,
    private readonly executor: ComparisonExecutor,
  ) {
    this.unsubscribeFromDataChanges = csvs.subscribeToDataChanges((sessionId) => {
      this.markSourceChanged(sessionId);
    });
  }

  candidatesFor(baselineId: string): ComparisonCandidate[] {
    const baseline = this.csvs.getSession(baselineId);
    if (!baseline) return [];

    return this.csvs
      .listSessions()
      .filter(
        (session) => session.sessionId !== baselineId && !this.csvs.isClosing(session.sessionId),
      )
      .map((workingCsv) => ({ workingCsv, compatibility: compareColumns(baseline, workingCsv) }))
      .sort((left, right) => {
        const compatibilityOrder =
          Number(left.compatibility.kind === 'incompatible') -
          Number(right.compatibility.kind === 'incompatible');
        if (compatibilityOrder !== 0) return compatibilityOrder;
        return (
          compareText(left.workingCsv.file.name, right.workingCsv.file.name) ||
          compareText(left.workingCsv.file.path, right.workingCsv.file.path)
        );
      });
  }

  open(request: { baselineId: string; candidateId: string }): OpenComparisonResult {
    const baseline = this.csvs.getSession(request.baselineId);
    const candidate = this.csvs.getSession(request.candidateId);
    if (!baseline || !candidate)
      return rejected('source-not-found', 'Both Working CSVs must still be open.');
    if (this.csvs.isClosing(request.baselineId) || this.csvs.isClosing(request.candidateId)) {
      return rejected('source-not-found', 'A Working CSV is closing.');
    }
    if (request.baselineId === request.candidateId)
      return rejected('same-source', 'Choose two different Working CSVs.');
    if (compareColumns(baseline, candidate).kind === 'incompatible') {
      return rejected(
        'incompatible-columns',
        'The Working CSVs must contain the same column names.',
      );
    }

    const pair = pairKey(request.baselineId, request.candidateId);
    const existingId = this.pairIndex.get(pair);
    if (existingId) {
      const comparison = this.getState(existingId);
      if (comparison) return { status: 'existing', comparison };
      this.pairIndex.delete(pair);
    }

    const entity: ComparisonRecord = {
      comparisonId: randomUUID(),
      version: 1,
      baselineId: request.baselineId,
      candidateId: request.candidateId,
      snapshot: null,
      activity: { kind: 'idle', lastAttempt: null },
    };
    this.entities.set(entity.comparisonId, entity);
    this.pairIndex.set(pair, entity.comparisonId);
    return { status: 'created', comparison: this.project(entity) };
  }

  getState(comparisonId: string): ComparisonView | null {
    const entity = this.entities.get(comparisonId);
    return entity ? this.project(entity) : null;
  }

  begin(request: BeginComparisonRequest): BeginComparisonResult {
    const entity = this.entities.get(request.comparisonId);
    if (!entity) return rejected('comparison-not-found', 'The Comparison Tab is no longer open.');
    if (entity.activity.kind === 'running') {
      return { status: 'busy', activeOperationId: entity.activity.operation.operationId };
    }

    const key = request.kind === 'apply-key' ? request.key : entity.snapshot?.key;
    if (!key) return rejected('no-applied-key', 'Apply a Comparison Key before refreshing.');
    const keyFault = validateKeyShape(key, this.availableKeyColumns(entity));
    if (keyFault) return { status: 'rejected', fault: keyFault };
    if (this.csvs.isClosing(entity.baselineId) || this.csvs.isClosing(entity.candidateId)) {
      return rejected('source-not-found', 'A Working CSV is closing.');
    }
    if (!this.sourcesCompatible(entity))
      return rejected(
        'incompatible-columns',
        'The Working CSVs no longer contain the same columns.',
      );

    const operation: Operation = {
      operationId: randomUUID(),
      intent: request.kind,
      phase: 'validating',
      cancelRequested: false,
    };
    const completion = Promise.resolve().then(() => this.run(entity, operation, [...key]));
    entity.activity = { kind: 'running', operation, completion };
    this.publishChange(entity);
    return { status: 'accepted', operationId: operation.operationId };
  }

  cancel(comparisonId: string, operationId: string): CancelComparisonResult {
    const entity = this.entities.get(comparisonId);
    if (!entity) return { status: 'comparison-not-found' };
    if (entity.activity.kind === 'idle') return { status: 'already-finished' };
    const operation = entity.activity.operation;
    if (operation.operationId !== operationId) return { status: 'operation-mismatch' };
    if (operation.cancelRequested) return { status: 'already-requested' };
    operation.cancelRequested = true;
    this.executor.cancel(operation.operationId);
    return { status: 'requested' };
  }

  async getWindow(request: ComparisonWindowRequest): Promise<ComparisonWindowOutcome> {
    const entity = this.entities.get(request.comparisonId);
    if (!entity) return { status: 'comparison-not-found' };
    const snapshot = entity.snapshot;
    if (!snapshot || snapshot.resultToken !== request.resultToken) {
      return { status: 'result-replaced', currentResultToken: snapshot?.resultToken ?? null };
    }
    if (
      !Number.isSafeInteger(request.offset) ||
      request.offset < 0 ||
      !Number.isSafeInteger(request.limit) ||
      request.limit < 0 ||
      request.limit > 1000
    ) {
      return rejected(
        'invalid-window',
        'Comparison windows require a non-negative offset and a limit of at most 1,000.',
      );
    }

    const baseline = this.csvs.getSession(entity.baselineId);
    if (!baseline) return { status: 'comparison-not-found' };
    const valueColumns = orderComparisonValueColumns(
      baseline.columns,
      snapshot.key,
      snapshot.summary.changedColumns,
      request.columns,
    );
    const changedCounts = new Map(
      snapshot.summary.changedColumns.map((column) => [column.name, column.changedRowCount]),
    );
    const indexes = valueColumns.map((column) => snapshot.valueColumns.indexOf(column));
    let stored;
    try {
      stored = await this.executor.readWindow({
        artifactId: snapshot.artifactId,
        keyCount: snapshot.key.length,
        columnIndexes: indexes,
        offset: request.offset,
        limit: request.limit,
        differencesOnly: request.rows === 'differences',
        swapped: snapshot.swapped,
      });
    } catch (error) {
      const current = this.entities.get(request.comparisonId)?.snapshot;
      if (!current || current.resultToken !== request.resultToken) {
        return { status: 'result-replaced', currentResultToken: current?.resultToken ?? null };
      }
      throw error;
    }
    const current = this.entities.get(request.comparisonId)?.snapshot;
    if (!current || current.resultToken !== request.resultToken) {
      return { status: 'result-replaced', currentResultToken: current?.resultToken ?? null };
    }

    return {
      status: 'ready',
      window: {
        comparisonId: entity.comparisonId,
        resultToken: snapshot.resultToken,
        offset: request.offset,
        totalRowCount: stored.totalRowCount,
        keyColumns: [...snapshot.key],
        valueColumns: valueColumns.map((name) => ({
          name,
          changedRowCount: changedCounts.get(name) ?? 0,
        })),
        rows: stored.rows,
      },
    };
  }

  swap(comparisonId: string): ComparisonMutationOutcome {
    const entity = this.entities.get(comparisonId);
    if (!entity) return rejected('comparison-not-found', 'The Comparison Tab is no longer open.');
    if (entity.activity.kind === 'running') {
      return rejected('busy', 'Wait for the active comparison operation to finish.');
    }

    [entity.baselineId, entity.candidateId] = [entity.candidateId, entity.baselineId];
    if (entity.snapshot) {
      const snapshot = entity.snapshot;
      snapshot.swapped = !snapshot.swapped;
      [snapshot.summary.rows.baselineOnly, snapshot.summary.rows.candidateOnly] = [
        snapshot.summary.rows.candidateOnly,
        snapshot.summary.rows.baselineOnly,
      ];
      [snapshot.revisions.baseline, snapshot.revisions.candidate] = [
        snapshot.revisions.candidate,
        snapshot.revisions.baseline,
      ];
      if (snapshot.freshness.kind === 'outdated') {
        snapshot.freshness = {
          kind: 'outdated',
          changedSides: snapshot.freshness.changedSides
            .map((side) => (side === 'baseline' ? 'candidate' : 'baseline'))
            .sort(sideOrder),
        };
      }
      snapshot.resultToken = randomUUID();
    }
    this.publishChange(entity);
    return { status: 'changed', comparison: this.project(entity) };
  }

  async close(comparisonId: string): Promise<CloseComparisonResult> {
    const entity = this.entities.get(comparisonId);
    if (!entity) return { status: 'closed' };
    if (entity.activity.kind === 'running') {
      const { operation, completion } = entity.activity;
      operation.cancelRequested = true;
      this.executor.cancel(operation.operationId);
      await completion;
    }
    try {
      if (entity.snapshot) await this.executor.dropSnapshot(entity.snapshot.artifactId);
    } catch (error) {
      console.error(`Failed to clean up Comparison ${comparisonId}.`, error);
      return {
        status: 'failed',
        failure: {
          code: 'cleanup-failed',
          message: 'Unable to clean up the Comparison snapshot.',
          retryable: true,
        },
      };
    }
    this.entities.delete(comparisonId);
    this.pairIndex.delete(pairKey(entity.baselineId, entity.candidateId));
    this.emit({ kind: 'closed', comparisonId });
    return { status: 'closed' };
  }

  dependentComparisonIds(sessionId: string): string[] {
    return [...this.entities.values()]
      .filter((entity) => entity.baselineId === sessionId || entity.candidateId === sessionId)
      .map((entity) => entity.comparisonId);
  }

  async closeDependents(sessionId: string): Promise<void> {
    for (const comparisonId of this.dependentComparisonIds(sessionId)) {
      const result = await this.close(comparisonId);
      if (result.status === 'failed') throw new Error(result.failure.message);
    }
  }

  subscribe(listener: (event: ComparisonEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    this.unsubscribeFromDataChanges();
    const failures: Error[] = [];
    for (const comparisonId of [...this.entities.keys()]) {
      try {
        const result = await this.close(comparisonId);
        if (result.status === 'failed') failures.push(new Error(result.failure.message));
      } catch (error) {
        failures.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    try {
      await this.executor.dispose();
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)));
    }
    this.listeners.clear();
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Unable to dispose all Comparison resources.');
    }
  }

  private async run(entity: ComparisonRecord, operation: Operation, key: string[]): Promise<void> {
    let stagingArtifactId: string | null = null;
    try {
      await yieldToEventLoop();
      if (!this.operationIsCurrent(entity, operation)) {
        await this.settleAfterRelease(entity, operation, {
          attemptId: operation.operationId,
          status: 'cancelled',
        });
        return;
      }
      await this.retryPendingRetirements();
      if (!this.operationIsCurrent(entity, operation)) {
        await this.settleAfterRelease(entity, operation, {
          attemptId: operation.operationId,
          status: 'cancelled',
        });
        return;
      }
      const baseline = this.csvs.getSession(entity.baselineId);
      const candidate = this.csvs.getSession(entity.candidateId);
      if (!baseline || !candidate) {
        await this.releaseWorker(operation.operationId);
        this.finishFailed(entity, operation, 'source-unavailable');
        return;
      }
      const captured = { baseline: baseline.dataRevision, candidate: candidate.dataRevision };
      const baselineDiagnostics = await this.executor.validateKey(
        operation.operationId,
        entity.baselineId,
        key,
      );
      const candidateDiagnostics = await this.executor.validateKey(
        operation.operationId,
        entity.candidateId,
        key,
      );
      if (!this.operationIsCurrent(entity, operation)) {
        await this.settleAfterRelease(entity, operation, {
          attemptId: operation.operationId,
          status: 'cancelled',
        });
        return;
      }

      const diagnostics: ComparisonKeyDiagnostics = {
        key,
        baseline: baselineDiagnostics,
        candidate: candidateDiagnostics,
      };
      if (hasInvalidKeys(diagnostics)) {
        this.executor.cancel(operation.operationId);
        await this.settleAfterRelease(entity, operation, {
          attemptId: operation.operationId,
          status: 'invalid-key',
          diagnostics,
        });
        return;
      }

      operation.phase = 'comparing';
      this.publishChange(entity);
      await yieldToEventLoop();
      if (!this.operationIsCurrent(entity, operation)) {
        await this.settleAfterRelease(entity, operation, {
          attemptId: operation.operationId,
          status: 'cancelled',
        });
        return;
      }
      const valueColumns = baseline.columns
        .map((column) => column.name)
        .filter((column) => !key.includes(column));
      stagingArtifactId = operation.operationId;
      const summary = await this.executor.createSnapshot({
        artifactId: stagingArtifactId,
        baselineId: entity.baselineId,
        candidateId: entity.candidateId,
        key,
        valueColumns,
      });

      operation.phase = 'summarizing';
      this.publishChange(entity);
      await yieldToEventLoop();
      if (!this.operationIsCurrent(entity, operation)) {
        await this.retireSnapshot(stagingArtifactId);
        await this.settleAfterRelease(entity, operation, {
          attemptId: operation.operationId,
          status: 'cancelled',
        });
        return;
      }
      const currentBaseline = this.csvs.getSession(entity.baselineId);
      const currentCandidate = this.csvs.getSession(entity.candidateId);
      const changedSides: ComparisonSide[] = [];
      if (!currentBaseline || currentBaseline.dataRevision !== captured.baseline)
        changedSides.push('baseline');
      if (!currentCandidate || currentCandidate.dataRevision !== captured.candidate)
        changedSides.push('candidate');
      if (changedSides.length > 0) {
        await this.retireSnapshot(stagingArtifactId);
        await this.settleAfterRelease(entity, operation, {
          attemptId: operation.operationId,
          status: 'sources-changed',
          changedSides,
        });
        return;
      }

      const previousArtifactId = entity.snapshot?.artifactId ?? null;
      entity.snapshot = {
        artifactId: stagingArtifactId,
        resultToken: stagingArtifactId,
        key,
        valueColumns,
        swapped: false,
        summary,
        revisions: captured,
        freshness: { kind: 'current' },
      };
      stagingArtifactId = null;
      this.publishChange(entity);
      if (previousArtifactId) await this.retireSnapshot(previousArtifactId);
      await this.settleAfterRelease(entity, operation, {
        attemptId: operation.operationId,
        status: 'applied',
      });
    } catch (error) {
      console.error(`Comparison operation ${operation.operationId} failed.`, error);
      if (stagingArtifactId) await this.retireSnapshot(stagingArtifactId);
      await this.releaseWorker(operation.operationId);
      if (operation.cancelRequested) this.finishCancelled(entity, operation);
      else this.finishFailed(entity, operation, 'query-failed');
    } finally {
      await this.releaseWorker(operation.operationId);
    }
  }

  private async settleAfterRelease(
    entity: ComparisonRecord,
    operation: Operation,
    lastAttempt: ComparisonView['lastAttempt'],
  ): Promise<void> {
    await this.releaseWorker(operation.operationId);
    this.settle(entity, operation, lastAttempt);
  }

  private async releaseWorker(operationId: string): Promise<void> {
    await this.executor.release(operationId).catch((error) => {
      console.error(`Failed to release Comparison worker ${operationId}.`, error);
    });
  }

  private async retireSnapshot(artifactId: string): Promise<void> {
    try {
      await this.executor.dropSnapshot(artifactId);
      this.pendingRetirements.delete(artifactId);
    } catch (error) {
      this.pendingRetirements.add(artifactId);
      console.error(`Failed to retire Comparison snapshot ${artifactId}.`, error);
    }
  }

  private async retryPendingRetirements(): Promise<void> {
    for (const artifactId of [...this.pendingRetirements]) {
      await this.retireSnapshot(artifactId);
    }
  }

  private finishCancelled(entity: ComparisonRecord, operation: Operation): void {
    this.settle(entity, operation, { attemptId: operation.operationId, status: 'cancelled' });
  }

  private finishFailed(
    entity: ComparisonRecord,
    operation: Operation,
    code: 'source-unavailable' | 'query-failed',
  ): void {
    this.settle(entity, operation, {
      attemptId: operation.operationId,
      status: 'failed',
      failure:
        code === 'source-unavailable'
          ? { code, message: 'A source Working CSV is no longer available.', retryable: false }
          : { code, message: 'The comparison query failed. Try again.', retryable: true },
    });
  }

  private operationIsCurrent(entity: ComparisonRecord, operation: Operation): boolean {
    return (
      this.entities.get(entity.comparisonId) === entity &&
      entity.activity.kind === 'running' &&
      entity.activity.operation.operationId === operation.operationId &&
      !operation.cancelRequested
    );
  }

  private markSourceChanged(sessionId: string): void {
    for (const entity of this.entities.values()) {
      if (!entity.snapshot) continue;
      const side =
        entity.baselineId === sessionId
          ? 'baseline'
          : entity.candidateId === sessionId
            ? 'candidate'
            : null;
      if (!side) continue;
      const changedSides =
        entity.snapshot.freshness.kind === 'outdated' ? entity.snapshot.freshness.changedSides : [];
      if (!changedSides.includes(side)) changedSides.push(side);
      entity.snapshot.freshness = {
        kind: 'outdated',
        changedSides: [...changedSides].sort(sideOrder),
      };
      this.publishChange(entity);
    }
  }

  private sourcesCompatible(entity: ComparisonRecord): boolean {
    const baseline = this.csvs.getSession(entity.baselineId);
    const candidate = this.csvs.getSession(entity.candidateId);
    return Boolean(
      baseline && candidate && compareColumns(baseline, candidate).kind === 'compatible',
    );
  }

  private availableKeyColumns(entity: ComparisonRecord): string[] {
    const baseline = this.csvs.getSession(entity.baselineId);
    const candidate = this.csvs.getSession(entity.candidateId);
    if (!baseline || !candidate) return [];
    const candidateColumns = new Set(candidate.columns.map((column) => column.name));
    return baseline.columns
      .map((column) => column.name)
      .filter((column) => candidateColumns.has(column));
  }

  private project(entity: ComparisonRecord): ComparisonView {
    const baseline = this.csvs.getSession(entity.baselineId);
    const candidate = this.csvs.getSession(entity.candidateId);
    if (!baseline || !candidate) throw new Error('Comparison source invariant violated.');
    return {
      comparisonId: entity.comparisonId,
      version: entity.version,
      baseline,
      candidate,
      availableKeyColumns: this.availableKeyColumns(entity),
      operation:
        entity.activity.kind === 'running'
          ? {
              operationId: entity.activity.operation.operationId,
              intent: entity.activity.operation.intent,
              phase: entity.activity.operation.phase,
            }
          : null,
      applied: entity.snapshot
        ? {
            key: [...entity.snapshot.key],
            resultToken: entity.snapshot.resultToken,
            freshness:
              entity.snapshot.freshness.kind === 'current'
                ? { kind: 'current' }
                : { kind: 'outdated', changedSides: [...entity.snapshot.freshness.changedSides] },
            summary: copySummary(entity.snapshot.summary),
          }
        : null,
      lastAttempt: entity.activity.kind === 'idle' ? entity.activity.lastAttempt : null,
    };
  }

  private settle(
    entity: ComparisonRecord,
    operation: Operation,
    lastAttempt: ComparisonView['lastAttempt'],
  ): void {
    if (
      this.entities.get(entity.comparisonId) !== entity ||
      entity.activity.kind !== 'running' ||
      entity.activity.operation.operationId !== operation.operationId
    )
      return;
    entity.activity = { kind: 'idle', lastAttempt };
    this.publishChange(entity);
  }

  private publishChange(entity: ComparisonRecord): void {
    if (!this.csvs.getSession(entity.baselineId) || !this.csvs.getSession(entity.candidateId)) {
      console.error(`Comparison ${entity.comparisonId} has an unavailable source projection.`);
      return;
    }
    entity.version += 1;
    this.emit({ kind: 'changed', comparison: this.project(entity) });
  }

  private emit(event: ComparisonEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function compareColumns(
  baseline: CsvSessionMetadata,
  candidate: CsvSessionMetadata,
): ComparisonCandidate['compatibility'] {
  const baselineNames = baseline.columns.map((column) => column.name);
  const candidateNames = candidate.columns.map((column) => column.name);
  const baselineSet = new Set(baselineNames);
  const candidateSet = new Set(candidateNames);
  const missingFromBaseline = candidateNames.filter((name) => !baselineSet.has(name));
  const missingFromCandidate = baselineNames.filter((name) => !candidateSet.has(name));
  return missingFromBaseline.length === 0 && missingFromCandidate.length === 0
    ? { kind: 'compatible' }
    : { kind: 'incompatible', missingFromBaseline, missingFromCandidate };
}

function validateKeyShape(key: string[], available: string[]): ComparisonFault | null {
  if (key.length === 0 || new Set(key).size !== key.length)
    return fault('invalid-key-shape', 'Choose one or more distinct Comparison Key columns.');
  const known = new Set(available);
  if (key.some((column) => !known.has(column)))
    return fault(
      'unknown-key-column',
      'The Comparison Key contains a column that is not shared by both Working CSVs.',
    );
  return null;
}

function hasInvalidKeys(diagnostics: ComparisonKeyDiagnostics): boolean {
  return (
    diagnostics.baseline.blankRowCount > 0 ||
    diagnostics.baseline.duplicateGroupCount > 0 ||
    diagnostics.candidate.blankRowCount > 0 ||
    diagnostics.candidate.duplicateGroupCount > 0
  );
}

function copySummary(summary: ComparisonSummary): ComparisonSummary {
  return {
    rows: { ...summary.rows },
    changedColumns: summary.changedColumns.map((column) => ({ ...column })),
  };
}

function pairKey(left: string, right: string): string {
  return [left, right].sort().join('\u0000');
}

function sideOrder(left: ComparisonSide, right: ComparisonSide): number {
  return left === right ? 0 : left === 'baseline' ? -1 : 1;
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, undefined, { sensitivity: 'base' });
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function fault(code: ComparisonFault['code'], message: string): ComparisonFault {
  return { code, message };
}

function rejected(
  code: ComparisonFault['code'],
  message: string,
): { status: 'rejected'; fault: ComparisonFault } {
  return { status: 'rejected', fault: fault(code, message) };
}
