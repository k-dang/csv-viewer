import type { ReactNode } from 'react';
import { ChevronDown, Moon, Palette, Sun } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { DialectControls, type DialectControlsProps } from '@/csv/dialect-controls';
import { themePalettes, type ThemeMode, type ThemePalette } from './theme';

/** The one workspace-wide command. Per-file commands live in each CSV Tab's toolbar. */
export type OpenCsvAction = {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  disabled: boolean;
};

/**
 * Open CSV as a split button: the main part opens a CSV Source, and the chevron shows the parse
 * options that apply to the next open or reopen. A dot marks parse options that differ from Auto.
 */
export function OpenCsvControl({
  action,
  dialect,
  compact = false,
  className,
}: {
  action: OpenCsvAction;
  dialect: DialectControlsProps;
  /** Icon only, for a collapsed sidebar. The parse options stay reachable when it expands. */
  compact?: boolean;
  className?: string;
}) {
  const customized = dialect.delimiter !== '' || dialect.headerMode !== 'auto';
  if (compact) {
    return (
      <Button
        type="button"
        size="icon"
        onClick={action.onClick}
        disabled={action.disabled}
        title={action.label}
        aria-label={action.label}
        className={className}
      >
        {action.icon}
      </Button>
    );
  }
  return (
    <div className={cn('flex min-w-0', className)}>
      <Button
        type="button"
        size="sm"
        className="min-w-0 flex-1 rounded-r-none"
        onClick={action.onClick}
        disabled={action.disabled}
      >
        {action.icon}
        {action.label}
      </Button>
      <Popover>
        <PopoverTrigger
          className={cn(
            buttonVariants({ size: 'icon-sm' }),
            'relative rounded-l-none border-l border-l-primary-foreground/25',
          )}
          aria-label="Parse options"
          title="Parse options"
        >
          <ChevronDown />
          {customized ? (
            <span className="absolute top-1 right-1 size-1.5 rounded-full bg-primary-foreground" aria-hidden="true" />
          ) : null}
        </PopoverTrigger>
        <PopoverContent side="right" className="grid w-60 gap-3">
          <div className="grid gap-0.5">
            <PopoverTitle className="text-sm font-semibold">Parse options</PopoverTitle>
            <p className="text-xs text-muted-foreground">Apply to the next open or reopen.</p>
          </div>
          <DialectControls {...dialect} />
        </PopoverContent>
      </Popover>
    </div>
  );
}

export type AppearanceProps = {
  palette: ThemePalette;
  onPaletteChange: (palette: ThemePalette) => void;
  mode: ThemeMode;
  onToggleMode: () => void;
};

const paletteLabels = {
  studio: 'Studio',
  ledger: 'Ledger',
  terminal: 'Terminal',
  aurora: 'Aurora',
} satisfies Record<ThemePalette, string>;

/** The Colors menu (the palette) and the light/dark toggle. */
export function AppearanceControls({
  palette,
  onPaletteChange,
  mode,
  onToggleMode,
  className,
}: AppearanceProps & { className?: string }) {
  const modeLabel = mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  return (
    <div className={cn('flex items-center gap-1', className)}>
      <Popover>
        <PopoverTrigger
          className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
          aria-label="Colors"
          title="Colors"
        >
          <Palette />
        </PopoverTrigger>
        <PopoverContent side="right" align="end" className="grid w-64 gap-3">
          <PopoverTitle className="text-sm font-semibold">Colors</PopoverTitle>
          <div className="grid grid-cols-2 gap-1.5">
            {themePalettes.map((name) => (
              <Button
                key={name}
                type="button"
                variant="outline"
                size="sm"
                aria-pressed={palette === name}
                onClick={() => onPaletteChange(name)}
                className={cn(
                  'justify-start',
                  palette === name && 'border-primary bg-accent text-accent-foreground hover:bg-accent',
                )}
              >
                <span
                  data-palette={name}
                  className="grid size-5 shrink-0 place-items-center rounded-full border bg-background"
                  aria-hidden="true"
                >
                  <span className="size-2.5 rounded-full bg-primary" />
                </span>
                {paletteLabels[name]}
              </Button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
      <Button type="button" variant="ghost" size="icon-sm" onClick={onToggleMode} title={modeLabel} aria-label={modeLabel}>
        {mode === 'dark' ? <Sun /> : <Moon />}
      </Button>
    </div>
  );
}
