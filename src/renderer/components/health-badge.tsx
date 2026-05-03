import { CheckCircle2, CircleAlert, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { HealthStatus } from '../../shared/ipc';

export type HealthState =
  | { status: 'checking' }
  | { status: 'healthy'; value: HealthStatus }
  | { status: 'failed'; message: string };

export function HealthBadge({ health }: { health: HealthState }) {
  const baseClassName = 'h-9 shrink-0 gap-1.5 px-3 text-[13px] font-semibold';

  if (health.status === 'checking') {
    return (
      <Badge variant="outline" className={cn(baseClassName, 'border-amber-200 bg-amber-50 text-amber-900')}>
        <Loader2 className="size-3.5 animate-spin" />
        Checking IPC
      </Badge>
    );
  }

  if (health.status === 'failed') {
    return (
      <Badge variant="outline" className={cn(baseClassName, 'border-rose-200 bg-rose-50 text-rose-800')}>
        <CircleAlert className="size-3.5" />
        IPC unavailable
      </Badge>
    );
  }

  return (
    <Badge
      variant="outline"
      className={cn(baseClassName, 'border-emerald-200 bg-emerald-50 text-emerald-800')}
      title={health.value.timestamp}
    >
      <CheckCircle2 className="size-3.5" />
      Main process connected
    </Badge>
  );
}
