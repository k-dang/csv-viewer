import { CheckCircle2, CircleAlert, Loader2 } from 'lucide-react';

export type QueryState = 'idle' | 'querying' | 'ready' | 'failed';

/** The query state of one CSV Tab, as a compact label for its status bar. */
export function QueryStatusIndicator({ state }: { state: QueryState }) {
  if (state === 'querying') {
    return (
      <span className="flex shrink-0 items-center gap-1.5 font-medium text-sky-700 dark:text-sky-300">
        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
        Querying
      </span>
    );
  }

  if (state === 'failed') {
    return (
      <span className="flex shrink-0 items-center gap-1.5 font-medium text-destructive">
        <CircleAlert className="size-3.5" aria-hidden="true" />
        Query failed
      </span>
    );
  }

  return (
    <span className="flex shrink-0 items-center gap-1.5 font-medium text-emerald-700 dark:text-emerald-400">
      <CheckCircle2 className="size-3.5" aria-hidden="true" />
      Ready
    </span>
  );
}
