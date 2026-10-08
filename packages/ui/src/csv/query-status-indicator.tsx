import { useEffect, useState } from 'react';
import { CheckCircle2, CircleAlert, Loader2 } from 'lucide-react';

export type QueryState = 'idle' | 'querying' | 'ready' | 'failed';

export const QUERYING_LABEL_DELAY_MS = 250;

/**
 * The query state of one CSV Tab, as a compact label for its status bar. Querying shows only once a
 * query outlasts `QUERYING_LABEL_DELAY_MS`, so typing a search does not blink; `data-query-status`
 * always carries the current state. Every branch renders the same fixed-width polite live region.
 */
export function QueryStatusIndicator({ state }: { state: QueryState }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (state !== 'querying') return;
    const timer = setTimeout(() => setSlow(true), QUERYING_LABEL_DELAY_MS);
    return () => {
      clearTimeout(timer);
      setSlow(false);
    };
  }, [state]);

  const shown = state === 'querying' && !slow ? 'ready' : state;
  const className = 'flex w-24 shrink-0 items-center gap-1.5 font-medium';

  if (shown === 'querying') {
    return (
      <span aria-live="polite" data-query-status={state} className={`${className} text-sky-700 dark:text-sky-300`}>
        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
        Querying
      </span>
    );
  }

  if (shown === 'failed') {
    return (
      <span aria-live="polite" data-query-status={state} className={`${className} text-destructive`}>
        <CircleAlert className="size-3.5" aria-hidden="true" />
        Query failed
      </span>
    );
  }

  return (
    <span aria-live="polite" data-query-status={state} className={`${className} text-emerald-700 dark:text-emerald-400`}>
      <CheckCircle2 className="size-3.5" aria-hidden="true" />
      Ready
    </span>
  );
}
