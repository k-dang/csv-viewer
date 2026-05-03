import { cn } from '@/lib/utils';
import type { CsvSessionMetadata } from '../../shared/ipc';
import { CsvGrid } from './csv-grid';

export function CsvMetadataView({
  session,
  dialectError,
}: {
  session: CsvSessionMetadata;
  dialectError: string | null;
}) {
  return (
    <section
      className={cn(
        'grid min-h-0 min-w-0 gap-3 p-3 md:p-4',
        dialectError ? 'grid-rows-[auto_1fr]' : 'grid-rows-[1fr]',
      )}
      aria-labelledby="metadata-title"
    >
      {dialectError ? (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm font-semibold text-destructive" role="alert">
          {dialectError}
        </p>
      ) : null}

      <CsvGrid session={session} />
    </section>
  );
}
