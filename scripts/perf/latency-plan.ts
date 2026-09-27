import path from 'node:path';
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

/** The marks a timed input may wait on. Edit text renders before csv.edit-cell returns, so edit-cell has no cell stop. */
type StopKinds = {
  open: 'title' | 'cell' | 'count' | 'columns';
  sort: 'querying' | 'ready' | 'cell';
  filter: 'querying' | 'ready' | 'cell' | 'count';
  search: 'querying' | 'ready' | 'cell' | 'count';
  'edit-cell': 'dirty' | 'querying' | 'ready';
  'insert-column': 'dirty' | 'header' | 'cell';
  'delete-column': 'dirty' | 'header' | 'querying' | 'ready';
  'rename-column': 'dirty' | 'header' | 'cell';
};
export type TimedMark<P extends PathName> = Extract<Mark, { kind: StopKinds[P] }>;

/**
 * A reported duration. A filter clock that starts at the input runs through the grid's filter
 * debounce, so that interval carries the label instead of subtracting a fixed delay.
 */
export type Interval<P extends PathName> = P extends 'filter'
  ? { from: 'querying'; to: 'ready' } | { from: 'input'; to: 'cell'; includes: 'filter debounce' }
  : { from: 'input' | Extract<StopKinds[P], 'querying'>; to: Exclude<StopKinds[P], 'querying'> };

export type Field = 'search' | 'filter-input' | 'cell-editor' | 'column-name';
export type MenuItem = 'Rename column' | 'Insert column left' | 'Delete column';

/** Where an input lands. page-probe.ts owns every selector behind these names. */
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

/** The trusted DOM event whose timeStamp starts the clock for each input kind. */
export const START_EVENT = {
  drop: 'drop',
  click: 'click',
  'double-click': 'dblclick',
  'right-click': 'contextmenu',
  fill: 'input',
  key: 'keydown',
} as const satisfies Record<UserInput['kind'], StartEvent>;

/** An untimed input and the marks that must hold after it. */
export type Step = { input: UserInput; until: readonly Mark[] };

export type SamplePlan<P extends PathName> = {
  /** Checked on a quiet DOM before every sample. A reset that did not converge fails the run here. */
  startsFrom: readonly Mark[];
  arrange: readonly Step[];
  act: UserInput;
  /** Kinds are unique. All must hold after the act, and no level mark may hold before it. */
  marks: readonly [TimedMark<P>, ...TimedMark<P>[]];
  /** Returns the page to startsFrom between two samples of the same path. */
  reset: readonly Step[];
};

export type PathRecipe<P extends PathName> = {
  plan(fixture: Fixture): SamplePlan<P>;
  /** Headline first. */
  report: readonly [Interval<P>, ...Interval<P>[]];
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
      // The filter popup closes when a large grid refreshes, so the input is gone.
      // Escape is a no-op once it has closed. Clear query restores the unfiltered rows.
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
} satisfies { [P in PathName]: PathRecipe<P> };

/** One fresh app process for one cold sample. Warm samples stay in that launch. Only the first desktop launch rebuilds. */
export type LaunchPlan =
  | { runtime: 'desktop'; build: 'rebuild' | 'reuse'; fixture: FixtureName; path: PathName; warm: number }
  | { runtime: 'web'; fixture: FixtureName; path: PathName; warm: number };

export type RawTimeline = { input: number; marks: readonly number[] };

export type Sample = {
  runtime: Runtime;
  fixture: FixtureName;
  path: PathName;
  phase: Phase;
  /** In report order, headline first. */
  intervals: readonly { label: string; ms: number }[];
};

/** What one launch does, in order. The shell walks the list and knows no path. */
export type LaunchStep =
  | { kind: 'steps'; steps: readonly Step[] }
  | { kind: 'sample'; path: PathName; phase: Phase; plan: SamplePlan<PathName>; finish(raw: RawTimeline): Sample };

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

export type ReportedInterval = {
  from: 'input' | 'querying';
  to: MarkKind;
  includes?: 'filter debounce';
};

export class UsageError extends Error {}

const DEFAULT_COLD = 1;
const DEFAULT_WARM = 3;

/**
 * Parses argv and expands it to one plan per cold sample, in registry order.
 * `--runtime`, `--fixture`, and `--path` repeat. A missing flag means every value.
 * `--cold` defaults to 1 and `--warm` defaults to 3.
 */
export function planRun(argv: readonly string[]): readonly LaunchPlan[] {
  const flags = parseFlags(argv);
  const runtimes = choose('runtime', RUNTIMES, flags.runtime);
  const fixtures = choose('fixture', FIXTURE_NAMES, flags.fixture);
  const paths = choose('path', PATHS, flags.path);
  const cold = countFlag('cold', flags.cold, DEFAULT_COLD);
  const warm = countFlag('warm', flags.warm, DEFAULT_WARM);
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

function countFlag(label: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  if (!/^(?:0|[1-9]\d*)$/.test(raw)) {
    throw new UsageError(`--${label} must be a non-negative integer.`);
  }
  return Number(raw);
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

/**
 * open: cold sample, then each warm sample is the open reset plus another sample.
 * others: an untimed open, the cold sample, then each warm sample is the path reset plus another sample.
 */
export function launchSteps(launch: LaunchPlan): readonly LaunchStep[] {
  const fixture = FIXTURES[launch.fixture];
  const steps: LaunchStep[] = [];
  if (launch.path !== 'open') {
    const opened = RECIPES.open.plan(fixture);
    steps.push({ kind: 'steps', steps: [{ input: opened.act, until: opened.marks }] });
  }
  steps.push(sampleStep(launch, 'cold'));
  for (let index = 0; index < launch.warm; index += 1) {
    steps.push({ kind: 'steps', steps: RECIPES[launch.path].plan(fixture).reset });
    steps.push(sampleStep(launch, 'warm'));
  }
  return steps;
}

function sampleStep(launch: LaunchPlan, phase: Phase): LaunchStep {
  const plan = RECIPES[launch.path].plan(FIXTURES[launch.fixture]);
  return {
    kind: 'sample',
    path: launch.path,
    phase,
    plan,
    finish(raw: RawTimeline): Sample {
      return finishSample(launch, phase, plan, raw);
    },
  };
}

function finishSample(launch: LaunchPlan, phase: Phase, plan: SamplePlan<PathName>, raw: RawTimeline): Sample {
  if (raw.marks.length !== plan.marks.length) {
    throw new Error(
      `${launch.runtime} ${launch.fixture} ${launch.path} expected ${plan.marks.length} mark times and got ${raw.marks.length}`,
    );
  }
  const intervals = reportedIntervals(launch.path).map((interval) => {
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

function reportedIntervals(pathName: PathName): readonly ReportedInterval[] {
  switch (pathName) {
    case 'open':
      return RECIPES.open.report;
    case 'sort':
      return RECIPES.sort.report;
    case 'filter':
      return RECIPES.filter.report;
    case 'search':
      return RECIPES.search.report;
    case 'edit-cell':
      return RECIPES['edit-cell'].report;
    case 'insert-column':
      return RECIPES['insert-column'].report;
    case 'delete-column':
      return RECIPES['delete-column'].report;
    case 'rename-column':
      return RECIPES['rename-column'].report;
    default: {
      const unreachable: never = pathName;
      throw new Error(`Unexpected path ${unreachable}`);
    }
  }
}

function markTime(plan: SamplePlan<PathName>, raw: RawTimeline, kind: MarkKind): number | undefined {
  const index = plan.marks.findIndex((mark) => mark.kind === kind);
  if (index < 0) return undefined;
  return raw.marks[index];
}

function intervalLabel(interval: ReportedInterval): string {
  const base = `${interval.from}-to-${interval.to}`;
  if (interval.includes === undefined) return base;
  return `${base}, includes ${interval.includes}`;
}

/** Any non-empty CI value except "false" and "0" means CI. */
export function parseSession(ci: string | undefined): Session {
  if (ci === undefined || ci.length === 0 || ci === 'false' || ci === '0') return 'local';
  return 'ci';
}

const TABLE_HEADER =
  '| runtime | fixture | path | phase | interval | median ms | samples ms | bytes | rows | columns | os | session |';
const TABLE_DIVIDER = '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |';

/**
 * The facts as a bullet list, then one table. One row per runtime, fixture, path, phase, and interval.
 * The median and samples are whole milliseconds, and samples stay in run order.
 */
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
