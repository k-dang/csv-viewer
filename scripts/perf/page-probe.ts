import type { Field, Mark, MarkKind, RawTimeline, StartEvent, Target } from './latency-plan.ts';

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

type JsonObject = { readonly [key: string]: JsonValue };
type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
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

function parseJson(text: string): JsonValue {
  // SAFETY: JSON.parse yields a JSON value. Callers reject any value this probe did not produce.
  return JSON.parse(text) as JsonValue;
}

function own(record: JsonObject, key: string): JsonValue | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  return record[key];
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

function isMarkKind(value: string): value is MarkKind {
  return MARK_KINDS.some((kind) => kind === value);
}

/**
 * Runs in the page. A second install keeps the first. It reads the DOM and never calls into the product API.
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

  function statusNode() {
    return document.querySelector('.csv-view > :last-child > [aria-live="polite"]');
  }

  function statusText() {
    return textOf(statusNode());
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
    if (field === 'filter-input') return document.querySelector('.ag-popup .ag-filter-body input, .ag-menu .ag-filter-body input');
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
    if (mark.kind === 'querying') return statusText() === 'Querying';
    if (mark.kind === 'ready') return statusText() === 'Ready';
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
    const status = statusText();
    if (status === 'Query failed') {
      sample.failed = 'Query failed';
      sample.state = 'complete';
      finish(sample);
      return;
    }
    if (sample.state === 'armed') return;
    if (sample.state === 'started' && status === 'Querying') sample.state = 'querying';
    for (let index = 0; index < sample.marks.length; index += 1) {
      if (sample.times[index] !== null) continue;
      const mark = sample.marks[index];
      if (mark.kind === 'ready') {
        if (sample.state !== 'querying' || status !== 'Ready') continue;
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
