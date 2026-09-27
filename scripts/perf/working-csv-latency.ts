import { execFile, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  FIXTURES,
  START_EVENT,
  UsageError,
  VIEWPORT,
  formatReport,
  launchSteps,
  parseSession,
  planRun,
} from './latency-plan.ts';
import type {
  Field,
  FixtureName,
  LaunchPlan,
  LaunchStep,
  MachineFacts,
  PathName,
  RawTimeline,
  Runtime,
  Sample,
  SamplePlan,
  Step,
  Target,
  UserInput,
  ViewportSize,
} from './latency-plan.ts';
import { SAMPLE_TIMEOUT_MS, attachProbe } from './page-probe.ts';
import type { Probe, ViewportPoint } from './page-probe.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const HELPER = '.claude/skills/verify-csv-viewer/bin/control-csv-viewer.mjs';
const HELPER_RUN = '.claude/skills/verify-csv-viewer/runs/current.json';
const QUIET_MS = 300;
const PAGE_WAIT_MS = 10_000;

type Page = {
  browser: string;
  sample(plan: SamplePlan<PathName>): Promise<RawTimeline>;
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
  const samples: Sample[] = [];
  for (const step of launchSteps(launch)) {
    samples.push(...(await runLaunchStep(page, step)));
  }
  return samples;
}

async function runLaunchStep(page: Page, step: LaunchStep): Promise<Sample[]> {
  switch (step.kind) {
    case 'steps':
      await page.steps(step.steps);
      return [];
    case 'sample':
      return [step.finish(await page.sample(step.plan))];
    default: {
      const unreachable: never = step;
      throw new Error(`Unexpected launch step ${unreachable}`);
    }
  }
}

async function withFreshApp<T>(launch: LaunchPlan, use: (page: Page) => Promise<T>): Promise<T> {
  ownsSession = true;
  let socket: Cdp | null = null;
  try {
    await runHelper(launchArgs(launch));
    const run = await readRequiredRun();
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
    return await use(createPage(cdp, probe, browserFact(launch.runtime, version)));
  } catch (cause) {
    await explainFailure(launch);
    throw cause;
  } finally {
    socket?.close();
    await cleanupOwnedSession();
  }
}

function createPage(cdp: Cdp, probe: Probe, browser: string): Page {
  return {
    browser,
    sample: (plan) => runSample(cdp, probe, plan),
    steps: (steps) => playSteps(cdp, probe, steps),
  };
}

async function runSample(cdp: Cdp, probe: Probe, plan: SamplePlan<PathName>): Promise<RawTimeline> {
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
  if (!ownsSession) return;
  ownsSession = false;
  signalOwnedGroups();
  await runHelper(['cleanup']);
}

function stopOwnedSession(): void {
  if (!ownsSession) return;
  ownsSession = false;
  signalOwnedGroups();
  spawnSync(process.execPath, [path.join(REPO_ROOT, HELPER), 'cleanup'], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 2, 2],
  });
}

function signalOwnedGroups(): void {
  const run = ownedRun ?? readOwnedRunSync();
  ownedRun = null;
  if (run === null) return;
  // The helper records detached leaders. Signaling the group also stops children
  // such as Vite, which survive a signal sent only to that leader.
  signalProcessGroup(run.pid);
  signalProcessGroup(run.vitePid);
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
    '  --cold     cold samples per path, each its own launch      1 when absent',
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
