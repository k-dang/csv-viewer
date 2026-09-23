import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { isCsvHeaderMode, type CsvHeaderMode } from './csv-dialect';

const headerModeLabels = {
  auto: 'Auto',
  yes: 'First row',
  no: 'None',
} satisfies Record<CsvHeaderMode, string>;

export type DialectControlsProps = {
  delimiter: string;
  headerMode: CsvHeaderMode;
  onDelimiterChange: (value: string) => void;
  onHeaderModeChange: (value: CsvHeaderMode) => void;
};

/** Parse options for the next open, as two labeled compact controls stacked in the Parse options popover. */
export function DialectControls({ delimiter, headerMode, onDelimiterChange, onHeaderModeChange }: DialectControlsProps) {
  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-1.5">
        <Label htmlFor="csv-delimiter" className="text-xs text-muted-foreground">
          Delimiter
        </Label>
        <Input
          id="csv-delimiter"
          className="h-8 w-16 bg-card text-center font-mono"
          value={delimiter}
          maxLength={2}
          onChange={(event) => onDelimiterChange(event.target.value)}
          placeholder="Auto"
          title="Delimiter override"
        />
      </div>
      <div className="flex items-center justify-between gap-1.5">
        <Label htmlFor="csv-header-mode" className="text-xs text-muted-foreground">
          Headers
        </Label>
        <Select
          value={headerMode}
          onValueChange={(value) => {
            if (value !== null && isCsvHeaderMode(value)) onHeaderModeChange(value);
          }}
        >
          <SelectTrigger id="csv-header-mode" size="sm" className="w-[104px] bg-card" title="Header handling">
            <SelectValue>{headerModeLabels[headerMode]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">Auto</SelectItem>
            <SelectItem value="yes">First row</SelectItem>
            <SelectItem value="no">None</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
