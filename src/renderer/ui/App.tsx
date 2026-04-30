import { useEffect, useState } from 'react';
import type { CsvSessionMetadata, HealthStatus } from '../../shared/ipc';

type HealthState =
  | { status: 'checking' }
  | { status: 'healthy'; value: HealthStatus }
  | { status: 'failed'; message: string };

type OpenState =
  | { status: 'idle' }
  | { status: 'opening' }
  | { status: 'opened'; session: CsvSessionMetadata }
  | { status: 'failed'; message: string };

export function App() {
  const [health, setHealth] = useState<HealthState>({ status: 'checking' });
  const [openState, setOpenState] = useState<OpenState>({ status: 'idle' });

  useEffect(() => {
    let cancelled = false;

    window.csvViewer
      .healthCheck()
      .then((value) => {
        if (!cancelled) {
          setHealth({ status: 'healthy', value });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setHealth({
            status: 'failed',
            message: error instanceof Error ? error.message : 'Health check failed',
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  async function openCsv() {
    setOpenState({ status: 'opening' });

    try {
      const result = await window.csvViewer.openCsv();

      if (result.status === 'cancelled') {
        setOpenState((current) => (current.status === 'opening' ? { status: 'idle' } : current));
        return;
      }

      setOpenState({ status: 'opened', session: result.session });
    } catch (error: unknown) {
      setOpenState({
        status: 'failed',
        message: error instanceof Error ? error.message : 'Unable to open CSV.',
      });
    }
  }

  const isOpening = openState.status === 'opening';

  return (
    <main className="app-shell">
      <header className="top-bar">
        <div>
          <p className="eyebrow">Desktop CSV Viewer</p>
          <h1>CSV Viewer</h1>
        </div>
        <div className="top-bar__actions">
          <button type="button" onClick={openCsv} disabled={isOpening}>
            {isOpening ? 'Opening...' : 'Open CSV'}
          </button>
          <HealthBadge health={health} />
        </div>
      </header>

      {openState.status === 'opened' ? (
        <CsvMetadataView session={openState.session} />
      ) : (
        <section className="empty-state" aria-labelledby="empty-state-title">
          <div className="empty-state__icon" aria-hidden="true">
            CSV
          </div>
          <div className="empty-state__content">
            <h2 id="empty-state-title">No CSV open</h2>
            <p>
              Open a local CSV file to inspect its columns, row count, and data without loading the
              full file into the renderer.
            </p>
            <button type="button" onClick={openCsv} disabled={isOpening}>
              {isOpening ? 'Opening...' : 'Open CSV'}
            </button>
            {openState.status === 'failed' ? (
              <p className="error-message" role="alert">
                {openState.message}
              </p>
            ) : null}
          </div>
        </section>
      )}
    </main>
  );
}

function CsvMetadataView({ session }: { session: CsvSessionMetadata }) {
  return (
    <section className="metadata-view" aria-labelledby="metadata-title">
      <div className="metadata-view__summary">
        <div>
          <p className="eyebrow">Current file</p>
          <h2 id="metadata-title">{session.file.name}</h2>
        </div>
        <dl className="metadata-stats">
          <div>
            <dt>Rows</dt>
            <dd>{formatNumber(session.rowCount)}</dd>
          </div>
          <div>
            <dt>Columns</dt>
            <dd>{formatNumber(session.columns.length)}</dd>
          </div>
          <div>
            <dt>Size</dt>
            <dd>{formatFileSize(session.file.sizeBytes)}</dd>
          </div>
        </dl>
      </div>

      <div className="column-panel">
        <h3>Inferred columns</h3>
        <div className="column-table" role="table" aria-label="Inferred CSV columns">
          {session.columns.map((column) => (
            <div className="column-row" role="row" key={column.name}>
              <span role="cell">{column.name}</span>
              <span role="cell">{column.type}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function HealthBadge({ health }: { health: HealthState }) {
  if (health.status === 'checking') {
    return <span className="health-badge health-badge--pending">Checking IPC</span>;
  }

  if (health.status === 'failed') {
    return <span className="health-badge health-badge--failed">IPC unavailable</span>;
  }

  return (
    <span className="health-badge health-badge--healthy" title={health.value.timestamp}>
      Main process connected
    </span>
  );
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}
