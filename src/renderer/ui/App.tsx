import { useEffect, useState } from 'react';
import type { HealthStatus } from '../../shared/ipc';

type HealthState =
  | { status: 'checking' }
  | { status: 'healthy'; value: HealthStatus }
  | { status: 'failed'; message: string };

export function App() {
  const [health, setHealth] = useState<HealthState>({ status: 'checking' });

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

  return (
    <main className="app-shell">
      <header className="top-bar">
        <div>
          <p className="eyebrow">Desktop CSV Viewer</p>
          <h1>CSV Viewer</h1>
        </div>
        <HealthBadge health={health} />
      </header>

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
          <button type="button" disabled>
            Open CSV
          </button>
        </div>
      </section>
    </main>
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
