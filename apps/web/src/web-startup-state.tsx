import { AlertTriangle, Loader2, MonitorDown } from 'lucide-react';

export function WebStartupState({ status }: { status: 'checking' | 'unsupported' | 'failed' }) {
  const copy = startupCopy(status);
  const checking = status === 'checking';
  return (
    <main className="grid min-h-screen place-items-center bg-background p-6 text-foreground">
      <section className="grid w-full max-w-xl gap-5 rounded-xl border bg-card p-7 shadow-sm" aria-live="polite">
        <div
          className="grid size-11 place-items-center rounded-lg border border-primary/15 bg-primary text-primary-foreground"
          aria-hidden="true"
        >
          {checking ? <Loader2 className="animate-spin" /> : <AlertTriangle />}
        </div>
        <div className="grid gap-2">
          <p className="text-xs font-bold uppercase text-muted-foreground">CSV Viewer Web</p>
          <h1 className="text-2xl font-semibold">{copy.title}</h1>
          <p className="leading-relaxed text-muted-foreground">{copy.detail}</p>
        </div>
        {status === 'failed' ? (
          <button
            type="button"
            className="w-fit rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
            onClick={() => window.location.reload()}
          >
            Reload CSV Viewer
          </button>
        ) : null}
        {status === 'unsupported' ? (
          <div className="flex items-start gap-3 rounded-lg border bg-muted/45 p-4">
            <MonitorDown className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
            <p className="text-sm leading-relaxed">
              You can use CSV Viewer Desktop on this computer instead.
            </p>
          </div>
        ) : null}
      </section>
    </main>
  );
}

function startupCopy(status: 'checking' | 'unsupported' | 'failed') {
  switch (status) {
    case 'checking':
      return {
        title: 'Checking browser support',
        detail: 'CSV Viewer is starting its local data engine. CSV Source selection stays disabled until this check finishes.',
      };
    case 'unsupported':
      return {
        title: 'This browser cannot start CSV Viewer Web',
        detail: 'CSV Viewer Web supports current versions of Chrome, Edge, Firefox, and Safari. Your CSV Sources have not been opened or uploaded.',
      };
    case 'failed':
      return {
        title: 'CSV Viewer could not start',
        detail: 'Reload the page to try again. Your CSV Sources have not been opened or uploaded.',
      };
    default: {
      const unexpected: never = status;
      return unexpected;
    }
  }
}
