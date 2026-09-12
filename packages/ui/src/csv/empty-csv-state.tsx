import { FileSpreadsheet, FolderOpen, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldGroup, FieldTitle } from '@/components/ui/field';
import type { CsvSourceId, RecentCsvSource } from '@csv-viewer/workspace/csv-viewer';
import { RecentCsvSourceList } from './recent-csv-source-list';
import { useCsvViewer } from '../app/csv-viewer';

export function EmptyCsvState({
  recentSources,
  isOpening,
  errorMessage,
  dialectError,
  onOpenCsv,
  onOpenRecent,
}: {
  recentSources: RecentCsvSource[];
  isOpening: boolean;
  errorMessage: string | null;
  dialectError: string | null;
  onOpenCsv: () => void;
  onOpenRecent: (sourceId: CsvSourceId) => void;
}) {
  const viewer = useCsvViewer();

  return (
    <section
      className="grid w-[min(440px,calc(100vw_-_32px))] grid-cols-1 items-center gap-6 self-center justify-self-center rounded-lg border bg-card/95 p-6 shadow-sm md:w-[min(680px,calc(100vw_-_48px))] md:grid-cols-[104px_minmax(0,1fr)] md:p-8"
      aria-labelledby="empty-state-title"
    >
      <div
        className="grid size-24 place-items-center rounded-lg border border-teal-200 bg-teal-50 text-teal-700 shadow-inner"
        aria-hidden="true"
      >
        <FileSpreadsheet className="size-11" />
      </div>
      <FieldGroup className="min-w-0 gap-3.5">
        <Field>
          <FieldTitle id="empty-state-title" className="text-[28px] leading-none font-semibold text-foreground">
            No CSV open
          </FieldTitle>
          <FieldDescription className="max-w-[46ch] text-[15px] leading-relaxed">
            Open a local CSV Source to inspect, query, edit, and compare its data. All processing stays on this device.
          </FieldDescription>
          {!viewer.capabilities.recentCsvSources ? (
            <FieldDescription className="max-w-[46ch] text-sm leading-relaxed">
              Select your CSV Sources again after reload.
            </FieldDescription>
          ) : null}
        </Field>
        <Button className="w-fit" type="button" onClick={onOpenCsv} disabled={isOpening}>
          {isOpening ? <Loader2 className="animate-spin" /> : <FolderOpen />}
          {isOpening ? 'Opening...' : 'Open CSV'}
        </Button>
        <FieldError>{errorMessage}</FieldError>
        <FieldError>{dialectError}</FieldError>
        {viewer.capabilities.recentCsvSources && recentSources.length > 0 ? (
          <RecentCsvSourceList sources={recentSources} disabled={isOpening} onOpenRecent={onOpenRecent} />
        ) : null}
      </FieldGroup>
    </section>
  );
}
