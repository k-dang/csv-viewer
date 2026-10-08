import { execFile, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const PATHS = [
  'open',
  'sort',
  'filter',
  'search',
  'edit-cell',
  'insert-column',
  'delete-column',
  'rename-column',
] as const;
export type PathName = (typeof PATHS)[number];

export const RUNTIMES = ['desktop', 'web'] as const;
export type Runtime = (typeof RUNTIMES)[number];

export type Phase = 'cold' | 'warm';

/** `web-dev` is the Vite dev server, so those rows are development React under StrictMode. */
const RUNTIME_LABEL = { desktop: 'desktop-prod', web: 'web-dev' } as const satisfies Record<Runtime, string>;

export type Session = 'local' | 'ci';
export type Environment = { os: NodeJS.Platform; session: Session };

export const VIEWPORT = { width: 1440, height: 900 } as const;
export type ViewportSize = { width: number; height: number };

/**
 * What a fixture shows in the grid. The shell checks `sha256` of the file bytes before any launch.
 * Every sample checks the rest on screen, so a changed fixture fails the run.
 */
export type Fixture = {
  file: `fixtures/${string}.csv`;
  bytes: number;
  sha256: string;
  rows: number;
  columns: number;
  /** `name` in data row 0, unsorted. */
  firstName: string;
  /** `name` in data row 1, unsorted and after one ascending sort on `name`. */
  secondName: { unsorted: string; ascending: string };
  /** A term that matches exactly one row, both as a `name` contains filter and as a global search. */
  needle: { term: string; name: string };
  /** `email` in data row 0, unsorted. */
  firstEmail: string;
};

const FIXTURE_NAMES = ['phase-2-sample', 'large-phase-3-test'] as const;

export const FIXTURES = {
  'phase-2-sample': {
    file: 'fixtures/phase-2-sample.csv',
    bytes: 656,
    sha256: '11c9574936c742b604f7ed8ced895112fee76f2504701cc3550a43e7627e4e06',
    rows: 5,
    columns: 10,
    firstName: 'Ada Lovelace',
    secondName: { unsorted: 'Grace Hopper', ascending: 'Dorothy Vaughan' },
    needle: { term: 'Grace', name: 'Grace Hopper' },
    firstEmail: 'ada@example.com',
  },
  'large-phase-3-test': {
    file: 'fixtures/large-phase-3-test.csv',
    bytes: 28_858_844,
    sha256: 'a7d18e7d71182bcd4e254b64e13640b828c29a93867174f4fe485099d9f06a5a',
    rows: 100_000,
    columns: 14,
    firstName: 'Person 1',
    secondName: { unsorted: 'Person 2', ascending: 'Person 10' },
    needle: { term: 'Person 99999', name: 'Person 99999' },
    firstEmail: 'person1@example.test',
  },
} as const satisfies Record<(typeof FIXTURE_NAMES)[number], Fixture>;
export type FixtureName = keyof typeof FIXTURES;

/**
 * Something the page shows. `querying` and `ready` are edges after the input.
 * `ready` is the return from Querying to Ready, so the idle Ready text cannot stop a clock.
 */
export type Mark =
  | { kind: 'querying' }
  | { kind: 'ready' }
  | { kind: 'dirty' }
  | { kind: 'clean' }
  | { kind: 'title'; text: string }
  | { kind: 'cell'; row: number; column: string; text: string }
  | { kind: 'count'; visible: number; total: number }
  | { kind: 'columns'; count: number }
  | { kind: 'header'; column: string; state: 'shown' | 'gone' }
  | { kind: 'visible'; target: Target }
  | { kind: 'empty-window' };
export type MarkKind = Mark['kind'];

export type ReportedInterval = {
  from: 'input' | 'querying';
  to: MarkKind;
  includes?: 'filter debounce';
};

export type Field = 'search' | 'filter-input' | 'cell-editor' | 'column-name';
export type MenuItem = 'Rename column' | 'Insert column left' | 'Delete column';

export type Target =
  | { kind: 'header-label' | 'filter-button'; column: string }
  | { kind: 'cell'; row: number; column: string }
  | { kind: 'menu-item'; label: MenuItem }
  | { kind: 'close-tab'; file: string }
  | { kind: 'undo' | 'clear-query' }
  | { kind: 'field'; field: Field };

export type UserInput =
  | { kind: 'drop'; file: Fixture['file'] }
  | { kind: 'click' | 'double-click' | 'right-click'; target: Target }
  | { kind: 'fill'; field: Field; text: string }
  | { kind: 'key'; key: 'Enter' | 'Escape' };

export type StartEvent = 'drop' | 'click' | 'dblclick' | 'contextmenu' | 'input' | 'keydown';

export const START_EVENT = {
  drop: 'drop',
  click: 'click',
  'double-click': 'dblclick',
  'right-click': 'contextmenu',
  fill: 'input',
  key: 'keydown',
} as const satisfies Record<UserInput['kind'], StartEvent>;

export type Step = { input: UserInput; until: readonly Mark[] };

export type SamplePlan = {
  startsFrom: readonly Mark[];
  arrange: readonly Step[];
  act: UserInput;
  marks: readonly Mark[];
  reset: readonly Step[];
};

type Recipe = {
  plan(fixture: Fixture): SamplePlan;
  report: readonly ReportedInterval[];
};

const querying = { kind: 'querying' } as const;
const ready = { kind: 'ready' } as const;
const dirty = { kind: 'dirty' } as const;
const clean = { kind: 'clean' } as const;
const cell = (row: number, column: string, text: string) => ({ kind: 'cell', row, column, text }) as const;
const count = (visible: number, total: number) => ({ kind: 'count', visible, total }) as const;
const header = (column: string, state: 'shown' | 'gone') => ({ kind: 'header', column, state }) as const;
const visible = (target: Target) => ({ kind: 'visible', target }) as const;
const step = (input: UserInput, ...until: Mark[]): Step => ({ input, until });
const click = (target: Target): UserInput => ({ kind: 'click', target });
const fileName = (fixture: Fixture) => path.posix.basename(fixture.file);
const nameHeader = { kind: 'header-label', column: 'name' } as const;
const undo = (...until: Mark[]) => step(click({ kind: 'undo' }), clean, ...until);
const emailMenu = (item: MenuItem) =>
  step({ kind: 'right-click', target: { kind: 'header-label', column: 'email' } }, visible({ kind: 'menu-item', label: item }));

/** A freshly opened fixture. Unsorted, unfiltered, clean, every row visible. */
const idle = (fixture: Fixture): readonly Mark[] => [
  clean,
  cell(0, 'name', fixture.firstName),
  cell(1, 'name', fixture.secondName.unsorted),
  count(fixture.rows, fixture.rows),
  header('email', 'shown'),
];

/** Rows a cleared filter or search must bring back. Clean and the email header already hold, so they are not stops. */
const restoredRows = (fixture: Fixture): Mark[] => [
  cell(0, 'name', fixture.firstName),
  cell(1, 'name', fixture.secondName.unsorted),
  count(fixture.rows, fixture.rows),
];

export const RECIPES = {
  open: {
    plan: (fixture) => ({
      startsFrom: [{ kind: 'empty-window' }],
      arrange: [],
      act: { kind: 'drop', file: fixture.file },
      marks: [
        { kind: 'title', text: fileName(fixture) },
        cell(0, 'name', fixture.firstName),
        count(fixture.rows, fixture.rows),
        { kind: 'columns', count: fixture.columns },
      ],
      // Closing first keeps a warm open from returning already-open on desktop.
      reset: [step(click({ kind: 'close-tab', file: fileName(fixture) }), { kind: 'empty-window' })],
    }),
    // The title lands before the first csv.get-rows, so it is a mark and not a printed row.
    report: [{ from: 'input', to: 'cell' }],
  },
  sort: {
    plan: (fixture) => ({
      startsFrom: idle(fixture),
      arrange: [],
      act: click(nameHeader),
      marks: [querying, ready, cell(1, 'name', fixture.secondName.ascending)],
      reset: [
        step(click(nameHeader), querying, ready),
        step(click(nameHeader), querying, ready, cell(1, 'name', fixture.secondName.unsorted)),
      ],
    }),
    report: [
      { from: 'input', to: 'cell' },
      { from: 'querying', to: 'ready' },
    ],
  },
  filter: {
    plan: (fixture) => ({
      startsFrom: idle(fixture),
      arrange: [step(click({ kind: 'filter-button', column: 'name' }), visible({ kind: 'field', field: 'filter-input' }))],
      act: { kind: 'fill', field: 'filter-input', text: fixture.needle.term },
      marks: [querying, ready, cell(0, 'name', fixture.needle.name), count(1, fixture.rows)],
      // Escape closes the filter popup. Clear query restores the unfiltered rows.
      reset: [
        step({ kind: 'key', key: 'Escape' }),
        step(click({ kind: 'clear-query' }), querying, ready, ...restoredRows(fixture)),
      ],
    }),
    report: [
      { from: 'input', to: 'cell', includes: 'filter debounce' },
      { from: 'querying', to: 'ready' },
    ],
  },
  search: {
    plan: (fixture) => ({
      startsFrom: idle(fixture),
      arrange: [],
      act: { kind: 'fill', field: 'search', text: fixture.needle.term },
      marks: [querying, ready, cell(0, 'name', fixture.needle.name), count(1, fixture.rows)],
      reset: [step({ kind: 'fill', field: 'search', text: '' }, querying, ready, ...restoredRows(fixture))],
    }),
    report: [
      { from: 'input', to: 'cell' },
      { from: 'querying', to: 'ready' },
    ],
  },
  'edit-cell': {
    plan: (fixture) => ({
      startsFrom: idle(fixture),
      arrange: [
        step({ kind: 'double-click', target: { kind: 'cell', row: 0, column: 'name' } }, visible({ kind: 'field', field: 'cell-editor' })),
        step({ kind: 'fill', field: 'cell-editor', text: `${fixture.firstName} edited` }),
      ],
      act: { kind: 'key', key: 'Enter' },
      marks: [dirty, querying, ready],
      reset: [undo(querying, ready, cell(0, 'name', fixture.firstName))],
    }),
    report: [
      { from: 'input', to: 'ready' },
      { from: 'input', to: 'dirty' },
    ],
  },
  'insert-column': {
    plan: (fixture) => ({
      startsFrom: idle(fixture),
      arrange: [emailMenu('Insert column left')],
      act: click({ kind: 'menu-item', label: 'Insert column left' }),
      marks: [dirty, header('New column', 'shown'), cell(0, 'New column', '[empty]')],
      // Undo matters twice: dirty state never reaches close, and the next insert is named "New column" again.
      reset: [undo(header('New column', 'gone'), querying, ready)],
    }),
    report: [
      { from: 'input', to: 'cell' },
      { from: 'input', to: 'dirty' },
    ],
  },
  'delete-column': {
    plan: (fixture) => ({
      startsFrom: idle(fixture),
      arrange: [emailMenu('Delete column')],
      act: click({ kind: 'menu-item', label: 'Delete column' }),
      marks: [dirty, header('email', 'gone'), querying, ready],
      reset: [undo(header('email', 'shown'), querying, ready, cell(0, 'email', fixture.firstEmail))],
    }),
    report: [
      { from: 'input', to: 'ready' },
      { from: 'input', to: 'dirty' },
    ],
  },
  'rename-column': {
    plan: (fixture) => ({
      startsFrom: idle(fixture),
      arrange: [
        emailMenu('Rename column'),
        step(click({ kind: 'menu-item', label: 'Rename column' }), visible({ kind: 'field', field: 'column-name' })),
        step({ kind: 'fill', field: 'column-name', text: 'email_renamed' }),
      ],
      act: { kind: 'key', key: 'Enter' },
      marks: [dirty, header('email_renamed', 'shown'), cell(0, 'email_renamed', fixture.firstEmail)],
      reset: [undo(header('email', 'shown'), querying, ready)],
    }),
    report: [
      { from: 'input', to: 'cell' },
      { from: 'input', to: 'dirty' },
    ],
  },
} satisfies Record<PathName, Recipe>;

export type LaunchPlan =
  | { runtime: 'desktop'; build: 'rebuild' | 'reuse'; fixture: FixtureName; path: PathName; warm: number }
  | { runtime: 'web'; fixture: FixtureName; path: PathName; warm: number };

export type RawTimeline = { input: number; marks: readonly number[] };

export type Sample = {
  runtime: Runtime;
  fixture: FixtureName;
  path: PathName;
  phase: Phase;
  intervals: readonly { label: string; ms: number }[];
};

export type MachineFacts = {
  recordedAt: string;
  commit: string;
  tree: 'clean' | 'modified';
  cpu: string;
  cores: number;
  memoryGiB: number;
  loadAverage: number;
  osRelease: string;
  node: string;
  browsers: Partial<Record<Runtime, string>>;
  command: string;
};

export class UsageError extends Error {}

const DEFAULT_COLD = 1;
const DEFAULT_WARM = 3;

export function planRun(argv: readonly string[]): readonly LaunchPlan[] {
  const flags = parseFlags(argv);
  const runtimes = choose('runtime', RUNTIMES, flags.runtime);
  const fixtures = choose('fixture', FIXTURE_NAMES, flags.fixture);
  const paths = choose('path', PATHS, flags.path);
  const cold = countFlag('cold', flags.cold, DEFAULT_COLD, 1);
  const warm = countFlag('warm', flags.warm, DEFAULT_WARM, 0);
  const launches: LaunchPlan[] = [];
  let desktopSeen = false;
  for (const runtime of runtimes) {
    for (const fixture of fixtures) {
      for (const pathName of paths) {
        for (let index = 0; index < cold; index += 1) {
          launches.push(launchPlan(runtime, fixture, pathName, warm, desktopSeen));
          if (runtime === 'desktop') desktopSeen = true;
        }
      }
    }
  }
  return launches;
}

type FlagValues = {
  runtime?: string[];
  fixture?: string[];
  path?: string[];
  cold?: string;
  warm?: string;
};

function parseFlags(argv: readonly string[]): FlagValues {
  try {
    const parsed = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        runtime: { type: 'string', multiple: true },
        fixture: { type: 'string', multiple: true },
        path: { type: 'string', multiple: true },
        cold: { type: 'string' },
        warm: { type: 'string' },
      },
    });
    return parsed.values;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'Invalid arguments';
    throw new UsageError(message);
  }
}

function choose<Name extends string>(label: string, registry: readonly Name[], chosen: readonly string[] | undefined): readonly Name[] {
  if (chosen === undefined || chosen.length === 0) return registry;
  for (const name of chosen) {
    if (!registry.some((item) => item === name)) {
      throw new UsageError(`Unknown ${label} "${name}". Valid ${label}s are ${registry.join(', ')}.`);
    }
  }
  return registry.filter((name) => chosen.includes(name));
}

function countFlag(label: string, raw: string | undefined, fallback: number, minimum: number): number {
  if (raw === undefined) return fallback;
  if (!/^(?:0|[1-9]\d*)$/.test(raw)) {
    throw new UsageError(`--${label} must be a non-negative integer.`);
  }
  const value = Number(raw);
  if (value < minimum) throw new UsageError(`--${label} must be at least ${minimum}.`);
  return value;
}

function launchPlan(runtime: Runtime, fixture: FixtureName, pathName: PathName, warm: number, desktopSeen: boolean): LaunchPlan {
  switch (runtime) {
    case 'desktop':
      return { runtime, build: desktopSeen ? 'reuse' : 'rebuild', fixture, path: pathName, warm };
    case 'web':
      return { runtime, fixture, path: pathName, warm };
    default: {
      const unreachable: never = runtime;
      throw new Error(`Unexpected runtime ${unreachable}`);
    }
  }
}

export function finishSample(launch: LaunchPlan, phase: Phase, raw: RawTimeline): Sample {
  const plan = RECIPES[launch.path].plan(FIXTURES[launch.fixture]);
  if (raw.marks.length !== plan.marks.length) {
    throw new Error(
      `${launch.runtime} ${launch.fixture} ${launch.path} expected ${plan.marks.length} mark times and got ${raw.marks.length}`,
    );
  }
  const intervals = RECIPES[launch.path].report.map((interval) => {
    const start = interval.from === 'input' ? raw.input : markTime(plan, raw, interval.from);
    const end = markTime(plan, raw, interval.to);
    if (start === undefined || end === undefined || !Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      throw new Error(
        `${launch.runtime} ${launch.fixture} ${launch.path} ${intervalLabel(interval)} is missing, not finite, or earlier than its start`,
      );
    }
    return { label: intervalLabel(interval), ms: end - start };
  });
  return { runtime: launch.runtime, fixture: launch.fixture, path: launch.path, phase, intervals };
}

function markTime(plan: SamplePlan, raw: RawTimeline, kind: MarkKind): number | undefined {
  const index = plan.marks.findIndex((mark) => mark.kind === kind);
  if (index < 0) return undefined;
  return raw.marks[index];
}

function intervalLabel(interval: ReportedInterval): string {
  const base = `${interval.from}-to-${interval.to}`;
  if (interval.includes === undefined) return base;
  return `${base}, includes ${interval.includes}`;
}

export function parseSession(ci: string | undefined): Session {
  if (ci === undefined || ci.length === 0 || ci === 'false' || ci === '0') return 'local';
  return 'ci';
}

const TABLE_HEADER =
  '| runtime | fixture | path | phase | interval | median ms | samples ms | bytes | rows | columns | os | session |';
const TABLE_DIVIDER = '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |';

export function formatReport(facts: MachineFacts, environment: Environment, samples: readonly Sample[]): string {
  const lines = [formatFacts(facts, environment), '', TABLE_HEADER, TABLE_DIVIDER];
  for (const group of groupSamples(samples)) {
    const fixture = FIXTURES[group.fixture];
    lines.push(
      `| ${RUNTIME_LABEL[group.runtime]} | ${group.fixture} | ${group.path} | ${group.phase} | ${group.label} | ${medianMs(group.samples)} | ${group.samples.join(' ')} | ${fixture.bytes} | ${fixture.rows} | ${fixture.columns} | ${environment.os} | ${environment.session} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}

type ReportGroup = {
  runtime: Runtime;
  fixture: FixtureName;
  path: PathName;
  phase: Phase;
  label: string;
  samples: number[];
};

function formatFacts(facts: MachineFacts, environment: Environment): string {
  return [
    `- Recorded at ${facts.recordedAt}`,
    `- Commit ${facts.commit}, working tree ${facts.tree}`,
    `- CPU ${facts.cpu}, ${facts.cores} cores, ${facts.memoryGiB} GiB memory, load average ${formatLoad(facts.loadAverage)}`,
    `- OS ${environment.os} ${facts.osRelease}`,
    `- Node ${facts.node}. ${formatBrowsers(facts.browsers)}`,
    `- viewport: ${VIEWPORT.width}x${VIEWPORT.height}`,
    `- Command \`${facts.command}\``,
  ].join('\n');
}

function formatBrowsers(browsers: Partial<Record<Runtime, string>>): string {
  const parts: string[] = [];
  if (browsers.desktop !== undefined) parts.push(`Desktop ${browsers.desktop}`);
  if (browsers.web !== undefined) parts.push(`Web ${browsers.web}`);
  if (parts.length === 0) return 'No browser attached.';
  return `${parts.join('. ')}.`;
}

function formatLoad(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function groupSamples(samples: readonly Sample[]): ReportGroup[] {
  const groups: ReportGroup[] = [];
  for (const sample of samples) {
    for (const interval of sample.intervals) {
      const rounded = Math.round(interval.ms);
      const existing = groups.find(
        (group) =>
          group.runtime === sample.runtime &&
          group.fixture === sample.fixture &&
          group.path === sample.path &&
          group.phase === sample.phase &&
          group.label === interval.label,
      );
      if (existing) existing.samples.push(rounded);
      else {
        groups.push({
          runtime: sample.runtime,
          fixture: sample.fixture,
          path: sample.path,
          phase: sample.phase,
          label: interval.label,
          samples: [rounded],
        });
      }
    }
  }
  return groups;
}

function medianMs(samples: readonly number[]): number {
  const ordered = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 1) return ordered[middle] ?? 0;
  const lower = ordered[middle - 1] ?? 0;
  const upper = ordered[middle] ?? 0;
  return Math.round((lower + upper) / 2);
}

const PROBE_GLOBAL = '__workingCsvLatency';

/** Collecting a sample waits this long for every armed mark. Settle uses the same bound. */
export const SAMPLE_TIMEOUT_MS = 120_000;

export type ViewportPoint = { x: number; y: number };

/** The page half of a sample. `measure` arms, sends the gesture, and collects on one call. */
export type Probe = {
  measure(start: StartEvent, marks: readonly Mark[], send: () => Promise<void>): Promise<RawTimeline>;
  settle(marks: readonly Mark[], quietMs: number, timeoutMs: number): Promise<void>;
  point(target: Target): Promise<ViewportPoint>;
  focus(field: Field): Promise<void>;
};

type ProbeArg = string | number | boolean | readonly Mark[] | Target;

const MARK_KINDS = [
  'querying',
  'ready',
  'dirty',
  'clean',
  'title',
  'cell',
  'count',
  'columns',
  'header',
  'visible',
  'empty-window',
] as const satisfies readonly MarkKind[];

/**
 * Installs the page clock once and returns its Node handle.
 * `evaluate` runs one expression with awaitPromise and resolves with its string value.
 */
export async function attachProbe(evaluate: (expression: string) => Promise<string>): Promise<Probe> {
  await evaluate(`JSON.stringify((${PAGE_PROBE_SOURCE})(${JSON.stringify(PROBE_GLOBAL)}))`);
  return {
    async measure(start, marks, send) {
      const held = parseHeld(await ask(evaluate, 'arm', [start, marks]));
      if (held.length > 0) {
        throw new Error(`${held.join(', ')} held before the input, so the stop would measure nothing`);
      }
      await send();
      return parseTimeline(await ask(evaluate, 'result', [SAMPLE_TIMEOUT_MS]));
    },
    async settle(marks, quietMs, timeoutMs) {
      const reply = await ask(evaluate, 'settle', [marks, quietMs, timeoutMs]);
      if (reply !== true) throw new Error('settle did not confirm the page was quiet');
    },
    async point(target) {
      return parsePoint(await ask(evaluate, 'point', [target]));
    },
    async focus(field) {
      const reply = await ask(evaluate, 'focus', [field]);
      if (reply !== true) throw new Error(`focus did not confirm ${field}`);
    },
  };
}

async function ask(evaluate: (expression: string) => Promise<string>, method: string, args: readonly ProbeArg[]): Promise<JsonValue> {
  // Runtime.evaluate parses a classic script, where a bare await is a syntax error.
  const expression = `(async () => JSON.stringify(await window[${JSON.stringify(PROBE_GLOBAL)}][${JSON.stringify(method)}](${args
    .map((arg) => JSON.stringify(arg))
    .join(', ')})))()`;
  let text: string;
  try {
    text = await evaluate(expression);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'probe call failed';
    throw new Error(`${method} failed: ${message}`);
  }
  try {
    return parseJson(text);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'unreadable reply';
    throw new Error(`${method} reply did not parse: ${text} (${message})`);
  }
}

function parseHeld(value: JsonValue): MarkKind[] {
  if (!Array.isArray(value)) throw new Error('arm reply must be an array');
  return value.map((item, index) => {
    const kind = expectString(item, `held[${index}]`);
    if (!isMarkKind(kind)) throw new Error(`arm reply has unknown mark ${kind}`);
    return kind;
  });
}

function parseTimeline(value: JsonValue): RawTimeline {
  const record = expectObject(value, 'timeline');
  const marksValue = own(record, 'marks');
  if (!Array.isArray(marksValue)) throw new Error('timeline marks must be an array');
  return {
    input: expectNumber(own(record, 'input'), 'input'),
    marks: marksValue.map((item, index) => expectNumber(item, `marks[${index}]`)),
  };
}

function parsePoint(value: JsonValue): ViewportPoint {
  const record = expectObject(value, 'point');
  return { x: expectNumber(own(record, 'x'), 'x'), y: expectNumber(own(record, 'y'), 'y') };
}

function isMarkKind(value: string): value is MarkKind {
  return MARK_KINDS.some((kind) => kind === value);
}

/**
 * Runs in the page. A second install keeps the first. It reads the DOM and never calls into the product API.
 * A mark is stamped when the DOM matches, which can be a frame before pixels.
 * Ready is recorded only after Querying in the same sample, so the idle Ready text cannot finish one.
 */
const PAGE_PROBE_SOURCE = String.raw`
function installProbe(globalName) {
  if (Object.prototype.hasOwnProperty.call(window, globalName)) return true;
  let generation = 0;
  let current = null;
  let observer = null;
  let removeStart = null;

  function textOf(node) {
    if (!node) return '';
    return (node.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function digits(value) {
    const matched = String(value).replace(/[^\d]/g, '');
    if (matched.length === 0) return null;
    return Number(matched);
  }

  function attr(value) {
    return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }

  function queryStatus() {
    const node = document.querySelector('.csv-view [data-query-status]');
    return node ? node.getAttribute('data-query-status') : null;
  }

  function countLine() {
    const root = document.querySelector('.csv-view');
    if (!root) return null;
    const nodes = root.querySelectorAll('span');
    for (let index = 0; index < nodes.length; index += 1) {
      const match = textOf(nodes[index]).match(/^(\d[\d.,\s]*)\s+visible of\s+(\d[\d.,\s]*)\s+rows$/);
      if (!match) continue;
      const visible = digits(match[1]);
      const total = digits(match[2]);
      if (visible === null || total === null) return null;
      return { visible: visible, total: total };
    }
    return null;
  }

  function columnCount() {
    const root = document.querySelector('.csv-view');
    if (!root) return null;
    const nodes = root.querySelectorAll('span');
    for (let index = 0; index < nodes.length; index += 1) {
      const match = textOf(nodes[index]).match(/^(\d[\d.,\s]*)\s+columns$/);
      if (!match) continue;
      return digits(match[1]);
    }
    return null;
  }

  function headerCell(column) {
    return document.querySelector('.ag-header-cell[col-id=' + attr(column) + ']');
  }

  function cellNode(row, column) {
    return document.querySelector(
      '.ag-center-cols-container .ag-row[row-index=' + attr(String(row)) + '] .ag-cell[col-id=' + attr(column) + ']',
    );
  }

  function fieldNode(field) {
    if (field === 'search') return document.querySelector('#global-search');
    if (field === 'filter-input') return document.querySelector('.ag-popup input[aria-label="Search values"]');
    if (field === 'cell-editor') return document.querySelector('.ag-cell-inline-editing input');
    if (field === 'column-name') return document.querySelector('input[aria-label="Column name"]');
    throw new Error('Unknown field ' + field);
  }

  function targetNode(target) {
    if (target.kind === 'header-label') {
      const header = headerCell(target.column);
      return header ? header.querySelector('.ag-header-cell-label') : null;
    }
    if (target.kind === 'filter-button') {
      const header = headerCell(target.column);
      return header ? header.querySelector('.ag-header-cell-filter-button') : null;
    }
    if (target.kind === 'cell') return cellNode(target.row, target.column);
    if (target.kind === 'menu-item') {
      const items = document.querySelectorAll('[role="menuitem"]');
      for (let index = 0; index < items.length; index += 1) {
        if (textOf(items[index]).indexOf(target.label) === 0) return items[index];
      }
      return null;
    }
    if (target.kind === 'close-tab') return document.querySelector('button[aria-label=' + attr('Close ' + target.file) + ']');
    if (target.kind === 'undo') return document.querySelector('button[aria-label="Undo edit"]');
    if (target.kind === 'clear-query') return document.querySelector('button[aria-label="Clear query"]');
    if (target.kind === 'field') return fieldNode(target.field);
    throw new Error('Unknown target ' + target.kind);
  }

  function markHolds(mark) {
    if (mark.kind === 'querying') return queryStatus() === 'querying';
    if (mark.kind === 'ready') return queryStatus() === 'ready';
    if (mark.kind === 'dirty') {
      const badge = document.querySelector('[role="img"][aria-label="Unexported Changes"]');
      const undo = document.querySelector('button[aria-label="Undo edit"]');
      return Boolean(badge) && undo !== null && undo.disabled === false;
    }
    if (mark.kind === 'clean') {
      const badge = document.querySelector('[role="img"][aria-label="Unexported Changes"]');
      const undo = document.querySelector('button[aria-label="Undo edit"]');
      return badge === null && undo !== null && undo.disabled === true;
    }
    if (mark.kind === 'title') return textOf(document.querySelector('#metadata-title')) === mark.text;
    if (mark.kind === 'cell') {
      const cell = cellNode(mark.row, mark.column);
      return cell !== null && textOf(cell) === mark.text;
    }
    if (mark.kind === 'count') {
      const count = countLine();
      return count !== null && count.visible === mark.visible && count.total === mark.total;
    }
    if (mark.kind === 'columns') return columnCount() === mark.count;
    if (mark.kind === 'header') {
      const shown = headerCell(mark.column) !== null;
      return mark.state === 'shown' ? shown : !shown;
    }
    if (mark.kind === 'visible') {
      const node = targetNode(mark.target);
      return node !== null && node.getClientRects().length > 0;
    }
    if (mark.kind === 'empty-window') {
      const title = textOf(document.querySelector('#empty-state-title'));
      const dialog = document.querySelector('[role="dialog"], [role="alertdialog"], dialog[open]');
      return title === 'No CSV open' && dialog === null;
    }
    throw new Error('Unknown mark ' + mark.kind);
  }

  function isLevel(kind) {
    return kind !== 'querying' && kind !== 'ready';
  }

  function cancel(reason) {
    generation += 1;
    if (removeStart) removeStart();
    removeStart = null;
    if (observer) observer.disconnect();
    observer = null;
    const previous = current;
    current = null;
    if (previous && previous.settle) previous.settle(new Error(reason));
  }

  function finish(sample) {
    if (!sample.settle) return;
    const settle = sample.settle;
    sample.settle = null;
    if (sample.failed) settle(new Error(sample.failed));
    else settle(null);
  }

  function inspect(sample) {
    if (current !== sample || sample.state === 'complete') return;
    const status = queryStatus();
    if (status === 'failed') {
      sample.failed = 'Query failed';
      sample.state = 'complete';
      finish(sample);
      return;
    }
    if (sample.state === 'armed') return;
    if (sample.state === 'started' && status === 'querying') sample.state = 'querying';
    for (let index = 0; index < sample.marks.length; index += 1) {
      if (sample.times[index] !== null) continue;
      const mark = sample.marks[index];
      if (mark.kind === 'ready') {
        if (sample.state !== 'querying' || status !== 'ready') continue;
        sample.times[index] = performance.now();
        continue;
      }
      if (mark.kind === 'querying') {
        if (sample.state !== 'querying') continue;
        sample.times[index] = performance.now();
        continue;
      }
      if (markHolds(mark)) sample.times[index] = performance.now();
    }
    let done = sample.input !== null;
    for (let index = 0; index < sample.times.length; index += 1) {
      if (sample.times[index] === null) done = false;
    }
    if (!done) return;
    sample.state = 'complete';
    finish(sample);
  }

  function arm(start, marks) {
    cancel('Sample replaced');
    const id = generation;
    const times = [];
    const held = [];
    for (let index = 0; index < marks.length; index += 1) {
      times.push(null);
      if (isLevel(marks[index].kind) && markHolds(marks[index])) held.push(marks[index].kind);
    }
    const sample = {
      id: id,
      start: start,
      marks: marks,
      times: times,
      input: null,
      state: 'armed',
      failed: null,
      settle: null,
    };
    current = sample;
    function onStart(event) {
      if (current !== sample || sample.state !== 'armed' || event.type !== start) return;
      sample.input = event.timeStamp;
      sample.state = 'started';
      inspect(sample);
    }
    window.addEventListener(start, onStart, true);
    removeStart = function () {
      window.removeEventListener(start, onStart, true);
    };
    observer = new MutationObserver(function () {
      inspect(sample);
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });
    return held;
  }

  function missing(sample) {
    const names = [];
    if (sample.input === null) names.push('input');
    for (let index = 0; index < sample.marks.length; index += 1) {
      if (sample.times[index] === null) names.push(sample.marks[index].kind);
    }
    return names.join(', ');
  }

  function result(timeoutMs) {
    const sample = current;
    if (!sample) return Promise.reject(new Error('No armed sample'));
    if (sample.failed) return Promise.reject(new Error(sample.failed));
    if (sample.state === 'complete' && sample.input !== null) {
      return Promise.resolve({ input: sample.input, marks: sample.times.slice() });
    }
    return new Promise(function (resolve, reject) {
      const timer = setTimeout(function () {
        sample.settle = null;
        reject(new Error('Timed out waiting for ' + missing(sample) + ' (state ' + sample.state + ')'));
      }, timeoutMs);
      sample.settle = function (error) {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve({ input: sample.input, marks: sample.times.slice() });
      };
      if (sample.state === 'complete' || sample.failed) finish(sample);
    });
  }

  function settle(marks, quietMs, timeoutMs) {
    return new Promise(function (resolve, reject) {
      let quietTimer = null;
      const watcher = new MutationObserver(function () {
        schedule();
      });
      function stop(error) {
        watcher.disconnect();
        if (quietTimer !== null) clearTimeout(quietTimer);
        clearTimeout(limit);
        if (error) reject(error);
        else resolve(true);
      }
      function holds() {
        for (let index = 0; index < marks.length; index += 1) {
          if (!markHolds(marks[index])) return false;
        }
        return true;
      }
      function schedule() {
        if (quietTimer !== null) clearTimeout(quietTimer);
        if (!holds()) return;
        quietTimer = setTimeout(function () {
          stop(null);
        }, quietMs);
      }
      const limit = setTimeout(function () {
        const names = [];
        for (let index = 0; index < marks.length; index += 1) {
          if (!markHolds(marks[index])) names.push(marks[index].kind);
        }
        stop(new Error('Timed out settling ' + (names.join(', ') || 'quiet page')));
      }, timeoutMs);
      watcher.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
      });
      schedule();
    });
  }

  function point(target) {
    const node = targetNode(target);
    if (!node) throw new Error('Missing target ' + target.kind);
    node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const box = node.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) throw new Error('Target has no box ' + target.kind);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  function focus(field) {
    const node = fieldNode(field);
    if (!node || !node.focus) throw new Error('Missing field ' + field);
    node.focus();
    if (node.select) node.select();
    return true;
  }

  Object.defineProperty(window, globalName, {
    configurable: true,
    value: { arm: arm, result: result, settle: settle, point: point, focus: focus },
  });
  return true;
}
`;

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const HELPER = '.claude/skills/verify-csv-viewer/bin/control-csv-viewer.mjs';
const HELPER_RUN = '.claude/skills/verify-csv-viewer/runs/current.json';
const QUIET_MS = 300;
const PAGE_WAIT_MS = 10_000;

type Page = {
  browser: string;
  sample(plan: SamplePlan): Promise<RawTimeline>;
  steps(steps: readonly Step[]): Promise<void>;
};

type Cdp = {
  send(method: string, paramsJson: string): Promise<JsonObject>;
  evaluate(expression: string): Promise<string>;
  close(): void;
};

type VerifyRun = {
  pid: number;
  vitePid: number | null;
  cdpPort: number;
  webUrl: string | null;
};

type CdpTarget = {
  type: string;
  url: string;
  title: string;
  webSocketDebuggerUrl: string;
};

type BrowserVersion = {
  browser: string;
  userAgent: string;
};

type DragTransfer = {
  items: [];
  files: string[];
  dragOperationsMask: number;
};

type JsonObject = { readonly [key: string]: JsonValue };
type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;

let ownsSession = false;
let ownedRun: VerifyRun | null = null;

async function main(argv: readonly string[]): Promise<void> {
  const launches = planRun(argv);
  await assertFixtures(launches);
  const existing = await readVerifyRun();
  if (existing !== null && pidIsAlive(existing.pid)) {
    throw new Error(`A verification instance is already running (pid ${existing.pid}). Refusing to launch.`);
  }
  const samples: Sample[] = [];
  let desktopBrowser: string | undefined;
  let webBrowser: string | undefined;
  for (let index = 0; index < launches.length; index += 1) {
    const launch = launches[index];
    if (launch === undefined) continue;
    process.stderr.write(`${index + 1}/${launches.length} ${launch.runtime} ${launch.fixture} ${launch.path}\n`);
    const batch = await withFreshApp(launch, async (page) => {
      switch (launch.runtime) {
        case 'desktop':
          desktopBrowser = page.browser;
          break;
        case 'web':
          webBrowser = page.browser;
          break;
        default: {
          const unreachable: never = launch;
          throw new Error(`Unexpected runtime ${unreachable}`);
        }
      }
      return measureLaunch(page, launch);
    });
    samples.push(...batch);
  }
  const browsers: Partial<Record<Runtime, string>> = {};
  if (desktopBrowser !== undefined) browsers.desktop = desktopBrowser;
  if (webBrowser !== undefined) browsers.web = webBrowser;
  const facts = await machineFacts(argv, browsers);
  process.stdout.write(formatReport(facts, { os: process.platform, session: parseSession(process.env.CI) }, samples));
}

async function measureLaunch(page: Page, launch: LaunchPlan): Promise<Sample[]> {
  const fixture = FIXTURES[launch.fixture];
  const samples: Sample[] = [];
  if (launch.path !== 'open') {
    const opened = RECIPES.open.plan(fixture);
    await page.steps([{ input: opened.act, until: opened.marks }]);
  }
  samples.push(await takeSample(page, launch, 'cold'));
  for (let index = 0; index < launch.warm; index += 1) {
    await page.steps(RECIPES[launch.path].plan(fixture).reset);
    samples.push(await takeSample(page, launch, 'warm'));
  }
  return samples;
}

async function takeSample(page: Page, launch: LaunchPlan, phase: Phase): Promise<Sample> {
  const plan = RECIPES[launch.path].plan(FIXTURES[launch.fixture]);
  return finishSample(launch, phase, await page.sample(plan));
}

async function withFreshApp<T>(launch: LaunchPlan, use: (page: Page) => Promise<T>): Promise<T> {
  let socket: Cdp | null = null;
  let outcome: { ok: true; value: T } | { ok: false; cause: unknown } | null = null;
  try {
    await runHelper(launchArgs(launch));
    const run = await readRequiredRun();
    ownsSession = true;
    ownedRun = run;
    const version = parseBrowserVersion(await fetchText(`http://127.0.0.1:${run.cdpPort}/json/version`));
    const target = await waitForAppPage(run.cdpPort, run.webUrl);
    socket = await connectCdp(target.webSocketDebuggerUrl);
    const cdp = socket;
    await cdp.send('Runtime.enable', '{}');
    await cdp.send('Page.enable', '{}');
    await forceViewport(cdp);
    const probe = await attachProbe((expression) => cdp.evaluate(expression));
    await probe.settle([{ kind: 'empty-window' }], QUIET_MS, SAMPLE_TIMEOUT_MS);
    outcome = { ok: true, value: await use(createPage(cdp, probe, browserFact(launch.runtime, version))) };
  } catch (cause) {
    outcome = { ok: false, cause };
    await explainFailure(launch);
  } finally {
    socket?.close();
    try {
      await cleanupOwnedSession();
    } catch (cleanupCause) {
      if (outcome?.ok === false) {
        const message = cleanupCause instanceof Error ? cleanupCause.message : 'cleanup failed';
        process.stderr.write(`cleanup failed: ${message}\n`);
      } else {
        outcome = { ok: false, cause: cleanupCause };
      }
    }
  }
  if (outcome === null || !outcome.ok) {
    const cause = outcome?.ok === false ? outcome.cause : new Error('launch failed');
    throw cause;
  }
  return outcome.value;
}

function createPage(cdp: Cdp, probe: Probe, browser: string): Page {
  return {
    browser,
    sample: (plan) => runSample(cdp, probe, plan),
    steps: (steps) => playSteps(cdp, probe, steps),
  };
}

async function runSample(cdp: Cdp, probe: Probe, plan: SamplePlan): Promise<RawTimeline> {
  await assertViewport(cdp);
  await probe.settle(plan.startsFrom, QUIET_MS, SAMPLE_TIMEOUT_MS);
  await playSteps(cdp, probe, plan.arrange);
  await probe.settle([], QUIET_MS, SAMPLE_TIMEOUT_MS);
  const send = await aim(probe, cdp, plan.act);
  return probe.measure(START_EVENT[plan.act.kind], plan.marks, send);
}

async function playSteps(cdp: Cdp, probe: Probe, steps: readonly Step[]): Promise<void> {
  for (const step of steps) {
    const send = await aim(probe, cdp, step.input);
    await probe.measure(START_EVENT[step.input.kind], step.until, send);
  }
}

async function forceViewport(cdp: Cdp): Promise<void> {
  await cdp.send(
    'Emulation.setDeviceMetricsOverride',
    JSON.stringify({
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: VIEWPORT.width,
      screenHeight: VIEWPORT.height,
    }),
  );
  await cdp.send('Page.bringToFront', '{}');
  await assertViewport(cdp);
  process.stderr.write(`viewport: ${VIEWPORT.width}x${VIEWPORT.height}\n`);
}

async function assertViewport(cdp: Cdp): Promise<void> {
  const size = await readViewport(cdp);
  if (size.width !== VIEWPORT.width || size.height !== VIEWPORT.height) {
    throw new Error(`Viewport is ${size.width}x${size.height}; expected ${VIEWPORT.width}x${VIEWPORT.height}`);
  }
}

async function readViewport(cdp: Cdp): Promise<ViewportSize> {
  const text = await cdp.evaluate('JSON.stringify({ width: innerWidth, height: innerHeight })');
  const record = expectObject(parseJson(text), 'viewport');
  return {
    width: expectNumber(own(record, 'width'), 'width'),
    height: expectNumber(own(record, 'height'), 'height'),
  };
}

/**
 * Prepares the gesture before the clock starts. mouseMoved is omitted: the verify helper found that
 * awaiting it stalls for seconds in an occluded window and the press then lands late.
 */
async function aim(probe: Probe, cdp: Cdp, input: UserInput): Promise<() => Promise<void>> {
  switch (input.kind) {
    case 'drop':
      return aimDrop(cdp, input.file);
    case 'click':
      return aimClick(probe, cdp, input.target, 'left', 1);
    case 'double-click':
      return aimClick(probe, cdp, input.target, 'left', 2);
    case 'right-click':
      return aimClick(probe, cdp, input.target, 'right', 1);
    case 'fill':
      return aimFill(probe, cdp, input.field, input.text);
    case 'key':
      return aimKey(cdp, input.key);
    default: {
      const unreachable: never = input;
      throw new Error(`Unexpected input ${unreachable}`);
    }
  }
}

async function aimDrop(cdp: Cdp, file: `fixtures/${string}.csv`): Promise<() => Promise<void>> {
  const filePath = path.join(REPO_ROOT, file);
  const size = await readViewport(cdp);
  const center = { x: size.width / 2, y: size.height / 2 };
  const data = dragTransfer(filePath);
  return async () => {
    await dispatchDrag(cdp, 'dragEnter', center, data);
    await dispatchDrag(cdp, 'dragOver', center, data);
    await dispatchDrag(cdp, 'drop', center, data);
  };
}

/** The file drag payload copied from the verify helper's runDrop. */
function dragTransfer(filePath: string): DragTransfer {
  return { items: [], files: [filePath], dragOperationsMask: 1 };
}

async function dispatchDrag(cdp: Cdp, type: 'dragEnter' | 'dragOver' | 'drop', point: ViewportPoint, data: DragTransfer): Promise<void> {
  await cdp.send('Input.dispatchDragEvent', JSON.stringify({ type, x: point.x, y: point.y, data }));
}

async function aimClick(
  probe: Probe,
  cdp: Cdp,
  target: Target,
  button: 'left' | 'right',
  clicks: number,
): Promise<() => Promise<void>> {
  const point = await probe.point(target);
  return async () => {
    for (let count = 1; count <= clicks; count += 1) {
      await dispatchMouse(cdp, 'mousePressed', point, button, count);
      await dispatchMouse(cdp, 'mouseReleased', point, button, count);
    }
  };
}

async function dispatchMouse(
  cdp: Cdp,
  type: 'mousePressed' | 'mouseReleased',
  point: ViewportPoint,
  button: 'left' | 'right',
  clickCount: number,
): Promise<void> {
  await cdp.send('Input.dispatchMouseEvent', JSON.stringify({ type, x: point.x, y: point.y, button, clickCount }));
}

async function aimFill(probe: Probe, cdp: Cdp, field: Field, text: string): Promise<() => Promise<void>> {
  await probe.focus(field);
  return async () => {
    // focus selects the field. Backspace deletes that selection.
    if (text.length === 0) {
      await dispatchKey(cdp, 'Backspace', 'Backspace', 8);
      return;
    }
    await cdp.send('Input.insertText', JSON.stringify({ text }));
  };
}

function aimKey(cdp: Cdp, key: 'Enter' | 'Escape'): () => Promise<void> {
  switch (key) {
    case 'Enter':
      return async () => {
        await dispatchKey(cdp, 'Enter', 'Enter', 13, '\r');
      };
    case 'Escape':
      return async () => {
        await dispatchKey(cdp, 'Escape', 'Escape', 27);
      };
    default: {
      const unreachable: never = key;
      throw new Error(`Unexpected key ${unreachable}`);
    }
  }
}

async function dispatchKey(
  cdp: Cdp,
  key: string,
  code: string,
  windowsVirtualKeyCode: number,
  text?: string,
): Promise<void> {
  if (text === undefined) {
    await cdp.send('Input.dispatchKeyEvent', JSON.stringify({ type: 'keyDown', key, code, windowsVirtualKeyCode }));
  } else {
    await cdp.send('Input.dispatchKeyEvent', JSON.stringify({ type: 'keyDown', key, code, windowsVirtualKeyCode, text }));
  }
  await cdp.send('Input.dispatchKeyEvent', JSON.stringify({ type: 'keyUp', key, code, windowsVirtualKeyCode }));
}

type PendingCall = {
  resolve: (result: JsonObject) => void;
  reject: (cause: Error) => void;
};

function connectCdp(webSocketDebuggerUrl: string): Promise<Cdp> {
  const socket = new WebSocket(webSocketDebuggerUrl);
  const pending = new Map<number, PendingCall>();
  let nextId = 0;
  socket.addEventListener('message', (event) => {
    dispatchCdp(String(event.data), pending);
  });
  socket.addEventListener('close', () => {
    for (const call of pending.values()) call.reject(new Error('CDP socket closed'));
    pending.clear();
  });
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(createCdp(socket, pending, () => {
      nextId += 1;
      return nextId;
    })), { once: true });
    socket.addEventListener('error', () => reject(new Error('CDP WebSocket failed')), { once: true });
  });
}

function createCdp(socket: WebSocket, pending: Map<number, PendingCall>, nextId: () => number): Cdp {
  return {
    send(method, paramsJson) {
      const id = nextId();
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(`{"id":${id},"method":${JSON.stringify(method)},"params":${paramsJson}}`);
      });
    },
    async evaluate(expression) {
      const result = await this.send('Runtime.evaluate', JSON.stringify({ expression, awaitPromise: true, returnByValue: true }));
      return readEvaluation(result);
    },
    close() {
      socket.close();
    },
  };
}

function dispatchCdp(text: string, pending: Map<number, PendingCall>): void {
  const message = parseCdpMessage(text);
  switch (message.kind) {
    case 'event':
      return;
    case 'error': {
      const call = pending.get(message.id);
      if (!call) return;
      pending.delete(message.id);
      call.reject(new Error(message.message));
      return;
    }
    case 'result': {
      const call = pending.get(message.id);
      if (!call) return;
      pending.delete(message.id);
      call.resolve(message.result);
      return;
    }
    default: {
      const unreachable: never = message;
      throw new Error(`Unexpected CDP message ${unreachable}`);
    }
  }
}

type CdpIncoming =
  | { kind: 'event' }
  | { kind: 'error'; id: number; message: string }
  | { kind: 'result'; id: number; result: JsonObject };

function parseCdpMessage(text: string): CdpIncoming {
  const record = expectObject(parseJson(text), 'CDP message');
  const idValue = own(record, 'id');
  if (idValue === undefined) return { kind: 'event' };
  const id = expectNumber(idValue, 'CDP id');
  const errorValue = own(record, 'error');
  if (errorValue !== undefined && jsonKind(errorValue) === 'object') {
    const message = stringField(expectObject(errorValue, 'CDP error'), 'message');
    return { kind: 'error', id, message: message.length === 0 ? 'CDP error' : message };
  }
  const result = own(record, 'result');
  if (result === undefined) return { kind: 'result', id, result: {} };
  return { kind: 'result', id, result: expectObject(result, 'CDP result') };
}

function readEvaluation(result: JsonObject): string {
  const details = own(result, 'exceptionDetails');
  if (details !== undefined && jsonKind(details) === 'object') {
    throw new Error(evaluationError(expectObject(details, 'exceptionDetails')));
  }
  const remote = expectObject(own(result, 'result'), 'result');
  const value = own(remote, 'value');
  if (value === undefined) throw new Error('Runtime.evaluate returned no string');
  return expectString(value, 'evaluation');
}

function evaluationError(details: JsonObject): string {
  const exception = own(details, 'exception');
  if (exception !== undefined && jsonKind(exception) === 'object') {
    const description = stringField(expectObject(exception, 'exception'), 'description');
    if (description.length > 0) return description;
  }
  const text = stringField(details, 'text');
  return text.length === 0 ? 'Runtime.evaluate failed' : text;
}

async function waitForAppPage(cdpPort: number, webUrl: string | null): Promise<CdpTarget> {
  const deadline = Date.now() + PAGE_WAIT_MS;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const text = await fetchText(`http://127.0.0.1:${cdpPort}/json/list`);
      last = text;
      const page = parseTargetList(text).find((target) => isAppPage(target, webUrl) && target.webSocketDebuggerUrl.length > 0);
      if (page) return page;
    } catch {
      // CDP is not up yet.
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for the CSV Viewer page on CDP port ${cdpPort}. Targets: ${last}`);
}

/** Page selection copied from the verify helper's isAppPage. Web runs own an exact origin. */
function isAppPage(target: CdpTarget, webUrl: string | null): boolean {
  if (target.type !== 'page') return false;
  const url = target.url;
  if (url.startsWith('devtools://') || url.startsWith('chrome://')) return false;
  if (webUrl !== null && webUrl.length > 0) return url.startsWith(new URL(webUrl).origin);
  return target.title === 'CSV Viewer' || url.includes('dist-renderer') || url.includes('index.html');
}

function parseTargetList(text: string): CdpTarget[] {
  const value = parseJson(text);
  if (!Array.isArray(value)) throw new Error('CDP target list must be an array');
  return value.map((item, index) => {
    const record = expectObject(item, `target[${index}]`);
    return {
      type: stringField(record, 'type'),
      url: stringField(record, 'url'),
      title: stringField(record, 'title'),
      webSocketDebuggerUrl: stringField(record, 'webSocketDebuggerUrl'),
    };
  });
}

function parseBrowserVersion(text: string): BrowserVersion {
  const record = expectObject(parseJson(text), 'browser version');
  return {
    browser: expectString(own(record, 'Browser'), 'Browser'),
    userAgent: expectString(own(record, 'User-Agent'), 'User-Agent'),
  };
}

function browserFact(runtime: Runtime, version: BrowserVersion): string {
  const chrome = version.browser.replace('/', ' ');
  switch (runtime) {
    case 'desktop': {
      const matched = /Electron\/(\S+)/.exec(version.userAgent);
      const electron = matched?.[1] ?? 'unknown';
      return `Electron ${electron} with ${chrome}`;
    }
    case 'web':
      return chrome;
    default: {
      const unreachable: never = runtime;
      throw new Error(`Unexpected runtime ${unreachable}`);
    }
  }
}

function launchArgs(launch: LaunchPlan): string[] {
  switch (launch.runtime) {
    case 'web':
      return ['launch', '--web'];
    case 'desktop':
      return launch.build === 'rebuild' ? ['launch', '--rebuild'] : ['launch'];
    default: {
      const unreachable: never = launch;
      throw new Error(`Unexpected runtime ${unreachable}`);
    }
  }
}

function runHelper(args: readonly string[]): Promise<void> {
  const helper = path.join(REPO_ROOT, HELPER);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helper, ...args], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 2, 2],
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`verify helper ${args[0] ?? 'command'} exited ${code ?? 'null'}`));
    });
  });
}

async function cleanupOwnedSession(): Promise<void> {
  const run = takeOwnedRun();
  if (run === null) return;
  signalRecordedGroups(run);
  if (await currentRunIs(run)) await runHelper(['cleanup']);
}

function stopOwnedSession(): void {
  const run = takeOwnedRun();
  if (run === null) return;
  signalRecordedGroups(run);
  if (!currentRunIsSync(run)) return;
  spawnSync(process.execPath, [path.join(REPO_ROOT, HELPER), 'cleanup'], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 2, 2],
  });
}

function takeOwnedRun(): VerifyRun | null {
  if (!ownsSession) return null;
  ownsSession = false;
  const run = ownedRun;
  ownedRun = null;
  return run;
}

function signalRecordedGroups(run: VerifyRun): void {
  // The helper records detached leaders. Signaling the group also stops children
  // such as Vite, which survive a signal sent only to that leader.
  signalProcessGroup(run.pid);
  signalProcessGroup(run.vitePid);
}

async function currentRunIs(run: VerifyRun): Promise<boolean> {
  const current = await readVerifyRun();
  return current === null || current.pid === run.pid;
}

function currentRunIsSync(run: VerifyRun): boolean {
  const current = readOwnedRunSync();
  return current === null || current.pid === run.pid;
}

function signalProcessGroup(pid: number | null): void {
  if (pid === null || pid <= 0) return;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    // The leader already exited, or this pid was not a process-group leader.
  }
}

function readOwnedRunSync(): VerifyRun | null {
  try {
    return parseVerifyRun(readFileSync(path.join(REPO_ROOT, HELPER_RUN), 'utf8'));
  } catch (cause) {
    if (cause instanceof Error && isEnoent(cause)) return null;
    return null;
  }
}

async function explainFailure(launch: LaunchPlan): Promise<void> {
  const snapshotPath = path.join(os.tmpdir(), `working-csv-latency-${process.pid}.txt`);
  try {
    await runHelper(['snapshot', '--path', snapshotPath]);
    process.stderr.write(`${await readFile(snapshotPath, 'utf8')}\n`);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'snapshot failed';
    process.stderr.write(`snapshot failed: ${message}\n`);
  }
  process.stderr.write(`${narrowedCommand(launch)}\n`);
}

function narrowedCommand(launch: LaunchPlan): string {
  return `pnpm -s perf:latency --runtime ${launch.runtime} --fixture ${launch.fixture} --path ${launch.path} --cold 1 --warm ${launch.warm}`;
}

async function assertFixtures(launches: readonly LaunchPlan[]): Promise<void> {
  const seen = new Set<FixtureName>();
  for (const launch of launches) {
    if (seen.has(launch.fixture)) continue;
    seen.add(launch.fixture);
    await assertFixture(launch.fixture);
  }
}

async function assertFixture(name: FixtureName): Promise<void> {
  const fixture = FIXTURES[name];
  const bytes = await readFile(path.join(REPO_ROOT, fixture.file));
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== fixture.bytes || digest !== fixture.sha256) {
    throw new Error(
      `${fixture.file} identity mismatch: ${bytes.length} bytes ${digest}, expected ${fixture.bytes} bytes ${fixture.sha256}`,
    );
  }
}

async function readRequiredRun(): Promise<VerifyRun> {
  const run = await readVerifyRun();
  if (run === null) throw new Error('Verify launch did not record runs/current.json');
  return run;
}

async function readVerifyRun(): Promise<VerifyRun | null> {
  try {
    return parseVerifyRun(await readFile(path.join(REPO_ROOT, HELPER_RUN), 'utf8'));
  } catch (cause) {
    if (cause instanceof Error && isEnoent(cause)) return null;
    throw cause;
  }
}

function isEnoent(cause: Error): boolean {
  return 'code' in cause && cause.code === 'ENOENT';
}

function parseVerifyRun(text: string): VerifyRun {
  const record = expectObject(parseJson(text), 'verify run');
  const web = own(record, 'webUrl');
  const vite = own(record, 'vitePid');
  return {
    pid: expectNumber(own(record, 'pid'), 'pid'),
    vitePid: vite === null || vite === undefined ? null : expectNumber(vite, 'vitePid'),
    cdpPort: expectNumber(own(record, 'cdpPort'), 'cdpPort'),
    webUrl: web === null || web === undefined ? null : expectString(web, 'webUrl'),
  };
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function machineFacts(argv: readonly string[], browsers: Partial<Record<Runtime, string>>): Promise<MachineFacts> {
  const cpus = os.cpus();
  const commit = await gitText(['rev-parse', '--short', 'HEAD']);
  const porcelain = await gitText(['status', '--porcelain']);
  return {
    recordedAt: new Date().toISOString(),
    commit,
    tree: porcelain.length === 0 ? 'clean' : 'modified',
    cpu: cpus[0]?.model ?? 'unknown cpu',
    cores: cpus.length,
    memoryGiB: Math.round(os.totalmem() / 1024 ** 3),
    loadAverage: os.loadavg()[0] ?? 0,
    osRelease: os.release(),
    node: process.version,
    browsers,
    command: argv.length === 0 ? 'pnpm -s perf:latency' : `pnpm -s perf:latency ${argv.join(' ')}`,
  };
}

function gitText(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', [...args], { cwd: REPO_ROOT, encoding: 'utf8' }, (cause, stdout) => {
      if (cause) reject(cause);
      else resolve(stdout.trim());
    });
  });
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} -> ${response.status}`);
  return response.text();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function usageText(): string {
  return [
    'Usage: pnpm -s perf:latency [--runtime <runtime>]... [--fixture <fixture>]... [--path <path>]... [--cold <n>] [--warm <n>]',
    '',
    '  --runtime  desktop | web                                   every runtime when absent',
    '  --fixture  phase-2-sample | large-phase-3-test             every fixture when absent',
    '  --path     open | sort | filter | search | edit-cell |',
    '             insert-column | delete-column | rename-column   every path when absent',
    '  --cold     cold samples per path, each its own launch      1 when absent, at least 1',
    '  --warm     warm samples per launch, a non-negative integer 3 when absent',
  ].join('\n');
}

function parseJson(text: string): JsonValue {
  // SAFETY: JSON.parse yields a JSON value. Callers reject any value this harness did not produce.
  return JSON.parse(text) as JsonValue;
}

function own(record: JsonObject, key: string): JsonValue | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  return record[key];
}

function stringField(record: JsonObject, key: string): string {
  const value = own(record, key);
  if (value === undefined) return '';
  return expectString(value, key);
}

function expectObject(value: JsonValue | undefined, label: string): JsonObject {
  if (value === undefined || jsonKind(value) !== 'object') throw new Error(`${label} must be an object`);
  // SAFETY: jsonKind confirmed a non-null JSON object.
  return value as JsonObject;
}

function expectString(value: JsonValue | undefined, label: string): string {
  if (value === undefined || jsonKind(value) !== 'string') throw new Error(`${label} must be a string`);
  // SAFETY: jsonKind confirmed a JSON string.
  return value as string;
}

function expectNumber(value: JsonValue | undefined, label: string): number {
  if (value === undefined || jsonKind(value) !== 'number') throw new Error(`${label} must be a finite number`);
  // SAFETY: jsonKind confirmed a JSON number. JSON has no NaN or infinity.
  const number = value as number;
  if (!Number.isFinite(number)) throw new Error(`${label} must be a finite number`);
  return number;
}

function jsonKind(value: JsonValue): 'null' | 'boolean' | 'number' | 'string' | 'array' | 'object' {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const tag = Object.prototype.toString.call(value);
  if (tag === '[object Boolean]') return 'boolean';
  if (tag === '[object Number]') return 'number';
  if (tag === '[object String]') return 'string';
  if (tag === '[object Object]') return 'object';
  throw new Error('Unsupported JSON value');
}

const launchedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (launchedDirectly) {
  try {
    process.on('SIGINT', () => {
      stopOwnedSession();
      process.exit(130);
    });
    await main(process.argv.slice(2));
  } catch (cause) {
    if (cause instanceof UsageError) {
      process.stderr.write(`${cause.message}\n${usageText()}\n`);
      process.exitCode = 2;
    } else {
      const message = cause instanceof Error ? (cause.stack ?? cause.message) : 'Latency run failed';
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    }
  }
}
