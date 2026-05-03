import { FileSpreadsheet, FolderOpen, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { RecentCsvFile } from '../../shared/ipc';
import { RecentFilesList } from './recent-files-list';

export function EmptyCsvState({
  isOpening,
  errorMessage,
  dialectError,
  recentFiles,
  onOpenCsv,
  onOpenRecent,
}: {
  isOpening: boolean;
  errorMessage: string | null;
  dialectError: string | null;
  recentFiles: RecentCsvFile[];
  onOpenCsv: () => void;
  onOpenRecent: (path: string) => void;
}) {
  return (
    <section
      className="grid w-[min(440px,calc(100vw_-_32px))] grid-cols-1 items-center gap-6 self-center justify-self-center rounded-lg border bg-card/95 p-6 shadow-[0_24px_70px_rgba(15,23,42,0.12)] md:w-[min(680px,calc(100vw_-_48px))] md:grid-cols-[104px_minmax(0,1fr)] md:p-8"
      aria-labelledby="empty-state-title"
    >
      <div
        className="grid size-24 place-items-center rounded-lg border border-teal-200 bg-teal-50 text-teal-700 shadow-inner"
        aria-hidden="true"
      >
        <FileSpreadsheet className="size-11" />
      </div>
      <div className="grid min-w-0 gap-3.5">
        <h2 id="empty-state-title" className="text-[28px] leading-none font-semibold text-foreground">
          No CSV open
        </h2>
        <p className="max-w-[46ch] text-[15px] leading-relaxed text-muted-foreground">
          Open a local CSV file to inspect its columns, row count, and data without loading the
          full file into the renderer.
        </p>
        <Button className="w-fit" type="button" onClick={onOpenCsv} disabled={isOpening}>
          {isOpening ? <Loader2 className="animate-spin" /> : <FolderOpen />}
          {isOpening ? 'Opening...' : 'Open CSV'}
        </Button>
        {errorMessage ? (
          <p className="font-semibold text-destructive" role="alert">
            {errorMessage}
          </p>
        ) : null}
        {dialectError ? (
          <p className="font-semibold text-destructive" role="alert">
            {dialectError}
          </p>
        ) : null}
        {recentFiles.length > 0 ? (
          <RecentFilesList files={recentFiles} disabled={isOpening} onOpenRecent={onOpenRecent} />
        ) : null}
      </div>
    </section>
  );
}
