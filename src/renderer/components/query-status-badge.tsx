import { CheckCircle2, CircleAlert, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export type QueryState = 'idle' | 'querying' | 'ready' | 'failed';

export function QueryStatusBadge({ state }: { state: QueryState }) {
  const baseClassName = 'h-9 shrink-0 rounded-full border px-3 text-[13px] font-semibold leading-9';

  if (state === 'querying') {
    return (
      <span className={cn(baseClassName, 'border-sky-200 bg-sky-50 text-sky-900')}>
        <Loader2 className="mr-1.5 inline size-3.5 animate-spin align-[-2px]" />
        Querying
      </span>
    );
  }

  if (state === 'failed') {
    return (
      <span className={cn(baseClassName, 'border-rose-200 bg-rose-50 text-rose-800')}>
        <CircleAlert className="mr-1.5 inline size-3.5 align-[-2px]" />
        Query failed
      </span>
    );
  }

  return (
    <span className={cn(baseClassName, 'border-emerald-200 bg-emerald-50 text-emerald-800')}>
      <CheckCircle2 className="mr-1.5 inline size-3.5 align-[-2px]" />
      Ready
    </span>
  );
}
