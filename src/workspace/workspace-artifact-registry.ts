import type {
  ComparisonId,
  ComparisonOperationId,
  WorkingCsvId,
} from '../shared/csv-viewer-contract';

export type WorkspaceArtifactOwner =
  | { kind: 'working-csv'; workingCsvId: WorkingCsvId }
  | { kind: 'comparison'; comparisonId: ComparisonId };

export type WorkspaceArtifactRole = 'current' | 'staging' | 'active' | 'retired';

export type WorkspaceArtifact = {
  tableName: string;
  owner: WorkspaceArtifactOwner;
  role: WorkspaceArtifactRole;
  operationId?: ComparisonOperationId;
};

export class WorkspaceArtifactRegistry {
  private readonly artifacts = new Map<string, WorkspaceArtifact>();

  register(artifact: WorkspaceArtifact): void {
    if (this.artifacts.has(artifact.tableName)) {
      throw new Error(`Workspace artifact ${artifact.tableName} is already registered.`);
    }
    this.artifacts.set(artifact.tableName, cloneArtifact(artifact));
  }

  transition(tableName: string, role: WorkspaceArtifactRole): void {
    const artifact = this.require(tableName);
    this.artifacts.set(tableName, { ...artifact, role });
  }

  remove(tableName: string): void {
    this.require(tableName);
    this.artifacts.delete(tableName);
  }

  get(tableName: string): WorkspaceArtifact | null {
    const artifact = this.artifacts.get(tableName);
    return artifact ? cloneArtifact(artifact) : null;
  }

  assertNoArtifactsOwnedBy(kind: WorkspaceArtifactOwner['kind']): void {
    const remaining = [...this.artifacts.values()].filter((artifact) => artifact.owner.kind === kind);
    if (remaining.length > 0) {
      throw new Error(`Workspace artifact invariant violated: ${kind} artifacts remain.`);
    }
  }

  assertEmpty(): void {
    if (this.artifacts.size > 0) {
      throw new Error('Workspace artifact invariant violated: registered artifacts remain.');
    }
  }

  private require(tableName: string): WorkspaceArtifact {
    const artifact = this.artifacts.get(tableName);
    if (!artifact) throw new Error(`Workspace artifact ${tableName} is not registered.`);
    return artifact;
  }
}

function cloneArtifact(artifact: WorkspaceArtifact): WorkspaceArtifact {
  return { ...artifact, owner: { ...artifact.owner } };
}
