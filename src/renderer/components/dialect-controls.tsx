import { cn } from '@/lib/utils';
import type { CsvHeaderMode } from './csv-dialect';

const formControlClassName =
  'h-9 rounded-md border border-input bg-card px-3 text-sm text-foreground shadow-xs outline-none transition-[border-color,box-shadow,background-color] placeholder:text-muted-foreground/80 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/25';

export function DialectControls({
  delimiter,
  headerMode,
  onDelimiterChange,
  onHeaderModeChange,
}: {
  delimiter: string;
  headerMode: CsvHeaderMode;
  onDelimiterChange: (value: string) => void;
  onHeaderModeChange: (value: CsvHeaderMode) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
      <label className="sr-only" htmlFor="csv-delimiter">
        Delimiter
      </label>
      <input
        id="csv-delimiter"
        className={cn(formControlClassName, 'w-24')}
        value={delimiter}
        maxLength={2}
        onChange={(event) => onDelimiterChange(event.target.value)}
        placeholder="Auto"
        title="Delimiter override"
      />
      <label className="sr-only" htmlFor="csv-header-mode">
        Header mode
      </label>
      <select
        id="csv-header-mode"
        className={formControlClassName}
        value={headerMode}
        onChange={(event) => onHeaderModeChange(event.target.value as CsvHeaderMode)}
        title="Header handling"
      >
        <option value="auto">Auto header</option>
        <option value="yes">First row headers</option>
        <option value="no">No headers</option>
      </select>
    </div>
  );
}

export { formControlClassName };
