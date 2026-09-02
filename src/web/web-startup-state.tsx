import { AlertTriangle, Loader2, MonitorDown } from 'lucide-react';

export function WebStartupState({ status }: { status: 'checking' | 'unsupported' }) {
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
          <h1 className="text-2xl font-semibold">
            {checking ? 'Checking browser support' : 'This browser cannot start CSV Viewer Web'}
          </h1>
          <p className="leading-relaxed text-muted-foreground">
            {checking
              ? 'CSV Viewer is starting its local data engine. CSV Source selection stays disabled until this check finishes.'
              : 'CSV Viewer Web supports current versions of Chrome, Edge, Firefox, and Safari. Your CSV Sources have not been opened or uploaded.'}
          </p>
        </div>
        {!checking ? (
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
