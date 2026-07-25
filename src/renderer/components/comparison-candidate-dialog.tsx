import { useEffect, useRef } from 'react';
import { ArrowLeftRight, FileSpreadsheet, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ComparisonCandidate, CsvSessionMetadata } from '../../shared/ipc';

export function ComparisonCandidateDialog({
  baseline,
  candidates,
  onChoose,
  onClose,
}: {
  baseline: CsvSessionMetadata;
  candidates: ComparisonCandidate[];
  onChoose: (candidateId: string) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const focusable = () => [
      ...(dialog?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ) ?? []),
    ];
    focusable()[0]?.focus();
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const controls = focusable();
      if (controls.length === 0) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previouslyFocused?.focus();
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-slate-950/45 p-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="comparison-candidate-title"
        className="flex max-h-[min(680px,90vh)] w-full max-w-2xl flex-col overflow-hidden rounded-xl border bg-background shadow-2xl"
      >
        <header className="flex items-start justify-between gap-4 border-b p-5">
          <div>
            <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
              Baseline · {baseline.file.name}
            </p>
            <h2 id="comparison-candidate-title" className="mt-1 text-xl font-semibold">
              Choose a Candidate
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Comparison uses the complete Working CSV, including unsaved edits.
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Close Candidate picker"
            onClick={onClose}
          >
            <X />
          </Button>
        </header>
        <div className="overflow-y-auto p-3">
          {candidates.map((candidate) => {
            const compatibility = candidate.compatibility;
            const compatible = compatibility.kind === 'compatible';
            const explanation =
              compatibility.kind === 'compatible'
                ? 'Comparison-Compatible'
                : [
                    compatibility.missingFromBaseline.length > 0
                      ? `Missing from Baseline: ${compatibility.missingFromBaseline.join(', ')}`
                      : null,
                    compatibility.missingFromCandidate.length > 0
                      ? `Missing from Candidate: ${compatibility.missingFromCandidate.join(', ')}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ');
            return (
              <button
                key={candidate.workingCsv.sessionId}
                type="button"
                aria-disabled={!compatible}
                onClick={() => {
                  if (compatible) onChoose(candidate.workingCsv.sessionId);
                }}
                className="mb-2 flex w-full items-center gap-3 rounded-lg border p-3 text-left transition hover:border-primary/50 hover:bg-muted/50 aria-disabled:cursor-not-allowed aria-disabled:opacity-55"
              >
                <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted">
                  <FileSpreadsheet className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold">
                    {candidate.workingCsv.file.name}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {candidate.workingCsv.file.path}
                  </span>
                  <span
                    className={
                      compatible
                        ? 'text-xs font-medium text-emerald-700 dark:text-emerald-400'
                        : 'text-xs text-destructive'
                    }
                  >
                    {explanation}
                  </span>
                </span>
                {compatible ? (
                  <ArrowLeftRight className="size-4 shrink-0 text-muted-foreground" />
                ) : null}
              </button>
            );
          })}
        </div>
        <footer className="border-t p-3 text-right">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
        </footer>
      </section>
    </div>
  );
}
