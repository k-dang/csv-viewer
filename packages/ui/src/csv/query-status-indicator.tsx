import { useEffect, useState } from 'react';
import { CheckCircle2, CircleAlert, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export type QueryState = 'idle' | 'querying' | 'ready' | 'failed';

export const QUERYING_LABEL_DELAY_MS = 250;

const labels = {
  querying: { Icon: Loader2, text: 'Querying', className: 'text-sky-700 dark:text-sky-300', iconClassName: 'animate-spin' },
  failed: { Icon: CircleAlert, text: 'Query failed', className: 'text-destructive', iconClassName: '' },
  ready: { Icon: CheckCircle2, text: 'Ready', className: 'text-emerald-700 dark:text-emerald-400', iconClassName: '' },
};

/**
 * The query state of one CSV Tab, as a compact label for its status bar. Querying shows only once a
 * query outlasts `QUERYING_LABEL_DELAY_MS`, so typing a search does not blink; `data-query-status`
 * always carries the current state. Every state renders the same fixed-width polite live region.
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

  const { Icon, text, className, iconClassName } = labels[state === 'failed' || (state === 'querying' && slow) ? state : 'ready'];
  return (
    <span aria-live="polite" data-query-status={state} className={cn('flex w-24 shrink-0 items-center gap-1.5 font-medium', className)}>
      <Icon className={cn('size-3.5', iconClassName)} aria-hidden="true" />
      {text}
    </span>
  );
}
