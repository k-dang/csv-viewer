import { CheckCircle2, CircleAlert, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export type QueryState = 'idle' | 'querying' | 'ready' | 'failed';

export function QueryStatusBadge({ state }: { state: QueryState }) {
  const baseClassName = 'h-9 shrink-0 gap-1.5 px-3 text-[13px] font-semibold';

  if (state === 'querying') {
    return (
      <Badge variant="outline" className={cn(baseClassName, 'border-sky-200 bg-sky-50 text-sky-900')}>
        <Loader2 className="size-3.5 animate-spin" />
        Querying
      </Badge>
    );
  }

  if (state === 'failed') {
    return (
      <Badge variant="outline" className={cn(baseClassName, 'border-rose-200 bg-rose-50 text-rose-800')}>
        <CircleAlert className="size-3.5" />
        Query failed
      </Badge>
    );
  }

  return (
    <Badge variant="outline" className={cn(baseClassName, 'border-emerald-200 bg-emerald-50 text-emerald-800')}>
      <CheckCircle2 className="size-3.5" />
      Ready
    </Badge>
  );
}
