import { useEffect, useState } from 'react';
import { BarChart3, Loader2, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { FieldError } from '@/components/ui/field';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type {
  CsvColumnValueCounts,
  CsvFilterDescriptor,
  CsvSessionMetadata,
} from '../../shared/ipc';
import { formatCellValue, formatNumber } from './csv-format';

type StatsState =
  | { status: 'loading' }
  | { status: 'ready'; counts: CsvColumnValueCounts }
  | { status: 'failed'; message: string };

export function CsvStatsPanel({
  session,
  selectedColumn,
  filters,
  search,
  refreshKey,
  onColumnChange,
  onClose,
}: {
  session: CsvSessionMetadata;
  selectedColumn: string;
  filters: CsvFilterDescriptor[];
  search: string;
  refreshKey: number;
  onColumnChange: (column: string) => void;
  onClose: () => void;
}) {
  const [statsState, setStatsState] = useState<StatsState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;

    setStatsState({ status: 'loading' });
    window.csvViewer
      .getCsvColumnValueCounts({
        sessionId: session.sessionId,
        column: selectedColumn,
        filters,
        search,
      })
      .then((counts) => {
        if (!cancelled) {
          setStatsState({ status: 'ready', counts });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setStatsState({
            status: 'failed',
            message: error instanceof Error ? error.message : 'Unable to calculate column value counts.',
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [session.sessionId, selectedColumn, filters, search, refreshKey]);

  return (
    <aside className="grid min-h-0 w-full min-w-0 grid-rows-[auto_1fr] border-l bg-card md:w-[320px]" aria-label="Stats Panel">
      <div className="border-b px-4 py-3">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <BarChart3 className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <h3 className="truncate text-sm font-semibold text-foreground">Column Value Counts</h3>
          </div>
          <Button type="button" variant="ghost" size="icon" onClick={onClose} title="Close stats panel" aria-label="Close stats panel">
            <X />
          </Button>
        </div>

        <Label className="mb-1.5 text-xs text-muted-foreground" htmlFor="stats-column">
          Stats Column
        </Label>
        <Select value={selectedColumn} onValueChange={onColumnChange}>
          <SelectTrigger id="stats-column" className="w-full min-w-0 bg-card">
            <SelectValue placeholder="Select a column" />
          </SelectTrigger>
          <SelectContent>
            {session.columns.map((column) => (
              <SelectItem key={column.name} value={column.name}>
                {column.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <ScrollArea className="min-h-0">
        <div className="px-4 py-3">
          {statsState.status === 'loading' ? (
            <div className="flex min-h-[160px] items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              Calculating counts
            </div>
          ) : null}

          {statsState.status === 'failed' ? (
            <FieldError className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 font-medium">
              {statsState.message}
            </FieldError>
          ) : null}

          {statsState.status === 'ready' ? (
            <ColumnValueCountsList counts={statsState.counts} />
          ) : null}
        </div>
      </ScrollArea>
    </aside>
  );
}

function ColumnValueCountsList({ counts }: { counts: CsvColumnValueCounts }) {
  if (counts.scopeRowCount === 0) {
    return (
      <div className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
        No rows in the current count scope.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="font-medium text-foreground">{formatNumber(counts.scopeRowCount)} scoped rows</span>
        <Badge variant="secondary">Top {formatNumber(counts.values.length)}</Badge>
      </div>

      <Card className="gap-0 overflow-hidden rounded-md py-0 shadow-none">
        {counts.values.map((value) => (
          <CardContent key={`${value.value ?? '<null>'}:${value.count}`} className="grid grid-cols-[1fr_auto] gap-3 border-b px-3 py-2 last:border-b-0">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-foreground" title={formatStatsValue(value.value)}>
                {formatStatsValue(value.value)}
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(0, Math.min(100, value.percentOfScope))}%` }} />
              </div>
            </div>
            <div className="text-right">
              <div className="text-sm font-semibold text-foreground">{formatNumber(value.count)}</div>
              <div className="text-xs text-muted-foreground">{formatPercent(value.percentOfScope)}</div>
            </div>
          </CardContent>
        ))}
      </Card>
    </div>
  );
}

function formatStatsValue(value: string | null): string {
  if (value === null) {
    return '(null)';
  }

  if (value === '') {
    return '(blank)';
  }

  return formatCellValue(value);
}

function formatPercent(value: number): string {
  return `${value.toFixed(value >= 10 ? 1 : 2)}%`;
}
