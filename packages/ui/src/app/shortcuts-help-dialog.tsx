import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Kbd, KbdGroup } from '@/components/ui/kbd';

type ShortcutChord = readonly string[];

type ShortcutEntry = {
  label: string;
  detail: string;
  chords: readonly ShortcutChord[];
};

type ShortcutSection = {
  heading: string;
  entries: readonly ShortcutEntry[];
};

const shortcutSections: readonly ShortcutSection[] = [
  {
    heading: 'Working CSV',
    entries: [
      {
        chords: [['F2']],
        label: 'Rename column',
        detail: 'Rename the column whose header is focused. F2 on a cell edits the cell.',
      },
      {
        chords: [['Enter']],
        label: 'Commit rename',
        detail: 'Commit the name while the column field is open.',
      },
      {
        chords: [['Esc']],
        label: 'Cancel rename',
        detail: 'Discard the name while the column field is open.',
      },
      {
        chords: [
          ['Ctrl', 'C'],
          ['⌘', 'C'],
        ],
        label: 'Copy cell',
        detail: 'Copy the focused cell. An open editor or a text selection keeps the browser copy.',
      },
      {
        chords: [
          ['Ctrl', 'Shift', 'A'],
          ['⌘', 'Shift', 'A'],
        ],
        label: 'Copy column',
        detail: 'Copy the focused column from anywhere that is not a text field.',
      },
    ],
  },
  {
    heading: 'Workspace',
    entries: [
      {
        chords: [['Ctrl', 'Tab']],
        label: 'Next tab',
        detail: 'Ctrl+Tab cycles every tab, including from a text field. Cmd+Tab is not a shortcut.',
      },
      {
        chords: [['Ctrl', 'Shift', 'Tab']],
        label: 'Previous tab',
        detail: 'Ctrl+Shift+Tab cycles every tab backward. Cmd+Shift+Tab is not a shortcut.',
      },
      {
        chords: [
          ['Ctrl', '/'],
          ['⌘', '/'],
        ],
        label: 'Keyboard shortcuts',
        detail: 'Show or hide this panel while CSV Viewer is focused.',
      },
      {
        chords: [['Esc']],
        label: 'Close shortcuts',
        detail: 'Close this panel.',
      },
    ],
  },
];

export function isHelpToggle(event: KeyboardEvent): boolean {
  return event.key === '/' && (event.ctrlKey || event.metaKey) && !event.altKey && !event.repeat;
}

type ShortcutsHelpDialogProps = {
  onClose: () => void;
};

export function ShortcutsHelpDialog({ onClose }: ShortcutsHelpDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
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
        event.stopImmediatePropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || event.ctrlKey || event.metaKey || event.altKey) return;
      const controls = focusable();
      if (controls.length === 0) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        event.stopImmediatePropagation();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        event.stopImmediatePropagation();
        first.focus();
      }
    }
    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      previouslyFocused?.focus();
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[60] grid place-items-center bg-slate-950/45 p-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-help-title"
        className="flex max-h-[min(680px,90vh)] w-full max-w-2xl flex-col overflow-hidden rounded-xl border bg-background shadow-2xl"
      >
        <header className="flex items-start justify-between gap-4 border-b p-5">
          <h2 id="shortcuts-help-title" className="text-xl font-semibold">
            Keyboard shortcuts
          </h2>
          <Button type="button" variant="ghost" size="icon" aria-label="Close keyboard shortcuts" onClick={onClose}>
            <X />
          </Button>
        </header>
        <div className="overflow-y-auto p-5">
          <div className="grid gap-6">
            {shortcutSections.map((section) => (
              <section key={section.heading} className="grid gap-3">
                <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground">{section.heading}</h3>
                <ul className="grid gap-3">
                  {section.entries.map((entry) => (
                    <li key={entry.label} className="grid gap-1">
                      <div className="flex flex-wrap items-center gap-1">
                        {entry.chords.map((chord, chordIndex) => (
                          <span key={chord.join(' ')} className="inline-flex items-center gap-1">
                            {chordIndex > 0 ? <span className="px-1 text-sm text-muted-foreground">or</span> : null}
                            <KbdGroup>
                              {chord.map((keycap) => (
                                <Kbd key={keycap}>{keycap}</Kbd>
                              ))}
                            </KbdGroup>
                          </span>
                        ))}
                      </div>
                      <p className="text-sm font-medium">{entry.label}</p>
                      <p className="text-sm leading-relaxed text-muted-foreground">{entry.detail}</p>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
          <p className="mt-6 text-sm leading-relaxed text-muted-foreground">
            The desktop File menu has its own shortcuts. They are not repeated here.
          </p>
        </div>
      </section>
    </div>
  );
}
