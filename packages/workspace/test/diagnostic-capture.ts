import { Logger } from 'effect';

type DiagnosticRecord = ReturnType<typeof Logger.formatStructured.log>;

/** Captures workspace diagnostics as structured records and as the logfmt text a console would print. */
export function diagnosticCapture(onRecord?: (record: DiagnosticRecord) => void) {
  const logs: string[] = [];
  const records: DiagnosticRecord[] = [];
  const completed = (from = 0) => records.slice(from).filter((record) => record.annotations.outcome !== 'started');
  return {
    logs, records,
    configuration: { logger: Logger.make((options) => {
      logs.push(Logger.formatLogFmt.log(options));
      const record = Logger.formatStructured.log(options);
      records.push(record);
      onRecord?.(record);
    }) },
    /** Completion records, optionally only those logged after the first `from` records. */
    completed,
    /** The outcome of the first completion record for `stage`. */
    outcome: (stage: string) => completed().find((record) => record.message === stage)?.annotations.outcome,
  };
}
