import { useEffect, useState } from 'react';
import { FileSpreadsheet, FolderOpen, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldGroup, FieldTitle } from '@/components/ui/field';
import type { CsvSourceId, RecentCsvSource } from '../../shared/csv-viewer-contract';
import { RecentCsvSourceList } from './recent-csv-source-list';
import { useCsvViewer } from '../csv-viewer';

export function EmptyCsvState({
  isOpening,
  errorMessage,
  dialectError,
  onOpenCsv,
  onOpenRecent,
}: {
  isOpening: boolean;
  errorMessage: string | null;
  dialectError: string | null;
  onOpenCsv: () => void;
  onOpenRecent: (sourceId: CsvSourceId) => void;
}) {
  const viewer = useCsvViewer();
  const [recentSources, setRecentSources] = useState<RecentCsvSource[]>([]);

  // A runtime without durable CSV Source identity cannot reopen anything, so the list is neither
  // requested nor offered. Each finished open attempt refreshes it, so a CSV Source that has since
  // become unreachable drops off the list rather than lingering as a broken choice.
  useEffect(() => {
    if (!viewer.capabilities.recentCsvSources || isOpening) return;
    let cancelled = false;
    viewer
      .call({ operation: 'csv.get-recent-sources' })
      .then((sources) => {
        if (!cancelled) setRecentSources(sources);
      })
      .catch(() => {
        if (!cancelled) setRecentSources([]);
      });
    return () => {
      cancelled = true;
    };
  }, [viewer, isOpening]);

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
        {recentSources.length > 0 ? (
          <RecentCsvSourceList sources={recentSources} disabled={isOpening} onOpenRecent={onOpenRecent} />
        ) : null}
      </FieldGroup>
    </section>
  );
}
