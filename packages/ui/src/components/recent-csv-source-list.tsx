import { FileSpreadsheet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import type { CsvSourceId, RecentCsvSource } from '@csv-viewer/workspace/csv-viewer';
import { formatFileSize } from './csv-format';

export function RecentCsvSourceList({
  sources,
  disabled,
  onOpenRecent,
}: {
  sources: RecentCsvSource[];
  disabled: boolean;
  onOpenRecent: (sourceId: CsvSourceId) => void;
}) {
  return (
    <div className="mt-1 grid gap-3 pt-1">
      <Separator />
      <p className="text-xs font-bold uppercase text-muted-foreground">Recent CSV Sources</p>
      <div className="grid gap-2">
        {sources.slice(0, 5).map((source) => (
          <Button
            key={source.sourceId}
            type="button"
            variant="outline"
            className="grid h-auto min-w-0 grid-cols-[28px_minmax(0,1fr)] items-center justify-start gap-3 px-3 py-2.5 text-left"
            disabled={disabled}
            onClick={() => onOpenRecent(source.sourceId)}
            title={source.location}
          >
            <span className="grid size-7 place-items-center rounded-md bg-muted text-muted-foreground" aria-hidden="true">
              <FileSpreadsheet className="size-4" />
            </span>
            <span className="grid min-w-0 gap-0.5">
              <span className="truncate text-sm font-semibold text-foreground">{source.name}</span>
              <span className="truncate text-xs text-muted-foreground">
                {formatFileSize(source.sizeBytes)} - {source.location}
              </span>
            </span>
          </Button>
        ))}
      </div>
    </div>
  );
}
