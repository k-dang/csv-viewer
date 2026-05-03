import { CheckCircle2, CircleAlert, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { HealthStatus } from '../../shared/ipc';

export type HealthState =
  | { status: 'checking' }
  | { status: 'healthy'; value: HealthStatus }
  | { status: 'failed'; message: string };

export function HealthBadge({ health }: { health: HealthState }) {
  const baseClassName =
    'shrink-0 rounded-full border px-3 py-[7px] text-[13px] font-semibold';

  if (health.status === 'checking') {
    return (
      <span className={cn(baseClassName, 'border-amber-200 bg-amber-50 text-amber-900')}>
        <Loader2 className="mr-1.5 inline size-3.5 animate-spin align-[-2px]" />
        Checking IPC
      </span>
    );
  }

  if (health.status === 'failed') {
    return (
      <span className={cn(baseClassName, 'border-rose-200 bg-rose-50 text-rose-800')}>
        <CircleAlert className="mr-1.5 inline size-3.5 align-[-2px]" />
        IPC unavailable
      </span>
    );
  }

  return (
    <span
      className={cn(baseClassName, 'border-emerald-200 bg-emerald-50 text-emerald-800')}
      title={health.value.timestamp}
    >
      <CheckCircle2 className="mr-1.5 inline size-3.5 align-[-2px]" />
      Main process connected
    </span>
  );
}
