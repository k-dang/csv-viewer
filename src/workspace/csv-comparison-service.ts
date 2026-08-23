import type {
  BeginComparisonRequest,
  CancelComparisonRequest,
  CancelComparisonResult,
  CloseComparisonResult,
  ComparisonCandidate,
  ComparisonEvent,
  ComparisonFault,
  ComparisonId,
  ComparisonKeyDiagnostics,
  ComparisonMutationOutcome,
  ComparisonOperationId,
  ComparisonResultToken,
  ComparisonSide,
  ComparisonSummary,
  ComparisonView,
  ComparisonWindowOutcome,
  ComparisonWindowRequest,
  WorkingCsvView,
  WorkingCsvId,
  OpenComparisonResult,
  OpenComparisonRequest,
} from '../shared/csv-viewer-contract';
import { orderComparisonValueColumns } from '../shared/comparison-presentation';
import { toError } from '../shared/errors';
import { isValidRowWindow } from './csv-query';
import type { ComparisonExecutor } from './comparison-executor';
import {
  compareColumns,
  hasInvalidKeys,
  rejected,
  sharedColumnNames,
  sideOrder,
  validateKeyShape,
} from './comparison-key-rules';
import { projectComparison } from './comparison-projection';

export interface ComparisonCsvStore {
  getState(workingCsvId: WorkingCsvId): WorkingCsvView | null;
  list(): WorkingCsvView[];
  isClosing(workingCsvId: WorkingCsvId): boolean;
  subscribeToDataChanges(listener: (workingCsvId: WorkingCsvId) => void): () => void;
}

type Snapshot = {
  artifactId: ComparisonOperationId;
  resultToken: ComparisonResultToken;
  key: string[];
  valueColumns: string[];
  summary: ComparisonSummary;
  swapped: boolean;
  revisions: { baseline: number; candidate: number };
  freshness: { kind: 'current' } | { kind: 'outdated'; changedSides: ComparisonSide[] };
};

type Operation = {
  operationId: ComparisonOperationId;
  intent: 'apply-key' | 'refresh';
  phase: 'validating' | 'comparing' | 'summarizing';
  cancelRequested: boolean;
  changedSides: ComparisonSide[];
};

type ComparisonActivity =
  | { kind: 'idle'; lastAttempt: ComparisonView['lastAttempt'] }
  | { kind: 'running'; operation: Operation; completion: Promise<ComparisonAttemptOutcome> };

export type ComparisonAttemptOutcome =
  | { status: 'applied'; comparison: ComparisonView }
  | {
      status: 'invalid-key';
      diagnostics: ComparisonKeyDiagnostics;
      comparison: ComparisonView;
    }
  | { status: 'cancelled'; comparison: ComparisonView }
  | {
      status: 'sources-changed';
      changedSides: ComparisonSide[];
      comparison: ComparisonView;
    }
  | {
      status: 'failed';
      failure: Extract<ComparisonView['lastAttempt'], { status: 'failed' }>['failure'];
      comparison: ComparisonView | null;
    };

export type BeginComparisonAttempt =
  | {
      status: 'accepted';
      operationId: ComparisonOperationId;
      completion: Promise<ComparisonAttemptOutcome>;
    }
  | { status: 'busy'; activeOperationId: string }
  | { status: 'rejected'; fault: ComparisonFault };

type ComparisonRecord = {
  comparisonId: ComparisonId;
  version: number;
  baselineId: WorkingCsvId;
  candidateId: WorkingCsvId;
  snapshot: Snapshot | null;
  activity: ComparisonActivity;
};

export class CsvComparisonService {
  private readonly entities = new Map<ComparisonId, ComparisonRecord>();
  private readonly pairIndex = new Map<string, ComparisonId>();
  private readonly dependencyIndex = new Map<WorkingCsvId, Set<ComparisonId>>();
  private readonly listeners = new Set<(event: ComparisonEvent) => void>();
  private readonly pendingRetirements = new Set<string>();
  private readonly unsubscribeFromDataChanges: () => void;
  private lifecycle: 'active' | 'disposing' | 'disposed' = 'active';

  constructor(
    private readonly csvs: ComparisonCsvStore,
    private readonly executor: ComparisonExecutor,
  ) {
    this.unsubscribeFromDataChanges = csvs.subscribeToDataChanges((workingCsvId) => {
      this.markSourceChanged(workingCsvId);
    });
  }

  beginDisposal(): void {
    if (this.lifecycle === 'active') this.lifecycle = 'disposing';
  }

  candidatesFor(baselineId: WorkingCsvId): ComparisonCandidate[] {
    if (this.lifecycle !== 'active') return [];
    const baseline = this.csvs.getState(baselineId);
    if (!baseline) return [];

    return this.csvs
      .list()
      .filter(
        (workingCsv) =>
          workingCsv.workingCsvId !== baselineId &&
          !this.csvs.isClosing(workingCsv.workingCsvId),
      )
      .map((workingCsv) => ({ workingCsv, compatibility: compareColumns(baseline, workingCsv) }))
      .sort((left, right) => {
        const compatibilityOrder =
          Number(left.compatibility.kind === 'incompatible') -
          Number(right.compatibility.kind === 'incompatible');
        if (compatibilityOrder !== 0) return compatibilityOrder;
        return (
          compareText(left.workingCsv.file.name, right.workingCsv.file.name) ||
          compareText(left.workingCsv.file.location, right.workingCsv.file.location)
        );
      });
  }

  open(request: OpenComparisonRequest): OpenComparisonResult {
    if (this.lifecycle !== 'active') {
      return rejected('source-not-found', 'The CSV workspace is closing.');
    }
    const baseline = this.csvs.getState(request.baselineId);
    const candidate = this.csvs.getState(request.candidateId);
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
      comparisonId: crypto.randomUUID(),
      version: 1,
      baselineId: request.baselineId,
      candidateId: request.candidateId,
      snapshot: null,
      activity: { kind: 'idle', lastAttempt: null },
    };
    this.entities.set(entity.comparisonId, entity);
    this.pairIndex.set(pair, entity.comparisonId);
    this.addDependency(entity.baselineId, entity.comparisonId);
    this.addDependency(entity.candidateId, entity.comparisonId);
    return { status: 'created', comparison: this.project(entity) };
  }

  getState(comparisonId: ComparisonId): ComparisonView | null {
    const entity = this.entities.get(comparisonId);
    return entity ? this.project(entity) : null;
  }

  begin(request: BeginComparisonRequest): BeginComparisonAttempt {
    if (this.lifecycle !== 'active') {
      return rejected('source-not-found', 'The CSV workspace is closing.');
    }
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
      operationId: crypto.randomUUID(),
      intent: request.kind,
      phase: 'validating',
      cancelRequested: false,
      changedSides: [],
    };
    const completion = Promise.resolve().then(() => this.run(entity, operation, [...key]));
    entity.activity = { kind: 'running', operation, completion };
    this.publishChange(entity);
    return { status: 'accepted', operationId: operation.operationId, completion };
  }

  async cancel(request: CancelComparisonRequest): Promise<CancelComparisonResult> {
    const entity = this.entities.get(request.comparisonId);
    if (!entity) return { status: 'comparison-not-found' };
    if (entity.activity.kind === 'idle') return { status: 'already-finished' };
    const operation = entity.activity.operation;
    if (operation.operationId !== request.operationId) return { status: 'operation-mismatch' };
    if (operation.cancelRequested) return { status: 'already-requested' };
    operation.cancelRequested = true;
    this.executor.cancel(operation.operationId);
    return { status: 'requested' };
  }

  async getWindow(request: ComparisonWindowRequest): Promise<ComparisonWindowOutcome> {
    if (this.lifecycle !== 'active') {
      return rejected('source-not-found', 'The CSV workspace is closing.');
    }
    const entity = this.entities.get(request.comparisonId);
    if (!entity) return { status: 'comparison-not-found' };
    const snapshot = entity.snapshot;
    if (!snapshot || snapshot.resultToken !== request.resultToken) {
      return { status: 'result-replaced', currentResultToken: snapshot?.resultToken ?? null };
    }
    if (!isValidRowWindow(request.offset, request.limit)) {
      return rejected(
        'invalid-window',
        'Comparison windows require a non-negative offset and a limit of at most 1,000.',
      );
    }

    const baseline = this.csvs.getState(entity.baselineId);
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

  swap(comparisonId: ComparisonId): ComparisonMutationOutcome {
    if (this.lifecycle !== 'active') {
      return rejected('source-not-found', 'The CSV workspace is closing.');
    }
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
      snapshot.resultToken = crypto.randomUUID();
    }
    this.publishChange(entity);
    return { status: 'changed', comparison: this.project(entity) };
  }

  async close(comparisonId: ComparisonId): Promise<CloseComparisonResult> {
    const entity = this.entities.get(comparisonId);
    if (!entity) return { status: 'closed', comparisonId };
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
    this.removeDependency(entity.baselineId, comparisonId);
    this.removeDependency(entity.candidateId, comparisonId);
    this.emit({ kind: 'closed', comparisonId });
    return { status: 'closed', comparisonId };
  }

  dependentComparisonIds(workingCsvId: WorkingCsvId): ComparisonId[] {
    return [...(this.dependencyIndex.get(workingCsvId) ?? [])];
  }

  async closeDependents(workingCsvId: WorkingCsvId): Promise<void> {
    for (const comparisonId of this.dependentComparisonIds(workingCsvId)) {
      const result = await this.close(comparisonId);
      if (result.status === 'failed') throw new Error(result.failure.message);
    }
  }

  subscribe(listener: (event: ComparisonEvent) => void): () => void {
    if (this.lifecycle !== 'active') return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    this.beginDisposal();
    this.unsubscribeFromDataChanges();
    const failures: Error[] = [];
    for (const comparisonId of [...this.entities.keys()]) {
      try {
        const result = await this.close(comparisonId);
        if (result.status === 'failed') failures.push(new Error(result.failure.message));
      } catch (error) {
        failures.push(toError(error));
      }
    }
    try {
      await this.executor.dispose();
    } catch (error) {
      failures.push(toError(error));
    }
    this.listeners.clear();
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Unable to dispose all Comparison resources.');
    }
    this.lifecycle = 'disposed';
  }

  private async run(
    entity: ComparisonRecord,
    operation: Operation,
    key: string[],
  ): Promise<ComparisonAttemptOutcome> {
    let stagingArtifactId: ComparisonOperationId | null = null;
    try {
      await yieldToEventLoop();
      if (!this.operationIsCurrent(entity, operation)) {
        return this.settleAfterRelease(entity, operation, {
          attemptId: operation.operationId,
          status: 'cancelled',
        });
      }
      await this.retryPendingRetirements();
      if (!this.operationIsCurrent(entity, operation)) {
        return this.settleAfterRelease(entity, operation, {
          attemptId: operation.operationId,
          status: 'cancelled',
        });
      }
      const baseline = this.csvs.getState(entity.baselineId);
      const candidate = this.csvs.getState(entity.candidateId);
      if (!baseline || !candidate) {
        await this.releaseWorker(operation.operationId);
        return this.finishFailed(entity, operation, 'source-unavailable');
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
        return this.settleAfterRelease(entity, operation, {
          attemptId: operation.operationId,
          status: 'cancelled',
        });
      }

      const diagnostics: ComparisonKeyDiagnostics = {
        key,
        baseline: baselineDiagnostics,
        candidate: candidateDiagnostics,
      };
      if (hasInvalidKeys(diagnostics)) {
        this.executor.cancel(operation.operationId);
        return this.settleAfterRelease(entity, operation, {
          attemptId: operation.operationId,
          status: 'invalid-key',
          diagnostics,
        });
      }

      operation.phase = 'comparing';
      this.publishChange(entity);
      await yieldToEventLoop();
      if (!this.operationIsCurrent(entity, operation)) {
        return this.settleAfterRelease(entity, operation, {
          attemptId: operation.operationId,
          status: 'cancelled',
        });
      }
      const valueColumns = baseline.columns
        .map((column) => column.name)
        .filter((column) => !key.includes(column));
      stagingArtifactId = operation.operationId;
      const summary = await this.executor.createSnapshot({
        artifactId: stagingArtifactId,
        comparisonId: entity.comparisonId,
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
        return this.settleAfterRelease(entity, operation, {
          attemptId: operation.operationId,
          status: 'cancelled',
        });
      }
      const currentBaseline = this.csvs.getState(entity.baselineId);
      const currentCandidate = this.csvs.getState(entity.candidateId);
      const changedSides: ComparisonSide[] = [];
      if (!currentBaseline || currentBaseline.dataRevision !== captured.baseline)
        changedSides.push('baseline');
      if (!currentCandidate || currentCandidate.dataRevision !== captured.candidate)
        changedSides.push('candidate');
      if (changedSides.length > 0) {
        await this.retireSnapshot(stagingArtifactId);
        return this.settleAfterRelease(entity, operation, {
          attemptId: operation.operationId,
          status: 'sources-changed',
          changedSides,
        });
      }

      const previousArtifactId = entity.snapshot?.artifactId ?? null;
      this.executor.activateSnapshot(stagingArtifactId);
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
      return this.settleAfterRelease(entity, operation, {
        attemptId: operation.operationId,
        status: 'applied',
      });
    } catch (error) {
      console.error(`Comparison operation ${operation.operationId} failed.`, error);
      if (stagingArtifactId) await this.retireSnapshot(stagingArtifactId);
      await this.releaseWorker(operation.operationId);
      if (operation.changedSides.length > 0) {
        return this.finishSourcesChanged(entity, operation, operation.changedSides);
      }
      if (operation.cancelRequested) return this.finishCancelled(entity, operation);
      return this.finishFailed(entity, operation, 'query-failed');
    } finally {
      await this.releaseWorker(operation.operationId);
    }
  }

  private async settleAfterRelease(
    entity: ComparisonRecord,
    operation: Operation,
    lastAttempt: ComparisonView['lastAttempt'],
  ): Promise<ComparisonAttemptOutcome> {
    await this.releaseWorker(operation.operationId);
    return this.settle(entity, operation, lastAttempt);
  }

  private async releaseWorker(operationId: ComparisonOperationId): Promise<void> {
    await this.executor.release(operationId).catch((error) => {
      console.error(`Failed to release Comparison worker ${operationId}.`, error);
    });
  }

  private async retireSnapshot(artifactId: ComparisonOperationId): Promise<void> {
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

  private finishCancelled(
    entity: ComparisonRecord,
    operation: Operation,
  ): ComparisonAttemptOutcome {
    return this.settle(entity, operation, {
      attemptId: operation.operationId,
      status: 'cancelled',
    });
  }

  private finishFailed(
    entity: ComparisonRecord,
    operation: Operation,
    code: 'source-unavailable' | 'query-failed',
  ): ComparisonAttemptOutcome {
    return this.settle(entity, operation, {
      attemptId: operation.operationId,
      status: 'failed',
      failure:
        code === 'source-unavailable'
          ? { code, message: 'A source Working CSV is no longer available.', retryable: false }
          : { code, message: 'The comparison query failed. Try again.', retryable: true },
    });
  }

  private finishSourcesChanged(
    entity: ComparisonRecord,
    operation: Operation,
    changedSides: ComparisonSide[],
  ): ComparisonAttemptOutcome {
    return this.settle(entity, operation, {
      attemptId: operation.operationId,
      status: 'sources-changed',
      changedSides: [...changedSides].sort(sideOrder),
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

  private markSourceChanged(workingCsvId: WorkingCsvId): void {
    for (const comparisonId of this.dependencyIndex.get(workingCsvId) ?? []) {
      const entity = this.entities.get(comparisonId);
      if (!entity) throw new Error('Comparison dependency index invariant violated.');
      const side =
        entity.baselineId === workingCsvId
          ? 'baseline'
          : entity.candidateId === workingCsvId
            ? 'candidate'
            : null;
      if (!side) continue;
      if (entity.activity.kind === 'running') {
        const { operation } = entity.activity;
        if (!operation.changedSides.includes(side)) operation.changedSides.push(side);
        this.executor.cancel(operation.operationId);
      }
      if (!entity.snapshot) continue;
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

  private addDependency(workingCsvId: WorkingCsvId, comparisonId: ComparisonId): void {
    const comparisons = this.dependencyIndex.get(workingCsvId) ?? new Set<ComparisonId>();
    comparisons.add(comparisonId);
    this.dependencyIndex.set(workingCsvId, comparisons);
  }

  private removeDependency(workingCsvId: WorkingCsvId, comparisonId: ComparisonId): void {
    const comparisons = this.dependencyIndex.get(workingCsvId);
    if (!comparisons) throw new Error('Comparison dependency index invariant violated.');
    comparisons.delete(comparisonId);
    if (comparisons.size === 0) this.dependencyIndex.delete(workingCsvId);
  }

  private sourcesCompatible(entity: ComparisonRecord): boolean {
    const baseline = this.csvs.getState(entity.baselineId);
    const candidate = this.csvs.getState(entity.candidateId);
    return Boolean(
      baseline && candidate && compareColumns(baseline, candidate).kind === 'compatible',
    );
  }

  private availableKeyColumns(entity: ComparisonRecord): string[] {
    const baseline = this.csvs.getState(entity.baselineId);
    const candidate = this.csvs.getState(entity.candidateId);
    return baseline && candidate ? sharedColumnNames(baseline, candidate) : [];
  }

  private project(entity: ComparisonRecord): ComparisonView {
    const baseline = this.csvs.getState(entity.baselineId);
    const candidate = this.csvs.getState(entity.candidateId);
    if (!baseline || !candidate) throw new Error('Comparison source invariant violated.');
    return projectComparison({
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
      applied: entity.snapshot,
      lastAttempt: entity.activity.kind === 'idle' ? entity.activity.lastAttempt : null,
    });
  }

  private settle(
    entity: ComparisonRecord,
    operation: Operation,
    lastAttempt: ComparisonView['lastAttempt'],
  ): ComparisonAttemptOutcome {
    if (
      this.entities.get(entity.comparisonId) !== entity ||
      entity.activity.kind !== 'running' ||
      entity.activity.operation.operationId !== operation.operationId
    ) {
      throw new Error('Comparison operation settlement invariant violated.');
    }
    entity.activity = { kind: 'idle', lastAttempt };
    this.publishChange(entity);
    if (!lastAttempt) throw new Error('Comparison terminal outcome invariant violated.');
    if (lastAttempt.status === 'failed') {
      const baseline = this.csvs.getState(entity.baselineId);
      const candidate = this.csvs.getState(entity.candidateId);
      return {
        status: 'failed',
        failure: lastAttempt.failure,
        comparison: baseline && candidate ? this.project(entity) : null,
      };
    }
    const comparison = this.project(entity);
    switch (lastAttempt.status) {
      case 'applied':
        return { status: 'applied', comparison };
      case 'invalid-key':
        return { status: 'invalid-key', diagnostics: lastAttempt.diagnostics, comparison };
      case 'cancelled':
        return { status: 'cancelled', comparison };
      case 'sources-changed':
        return { status: 'sources-changed', changedSides: lastAttempt.changedSides, comparison };
    }
  }

  private publishChange(entity: ComparisonRecord): void {
    if (!this.csvs.getState(entity.baselineId) || !this.csvs.getState(entity.candidateId)) {
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

function pairKey(left: string, right: string): string {
  return [left, right].sort().join('\u0000');
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, undefined, { sensitivity: 'base' });
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
