import { FileSpreadsheet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import type { RecentCsvFile } from '../../shared/ipc';
import { formatFileSize } from './csv-format';

export function RecentFilesList({
  files,
  disabled,
  onOpenRecent,
}: {
  files: RecentCsvFile[];
  disabled: boolean;
  onOpenRecent: (path: string) => void;
}) {
  return (
    <div className="mt-1 grid gap-3 pt-1">
      <Separator />
      <p className="text-xs font-bold uppercase text-muted-foreground">Recent files</p>
      <div className="grid gap-2">
        {files.slice(0, 5).map((file) => (
          <Button
            key={file.path}
            type="button"
            variant="outline"
            className="grid h-auto min-w-0 grid-cols-[28px_minmax(0,1fr)] items-center justify-start gap-3 px-3 py-2.5 text-left"
            disabled={disabled}
            onClick={() => onOpenRecent(file.path)}
            title={file.path}
          >
            <span className="grid size-7 place-items-center rounded-md bg-muted text-muted-foreground" aria-hidden="true">
              <FileSpreadsheet className="size-4" />
            </span>
            <span className="grid min-w-0 gap-0.5">
              <span className="truncate text-sm font-semibold text-foreground">{file.name}</span>
              <span className="truncate text-xs text-muted-foreground">
                {formatFileSize(file.sizeBytes)} - {file.path}
              </span>
            </span>
          </Button>
        ))}
      </div>
    </div>
  );
}
