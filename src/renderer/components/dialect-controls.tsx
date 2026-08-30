import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { isCsvHeaderMode, type CsvHeaderMode } from './csv-dialect';

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
      <Input
        id="csv-delimiter"
        className="w-24 bg-card"
        value={delimiter}
        maxLength={2}
        onChange={(event) => onDelimiterChange(event.target.value)}
        placeholder="Auto"
        title="Delimiter override"
      />
      <label className="sr-only" htmlFor="csv-header-mode">
        Header mode
      </label>
      <Select
        value={headerMode}
        onValueChange={(value) => {
          if (isCsvHeaderMode(value)) onHeaderModeChange(value);
        }}
      >
        <SelectTrigger id="csv-header-mode" className="w-[158px] bg-card" title="Header handling">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="auto">Auto header</SelectItem>
          <SelectItem value="yes">First row headers</SelectItem>
          <SelectItem value="no">No headers</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
