import { describe, expect, it } from 'vitest';
import {
  FIXTURES,
  PATHS,
  RECIPES,
  finishSample,
  formatReport,
  parseSession,
  planRun,
} from './working-csv-latency';
import type { Environment, MachineFacts, Sample } from './working-csv-latency';

describe('planRun', () => {
  it('keeps registry order when flags repeat', () => {
    expect(
      planRun(['--path', 'filter', '--path', 'sort', '--runtime', 'web', '--fixture', 'phase-2-sample', '--warm', '2']),
    ).toEqual([
      { runtime: 'web', fixture: 'phase-2-sample', path: 'sort', warm: 2 },
      { runtime: 'web', fixture: 'phase-2-sample', path: 'filter', warm: 2 },
    ]);
  });

  it('rebuilds only the first desktop launch', () => {
    expect(
      planRun(['--runtime', 'desktop', '--fixture', 'phase-2-sample', '--path', 'open', '--path', 'sort', '--warm', '1']),
    ).toEqual([
      { runtime: 'desktop', build: 'rebuild', fixture: 'phase-2-sample', path: 'open', warm: 1 },
      { runtime: 'desktop', build: 'reuse', fixture: 'phase-2-sample', path: 'sort', warm: 1 },
    ]);
  });

  it('gives each cold sample its own launch and defaults warm to 3', () => {
    expect(planRun(['--runtime', 'web', '--fixture', 'phase-2-sample', '--path', 'open'])).toEqual([
      { runtime: 'web', fixture: 'phase-2-sample', path: 'open', warm: 3 },
    ]);
    expect(
      planRun(['--runtime', 'desktop', '--fixture', 'phase-2-sample', '--path', 'open', '--cold', '2', '--warm', '0']),
    ).toEqual([
      { runtime: 'desktop', build: 'rebuild', fixture: 'phase-2-sample', path: 'open', warm: 0 },
      { runtime: 'desktop', build: 'reuse', fixture: 'phase-2-sample', path: 'open', warm: 0 },
    ]);
  });

  it('names the valid paths when a path is unknown', () => {
    expect(() => planRun(['--path', 'sorting'])).toThrow(
      'Unknown path "sorting". Valid paths are open, sort, filter, search, edit-cell, insert-column, delete-column, rename-column.',
    );
  });
});

describe('finish', () => {
  it('labels the filter debounce and the querying edge', () => {
    const cold = { runtime: 'web', fixture: 'phase-2-sample', path: 'filter', warm: 0 } as const;
    expect(finishSample(cold, 'cold', { input: 100, marks: [1640, 1690, 1702, 1702] })).toEqual({
      runtime: 'web',
      fixture: 'phase-2-sample',
      path: 'filter',
      phase: 'cold',
      intervals: [
        { label: 'input-to-cell, includes filter debounce', ms: 1602 },
        { label: 'querying-to-ready', ms: 50 },
      ],
    });
  });

  it('prints only input-to-cell for open', () => {
    const cold = { runtime: 'web', fixture: 'phase-2-sample', path: 'open', warm: 0 } as const;
    expect(finishSample(cold, 'cold', { input: 0, marks: [40, 80, 40, 40] }).intervals).toEqual([{ label: 'input-to-cell', ms: 80 }]);
  });

  it('fails a sample whose mark times do not match the plan', () => {
    const cold = { runtime: 'web', fixture: 'phase-2-sample', path: 'filter', warm: 0 } as const;
    expect(() => finishSample(cold, 'cold', { input: 100, marks: [1640, 1690, 1702] })).toThrow(
      'web phase-2-sample filter expected 4 mark times and got 3',
    );
  });
});

describe('formatReport', () => {
  it('prints medians in run order with the viewport fact', () => {
    const facts: MachineFacts = {
      recordedAt: '2026-09-27T00:00:00.000Z',
      commit: 'abc1234',
      tree: 'clean',
      cpu: 'Test CPU',
      cores: 4,
      memoryGiB: 8,
      loadAverage: 0.5,
      osRelease: '6.12.0',
      node: 'v24.21.0',
      browsers: { web: 'Chrome 131.0.0.0' },
      command: 'pnpm -s perf:latency --runtime web --fixture phase-2-sample --path sort --warm 2',
    };
    const environment: Environment = { os: 'linux', session: 'local' };
    const samples: Sample[] = [
      sample('cold', [
        { label: 'input-to-cell', ms: 40 },
        { label: 'querying-to-ready', ms: 10 },
      ]),
      sample('warm', [
        { label: 'input-to-cell', ms: 20 },
        { label: 'querying-to-ready', ms: 8 },
      ]),
      sample('warm', [
        { label: 'input-to-cell', ms: 22 },
        { label: 'querying-to-ready', ms: 10 },
      ]),
    ];
    expect(formatReport(facts, environment, samples)).toBe(
      [
        '- Recorded at 2026-09-27T00:00:00.000Z',
        '- Commit abc1234, working tree clean',
        '- CPU Test CPU, 4 cores, 8 GiB memory, load average 0.5',
        '- OS linux 6.12.0',
        '- Node v24.21.0. Web Chrome 131.0.0.0.',
        '- viewport: 1440x900',
        '- Command `pnpm -s perf:latency --runtime web --fixture phase-2-sample --path sort --warm 2`',
        '',
        '| runtime | fixture | path | phase | interval | median ms | samples ms | bytes | rows | columns | os | session |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        '| web-dev | phase-2-sample | sort | cold | input-to-cell | 40 | 40 | 656 | 5 | 10 | linux | local |',
        '| web-dev | phase-2-sample | sort | cold | querying-to-ready | 10 | 10 | 656 | 5 | 10 | linux | local |',
        '| web-dev | phase-2-sample | sort | warm | input-to-cell | 21 | 20 22 | 656 | 5 | 10 | linux | local |',
        '| web-dev | phase-2-sample | sort | warm | querying-to-ready | 9 | 8 10 | 656 | 5 | 10 | linux | local |',
        '',
      ].join('\n'),
    );
  });
});

describe('parseSession', () => {
  it('treats false, 0, empty, and absent as local', () => {
    expect(parseSession('true')).toBe('ci');
    expect(parseSession('1')).toBe('ci');
    expect(parseSession('')).toBe('local');
    expect(parseSession('false')).toBe('local');
    expect(parseSession('0')).toBe('local');
    expect(parseSession(undefined)).toBe('local');
  });
});

describe('RECIPES', () => {
  it('gives every reported endpoint a unique mark', () => {
    for (const fixtureName of ['phase-2-sample', 'large-phase-3-test'] as const) {
      for (const pathName of PATHS) {
        const plan = RECIPES[pathName].plan(FIXTURES[fixtureName]);
        const kinds = plan.marks.map((mark) => mark.kind);
        expect(new Set(kinds).size).toBe(kinds.length);
        for (const interval of RECIPES[pathName].report) {
          if (interval.from !== 'input') expect(kinds).toContain(interval.from);
          expect(kinds).toContain(interval.to);
        }
      }
    }
  });
});

function sample(phase: 'cold' | 'warm', intervals: Sample['intervals']): Sample {
  return { runtime: 'web', fixture: 'phase-2-sample', path: 'sort', phase, intervals };
}
