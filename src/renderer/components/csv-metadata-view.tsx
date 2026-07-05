import { cn } from '@/lib/utils';
import { FieldError } from '@/components/ui/field';
import type { CsvSessionMetadata } from '../../shared/ipc';
import { CsvGrid } from './csv-grid';

export function CsvMetadataView({
  session,
  dialectError,
  themeMode,
  onDirtyChange,
}: {
  session: CsvSessionMetadata;
  dialectError: string | null;
  themeMode: 'light' | 'dark';
  onDirtyChange?: (dirty: boolean) => void;
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
        <FieldError className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 font-semibold">
          {dialectError}
        </FieldError>
      ) : null}

      <CsvGrid session={session} themeMode={themeMode} onDirtyChange={onDirtyChange} />
    </section>
  );
}
