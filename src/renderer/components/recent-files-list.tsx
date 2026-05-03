import { FileSpreadsheet } from 'lucide-react';
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
    <div className="mt-1 grid gap-2 border-t pt-4">
      <p className="text-xs font-bold uppercase text-muted-foreground">Recent files</p>
      <div className="grid gap-2">
        {files.slice(0, 5).map((file) => (
          <button
            key={file.path}
            type="button"
            className="grid min-w-0 grid-cols-[28px_minmax(0,1fr)] items-center gap-3 rounded-md border bg-background px-3 py-2.5 text-left shadow-xs transition-[border-color,background-color,box-shadow] hover:border-ring/40 hover:bg-accent hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-60"
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
          </button>
        ))}
      </div>
    </div>
  );
}
