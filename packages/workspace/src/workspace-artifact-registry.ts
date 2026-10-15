import { Effect, SynchronizedRef } from 'effect';
import type {
  ComparisonId,
  ComparisonOperationId,
  WorkingCsvId,
} from './csv-viewer';

export type WorkspaceArtifactOwner =
  | { kind: 'working-csv'; workingCsvId: WorkingCsvId }
  | { kind: 'comparison'; comparisonId: ComparisonId; operationId: ComparisonOperationId };

export type WorkspaceArtifactRole = 'current' | 'staging' | 'active' | 'retired';

export type WorkspaceArtifact = {
  tableName: string;
  owner: WorkspaceArtifactOwner;
  role: WorkspaceArtifactRole;
};

type ArtifactDocuments = ReadonlyMap<string, WorkspaceArtifact>;

export class WorkspaceArtifactRegistry {
  private readonly artifacts: SynchronizedRef.SynchronizedRef<ArtifactDocuments>;

  constructor() {
    this.artifacts = Effect.runSync(SynchronizedRef.make<ArtifactDocuments>(new Map()));
  }

  private get documents(): ArtifactDocuments {
    return SynchronizedRef.getUnsafe(this.artifacts);
  }

  private modify<A>(next: (artifacts: ArtifactDocuments) => readonly [A, ArtifactDocuments]): A {
    return Effect.runSync(SynchronizedRef.modify(this.artifacts, (artifacts) => {
      const [value, documents] = next(artifacts);
      return [value, documents];
    }));
  }

  register(artifact: WorkspaceArtifact): void {
    const stored = cloneArtifact(artifact);
    const duplicate = this.modify((artifacts) => {
      if (artifacts.has(stored.tableName)) return [true, artifacts] as const;
      const next = new Map(artifacts);
      next.set(stored.tableName, stored);
      return [false, next] as const;
    });
    if (duplicate) throw new Error(`Workspace artifact ${stored.tableName} is already registered.`);
  }

  transition(tableName: string, role: WorkspaceArtifactRole): void {
    this.replace(tableName, (artifact, artifacts) => {
      const next = new Map(artifacts);
      next.set(tableName, { ...artifact, role });
      return next;
    });
  }

  remove(tableName: string): void {
    this.replace(tableName, (_artifact, artifacts) => {
      const next = new Map(artifacts);
      next.delete(tableName);
      return next;
    });
  }

  get(tableName: string): WorkspaceArtifact | null {
    const artifact = this.documents.get(tableName);
    return artifact ? cloneArtifact(artifact) : null;
  }

  list(): WorkspaceArtifact[] {
    return [...this.documents.values()].map(cloneArtifact);
  }

  assertNoArtifactsOwnedBy(kind: WorkspaceArtifactOwner['kind']): void {
    if (this.list().some((artifact) => artifact.owner.kind === kind)) {
      throw new Error(`Workspace artifact invariant violated: ${kind} artifacts remain.`);
    }
  }

  assertEmpty(): void {
    if (this.documents.size > 0) {
      throw new Error('Workspace artifact invariant violated: registered artifacts remain.');
    }
  }

  private replace(
    tableName: string,
    change: (artifact: WorkspaceArtifact, artifacts: ArtifactDocuments) => ArtifactDocuments,
  ): void {
    const missing = this.modify((artifacts) => {
      const artifact = artifacts.get(tableName);
      if (!artifact) return [true, artifacts] as const;
      return [false, change(artifact, artifacts)] as const;
    });
    if (missing) throw new Error(`Workspace artifact ${tableName} is not registered.`);
  }
}

function cloneArtifact(artifact: WorkspaceArtifact): WorkspaceArtifact {
  return { ...artifact, owner: { ...artifact.owner } };
}
