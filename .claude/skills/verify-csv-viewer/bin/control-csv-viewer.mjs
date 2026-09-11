#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const skillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(skillDir, '../../..');
const desktopAppRoot = path.join(repoRoot, 'apps/desktop');
const webAppRoot = path.join(repoRoot, 'apps/web');
const runsDir = path.join(skillDir, 'runs');
const currentRunPath = path.join(runsDir, 'current.json');
const defaultCdpPort = 19322;
// Deliberately not Vite 5173: that port is shared with any dev server the user already has open.
const defaultWebPort = 19323;
const launchTimeoutMs = 45_000;

const commands = {
  launch: runLaunch,
  doctor: runDoctor,
  cleanup: runCleanup,
  snapshot: runSnapshot,
  screenshot: runScreenshot,
  click: runClick,
  fill: runFill,
  type: runType,
  press: runPress,
  wait: runWait,
  text: runText,
  upload: runUpload,
};

function parseFlags(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function fail(message, extra) {
  if (extra) console.error(extra);
  console.error(message);
  process.exit(1);
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readCurrentRun() {
  if (!(await pathExists(currentRunPath))) return null;
  try {
    return JSON.parse(await fs.readFile(currentRunPath, 'utf8'));
  } catch {
    return null;
  }
}

async function requireCurrentRun() {
  const run = await readCurrentRun();
  if (!run) fail('No verification run is recorded. Launch with `launch` first.');
  if (!isPidAlive(run.pid)) {
    fail(
      `Recorded pid ${run.pid} is not running. Call cleanup, then launch a new instance.`,
    );
  }
  return run;
}

function findFreePort(preferred) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', () => {
      const fallback = net.createServer();
      fallback.unref();
      fallback.on('error', reject);
      fallback.listen(0, '127.0.0.1', () => {
        const address = fallback.address();
        fallback.close(() => resolve(address.port));
      });
    });
    server.listen(preferred, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function runProcess(commandName, args, options = {}) {
  return new Promise((resolve, reject) => {
    const executable = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : commandName;
    const processArgs =
      process.platform === 'win32' ? ['/d', '/s', '/c', [commandName, ...args].join(' ')] : args;
    const child = spawn(executable, processArgs, {
      cwd: repoRoot,
      stdio: 'inherit',
      shell: false,
      env: options.env ?? process.env,
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${commandName} ${args.join(' ')} exited ${code}`));
    });
  });
}

async function ensureBuilt(rebuild) {
  const mainJs = path.join(desktopAppRoot, 'dist-electron/main.cjs');
  const rendererIndex = path.join(desktopAppRoot, 'dist-renderer/index.html');
  const electronJs = path.join(desktopAppRoot, 'scripts/launch-electron.cjs');
  if (!(await pathExists(electronJs))) fail('Missing apps/desktop/scripts/launch-electron.cjs');
  if (!(await pathExists(path.join(repoRoot, 'node_modules')))) {
    await runProcess('pnpm', ['install']);
  }
  if (rebuild || !(await pathExists(mainJs)) || !(await pathExists(rendererIndex))) {
    await runProcess('pnpm', ['run', 'build:desktop']);
  }
  if (!(await pathExists(mainJs)) || !(await pathExists(rendererIndex))) {
    fail('Desktop build did not produce apps/desktop/dist-electron/main.cjs and apps/desktop/dist-renderer/index.html');
  }
}

/**
 * Finds a Chromium to drive. Honours CSV_VIEWER_VERIFY_BROWSER first so a machine with an unusual
 * install, or a CI image, can point at its own binary instead of patching this list.
 */
async function findBrowser() {
  const override = process.env.CSV_VIEWER_VERIFY_BROWSER;
  if (override) {
    if (!(await pathExists(override))) fail(`CSV_VIEWER_VERIFY_BROWSER points at a missing file: ${override}`);
    return override;
  }
  const windowsRoots = [
    process.env.PROGRAMFILES ?? 'C:/Program Files',
    process.env['PROGRAMFILES(X86)'] ?? 'C:/Program Files (x86)',
    process.env.LOCALAPPDATA,
  ].filter(Boolean);
  const candidates =
    process.platform === 'win32'
      ? windowsRoots.flatMap((root) => [
          path.join(root, 'Google/Chrome/Application/chrome.exe'),
          path.join(root, 'Microsoft/Edge/Application/msedge.exe'),
        ])
      : process.platform === 'darwin'
        ? [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
          ]
        : [
            '/usr/bin/google-chrome',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/usr/bin/microsoft-edge',
          ];
  for (const candidate of candidates) {
    if (candidate && (await pathExists(candidate))) return candidate;
  }
  fail(
    'No Chrome, Edge or Chromium was found for the web target. Install one, or set CSV_VIEWER_VERIFY_BROWSER to its path.',
  );
}

/**
 * Pre-seeds the throwaway profile so Export CSV lands in the run directory instead of raising a
 * Save As dialog. Chrome reads this before its first paint, so it needs no live CDP connection.
 */
async function seedBrowserDownloadPreferences(userDataDir, downloadDir) {
  const profileDir = path.join(userDataDir, 'Default');
  await fs.mkdir(profileDir, { recursive: true });
  await fs.mkdir(downloadDir, { recursive: true });
  const preferences = {
    download: { default_directory: downloadDir, prompt_for_download: false, directory_upgrade: true },
    savefile: { default_directory: downloadDir },
    profile: { default_content_setting_values: { automatic_downloads: 1 } },
  };
  await fs.writeFile(path.join(profileDir, 'Preferences'), JSON.stringify(preferences), 'utf8');
}

/** Starts the web dev server the same way `pnpm run dev:web` does, on a port private to this run. */
async function startWebDevServer(port, logFd) {
  // No '--' separator: pnpm forwards it to vite as a literal argument, vite then ignores the
  // port flags and binds 5173, which is the shared port this skill must never touch.
  const args = ['--filter', '@csv-viewer/web', 'dev', '--port', String(port), '--strictPort'];
  const executable = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'pnpm';
  const processArgs = process.platform === 'win32' ? ['/d', '/s', '/c', ['pnpm', ...args].join(' ')] : args;
  const child = spawn(executable, processArgs, {
    cwd: repoRoot,
    stdio: ['ignore', logFd, logFd],
    detached: true,
    windowsHide: true,
  });
  child.unref();
  try {
    await waitForHttp(`http://127.0.0.1:${port}/index.html`, launchTimeoutMs);
  } catch (error) {
    await killPid(child.pid);
    throw error;
  }
  return child.pid;
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
      lastError = new Error(`${url} -> ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw lastError ?? new Error(`Timed out fetching ${url}`);
}

async function ensureWebDeps() {
  if (!(await pathExists(path.join(repoRoot, 'node_modules')))) {
    await runProcess('pnpm', ['install']);
  }
  if (!(await pathExists(path.join(webAppRoot, 'index.html')))) {
    fail('Missing apps/web/index.html');
  }
}

async function seedRecentFiles(userDataDir) {
  const fixtures = [
    path.join(repoRoot, 'fixtures/phase-2-sample.csv'),
    path.join(repoRoot, 'fixtures/phase-2-sample-edited.csv'),
  ];
  const recentFiles = [];
  for (const filePath of fixtures) {
    if (!(await pathExists(filePath))) fail(`Missing fixture ${filePath}`);
    const stats = await fs.stat(filePath);
    recentFiles.push({
      path: filePath,
      name: path.basename(filePath),
      sizeBytes: stats.size,
      lastOpenedAt: new Date().toISOString(),
    });
  }
  await fs.mkdir(userDataDir, { recursive: true });
  await fs.writeFile(
    path.join(userDataDir, 'recent-files.json'),
    `${JSON.stringify(recentFiles, null, 2)}\n`,
    'utf8',
  );
  return recentFiles;
}

async function waitForJson(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
      lastError = new Error(`${url} -> ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw lastError ?? new Error(`Timed out fetching ${url}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAppPage(target, webUrl) {
  if (!target || target.type !== 'page') return false;
  const url = String(target.url ?? '');
  if (url.startsWith('devtools://') || url.startsWith('chrome://')) return false;
  const title = String(target.title ?? '');
  // On web the run owns an exact origin, so prefer that over guessing at titles: a fresh browser
  // profile can hold a new-tab page whose title briefly matches nothing useful.
  if (webUrl) return url.startsWith(new URL(webUrl).origin);
  return title === 'CSV Viewer' || url.includes('dist-renderer') || url.includes('index.html');
}

async function waitForAppPage(cdpPort, timeoutMs, webUrl) {
  const deadline = Date.now() + timeoutMs;
  let lastTargets = [];
  while (Date.now() < deadline) {
    try {
      lastTargets = await waitForJson(`http://127.0.0.1:${cdpPort}/json/list`, 1000);
      const page = lastTargets.find((target) => isAppPage(target, webUrl));
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      // CDP is not up yet.
    }
    await sleep(250);
  }
  throw new Error(
    `Timed out waiting for the CSV Viewer renderer on CDP port ${cdpPort}. Targets: ${JSON.stringify(lastTargets)}`,
  );
}

class CdpSession {
  constructor(webSocketUrl) {
    this.webSocketUrl = webSocketUrl;
    this.nextId = 0;
    this.pending = new Map();
    this.eventWaiters = new Map();
    this.ws = null;
  }

  async open() {
    this.ws = new WebSocket(this.webSocketUrl);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', () => reject(new Error('CDP WebSocket failed')), {
        once: true,
      });
    });
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id == null) {
        const waiter = this.eventWaiters.get(message.method);
        if (waiter) {
          this.eventWaiters.delete(message.method);
          waiter.resolve(message.params);
        }
        return;
      }
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      else waiter.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = (this.nextId += 1);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Resolves with the next payload for a CDP event, or rejects once timeoutMs elapses. */
  waitForEvent(method, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.eventWaiters.delete(method);
        reject(new Error(`Timed out waiting for CDP event ${method}`));
      }, timeoutMs);
      this.eventWaiters.set(method, {
        resolve: (params) => {
          clearTimeout(timer);
          resolve(params);
        },
      });
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      const text =
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        'Runtime.evaluate failed';
      throw new Error(text);
    }
    return result.result?.value;
  }

  close() {
    this.ws?.close();
  }
}

async function withCdp(run, fn) {
  const page = await waitForAppPage(run.cdpPort, 10_000, run.webUrl);
  const session = new CdpSession(page.webSocketDebuggerUrl);
  await session.open();
  await session.send('Runtime.enable');
  await session.send('Page.enable');
  try {
    return await fn(session, page);
  } finally {
    session.close();
  }
}

function inspectExpression(target) {
  // Web has no preload, so `window.csvViewer` never exists there. Its liveness proof is that the
  // app rendered past its own startup gate: the h1 stops reading "Checking browser support" or
  // "This browser cannot start CSV Viewer Web" and becomes the product title.
  const web = target === 'web';
  return `(async () => {
    const text = (document.body && document.body.innerText) || '';
    const title = document.title;
    const heading = document.querySelector('h1')?.textContent?.trim() || '';
    const fileHeading = document.querySelector('#metadata-title')?.textContent?.trim() || '';
    const emptyTitle = document.querySelector('#empty-state-title')?.textContent?.trim() || '';
    let hasHealth = false;
    let healthError = '';
    if (${web ? 'true' : 'false'}) {
      hasHealth = heading === 'CSV Viewer';
      if (!hasHealth) healthError = heading || 'CSV Viewer Web has not finished starting.';
    } else {
      try {
        const recentSources = await window.csvViewer.call({ operation: 'csv.get-recent-sources' });
        hasHealth = Array.isArray(recentSources);
      } catch (error) {
        healthError = error instanceof Error ? error.message : String(error);
      }
    }
    return {
      title,
      heading,
      fileHeading,
      emptyTitle,
      hasHealth,
      healthError,
      ready: heading === 'CSV Viewer' && hasHealth,
      textSnippet: text.replace(/\\s+/g, ' ').trim().slice(0, 2000),
    };
  })()`;
}

function snapshotExpression() {
  return `(() => {
    const lines = [];
    const skip = new Set(['SCRIPT', 'STYLE', 'PATH', 'SVG']);
    function roleOf(el) {
      return el.getAttribute('role') || el.tagName.toLowerCase();
    }
    function nameOf(el) {
      const labelledBy = el.getAttribute('aria-labelledby');
      const labelledText = labelledBy
        ? labelledBy.split(/\\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ')
        : '';
      const raw = [
        el.getAttribute('aria-label'),
        labelledText,
        el.getAttribute('title'),
        el.getAttribute('placeholder'),
        el.id === 'csv-delimiter' ? 'Delimiter' : '',
        el.id === 'csv-header-mode' ? 'Header mode' : '',
        el.id === 'global-search' ? 'Global search' : '',
        [...el.childNodes]
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent || '')
          .join(' '),
      ]
        .join(' ')
        .replace(/\\s+/g, ' ')
        .trim();
      return raw;
    }
    function walk(el, depth) {
      if (!el || el.nodeType !== Node.ELEMENT_NODE) return;
      if (skip.has(el.tagName)) return;
      const role = roleOf(el);
      const name = nameOf(el);
      const interesting =
        ['button', 'tab', 'dialog', 'searchbox', 'textbox', 'heading', 'checkbox', 'grid', 'gridcell', 'main', 'banner'].includes(role) ||
        ['BUTTON', 'H1', 'H2', 'H3', 'INPUT', 'TEXTAREA', 'MAIN', 'HEADER'].includes(el.tagName) ||
        el.getAttribute('aria-label');
      if (interesting && (name || ['main', 'dialog', 'grid'].includes(role))) {
        lines.push(\`\${'  '.repeat(depth)}\${role}\${name ? ': ' + name.slice(0, 160) : ''}\`);
      }
      const nextDepth = interesting ? depth + 1 : depth;
      for (const child of el.children) walk(child, nextDepth);
    }
    walk(document.body, 0);
    return {
      title: document.title,
      text: (document.body.innerText || '').trim(),
      ax: lines.join('\\n'),
    };
  })()`;
}

function findControlExpression({ role, name, exact, nth }) {
  const escaped = String(name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const payload = JSON.stringify({
    role: role || '',
    name: name || '',
    exact: Boolean(exact),
    escaped,
    nth: nth == null ? null : Number(nth),
  });
  return `(() => {
    const { role, name, exact, escaped, nth } = ${payload};
    const nameRe = exact || !name ? null : new RegExp(escaped, 'i');
    function accessibleName(el) {
      const labelledBy = el.getAttribute('aria-labelledby');
      const labelledText = labelledBy
        ? labelledBy.split(/\\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ')
        : '';
      const labelledFor = el.id ? document.querySelector(\`label[for="\${el.id}"]\`)?.textContent || '' : '';
      const wrappingLabel = el.closest('label')?.textContent || '';
      return [
        el.getAttribute('aria-label'),
        labelledText,
        labelledFor,
        wrappingLabel,
        el.getAttribute('title'),
        el.getAttribute('placeholder'),
        el.innerText,
        el.value,
      ]
        .filter(Boolean)
        .join(' ')
        .replace(/\\s+/g, ' ')
        .trim();
    }
    function matchesName(el) {
      const value = accessibleName(el);
      if (!name) return true;
      if (exact) return value === name;
      return nameRe.test(value);
    }
    function roleMatches(el) {
      const computed = (el.getAttribute('role') || '').toLowerCase();
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute('type') || '').toLowerCase();
      switch (role) {
        case '':
          return true;
        case 'button':
          return tag === 'button' || computed === 'button';
        case 'tab':
          return computed === 'tab';
        case 'searchbox':
          return computed === 'searchbox' || (tag === 'input' && type === 'search');
        case 'textbox':
          return computed === 'textbox' || tag === 'textarea' || (tag === 'input' && type !== 'search' && type !== 'checkbox' && type !== 'button');
        case 'heading':
          return computed === 'heading' || /^h[1-6]$/.test(tag);
        case 'dialog':
          return computed === 'dialog';
        case 'checkbox':
          return computed === 'checkbox' || (tag === 'input' && type === 'checkbox');
        case 'gridcell':
          return computed === 'gridcell' || el.classList.contains('ag-cell');
        case 'combobox':
          return computed === 'combobox' || tag === 'select' || el.id === 'csv-header-mode';
        default:
          return computed === role || tag === role;
      }
    }
    const nodes = [...document.querySelectorAll('button, input, textarea, select, [role], .ag-cell, h1, h2, h3, label')];
    const matches = nodes.filter((el) => roleMatches(el) && matchesName(el) && el.getClientRects().length > 0);
    if (matches.length === 0) {
      return { status: 'missing', names: nodes.slice(0, 40).map((el) => accessibleName(el)).filter(Boolean) };
    }
    const scored = matches.map((el) => {
      const value = accessibleName(el);
      const primary = el.querySelector('.truncate')?.textContent?.trim() || '';
      let score = 0;
      if (primary === name || value === name) score += 10;
      if (el.getAttribute('aria-label') === name) score += 5;
      return { el, value, score };
    });
    scored.sort((a, b) => b.score - a.score);
    const tied = scored.length > 1 && scored[0].score === scored[1].score;
    if (tied && nth == null) {
      return { status: 'ambiguous', names: scored.map((item) => item.value) };
    }
    const pick = nth == null ? 0 : nth;
    if (!Number.isInteger(pick) || pick < 0 || pick >= scored.length) {
      return { status: 'missing', names: scored.map((item) => item.value) };
    }
    const winner = scored[pick].el;
    winner.scrollIntoView({ block: 'center', inline: 'center' });
    const box = winner.getBoundingClientRect();
    winner.dataset.verifyHit = '1';
    return {
      status: 'found',
      name: scored[pick].value,
      disabled: Boolean(winner.disabled) || winner.getAttribute('aria-disabled') === 'true',
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
    };
  })()`;
}

async function waitForReady(run, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await withCdp(run, (session) => session.evaluate(inspectExpression(run.target)));
    if (last?.ready) return last;
    await sleep(300);
  }
  throw new Error(`CSV Viewer renderer did not become healthy. Last inspect: ${JSON.stringify(last)}`);
}

async function runLaunch(options) {
  const existing = await readCurrentRun();
  if (existing && isPidAlive(existing.pid)) {
    fail(
      `A verification instance is already running (pid ${existing.pid}, CDP ${existing.cdpPort}). Reuse it or run cleanup first.`,
    );
  }
  const web = Boolean(options.web);
  const runId = `csv-viewer-${web ? 'web-' : ''}${Date.now().toString(36)}`;
  const runDir = path.join(runsDir, runId);
  const userDataDir = path.join(runDir, 'user-data');
  const downloadDir = path.join(runDir, 'downloads');
  await fs.mkdir(runDir, { recursive: true });
  const cdpPort = await findFreePort(defaultCdpPort);
  const logPath = path.join(runDir, web ? 'web.log' : 'electron.log');
  const log = await fs.open(logPath, 'w');
  const run = web
    ? await launchWeb({ runId, runDir, userDataDir, downloadDir, cdpPort, logPath, log })
    : await launchDesktop({ runId, runDir, userDataDir, cdpPort, logPath, log, rebuild: Boolean(options.rebuild) });
  await log.close();
  await fs.mkdir(runsDir, { recursive: true });
  await fs.writeFile(currentRunPath, `${JSON.stringify(run, null, 2)}
`, 'utf8');
  try {
    const inspect = await waitForReady(run, launchTimeoutMs);
    printJson({ status: 'ready', ...run, inspect });
  } catch (error) {
    await killPid(run.pid);
    await killPid(run.vitePid);
    fail(error instanceof Error ? error.message : String(error));
  }
}

async function launchDesktop({ runId, runDir, userDataDir, cdpPort, logPath, log, rebuild }) {
  await ensureBuilt(rebuild);
  const recentFiles = await seedRecentFiles(userDataDir);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VITE_DEV_SERVER_URL;
  const child = spawn(
    process.execPath,
    [
      path.join(desktopAppRoot, 'scripts/launch-electron.cjs'),
      `--remote-debugging-port=${cdpPort}`,
      '--remote-allow-origins=*',
      `--user-data-dir=${userDataDir}`,
      desktopAppRoot,
    ],
    { cwd: repoRoot, env, stdio: ['ignore', log.fd, log.fd], windowsHide: false, detached: true },
  );
  child.unref();
  return {
    id: runId,
    target: 'desktop',
    pid: child.pid,
    vitePid: null,
    cdpPort,
    webPort: null,
    webUrl: null,
    downloadDir: null,
    userDataDir,
    runDir,
    logPath,
    repoRoot,
    startedAt: new Date().toISOString(),
    recentFiles: recentFiles.map((file) => file.name),
  };
}

/**
 * Web runs the way a developer runs it: the real dev server, and a real browser pointed at it.
 * Nothing here is a stand-in, so a failure is the app's failure rather than the harness's.
 */
async function launchWeb({ runId, runDir, userDataDir, downloadDir, cdpPort, logPath, log }) {
  await ensureWebDeps();
  const browser = await findBrowser();
  const webPort = await findFreePort(defaultWebPort);
  const vitePid = await startWebDevServer(webPort, log.fd);
  const webUrl = `http://127.0.0.1:${webPort}/index.html`;
  await seedBrowserDownloadPreferences(userDataDir, downloadDir);
  const child = spawn(
    browser,
    [
      `--remote-debugging-port=${cdpPort}`,
      '--remote-allow-origins=*',
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,MediaRouter',
      // An unfocused window otherwise throttles rAF, so AG Grid never paints its rows and
      // text/wait see an empty grid the screenshot clearly shows. Runs are unfocused by definition.
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--disable-background-timer-throttling',
      '--window-size=1440,900',
      '--new-window',
      webUrl,
    ],
    { cwd: repoRoot, stdio: ['ignore', log.fd, log.fd], windowsHide: false, detached: true },
  );
  child.unref();
  return {
    id: runId,
    target: 'web',
    pid: child.pid,
    vitePid,
    cdpPort,
    webPort,
    webUrl,
    browser,
    downloadDir,
    userDataDir,
    runDir,
    logPath,
    repoRoot,
    startedAt: new Date().toISOString(),
    recentFiles: [],
  };
}

async function runDoctor() {
  const run = await readCurrentRun();
  if (!run) fail('No verification run is recorded.');
  const alive = isPidAlive(run.pid);
  const viteAlive = run.vitePid ? isPidAlive(run.vitePid) : null;
  let cdp = null;
  let inspect = null;
  let error = null;
  try {
    cdp = await waitForJson(`http://127.0.0.1:${run.cdpPort}/json/version`, 2000);
    inspect = await withCdp(run, (session) => session.evaluate(inspectExpression(run.target)));
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const report = {
    status: alive && inspect?.ready && viteAlive !== false ? 'ok' : 'unhealthy',
    target: run.target ?? 'desktop',
    pid: run.pid,
    alive,
    vitePid: run.vitePid ?? null,
    viteAlive,
    browser: run.browser ?? null,
    cdpPort: run.cdpPort,
    webUrl: run.webUrl ?? null,
    downloadDir: run.downloadDir ?? null,
    userDataDir: run.userDataDir,
    cdpBrowser: cdp?.Browser ?? null,
    inspect,
    error,
  };
  printJson(report);
  if (report.status !== 'ok') process.exit(2);
}

async function killPid(pid) {
  if (!pid || !isPidAlive(pid)) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // already gone
  }
}

async function runCleanup() {
  const run = await readCurrentRun();
  if (!run) {
    printJson({ status: 'idle' });
    return;
  }
  await killPid(run.pid);
  await killPid(run.vitePid);
  const deadline = Date.now() + 8000;
  while ((isPidAlive(run.pid) || isPidAlive(run.vitePid)) && Date.now() < deadline) await sleep(200);
  if (isPidAlive(run.pid)) fail(`Failed to stop pid ${run.pid}`);
  if (isPidAlive(run.vitePid)) fail(`Failed to stop dev server pid ${run.vitePid}`);
  await sleep(500);
  await removeWithRetry(run.runDir, 10_000);
  await fs.rm(currentRunPath, { force: true });
  printJson({
    status: 'cleaned',
    pid: run.pid,
    vitePid: run.vitePid ?? null,
    removedRunDir: run.runDir,
    evidenceKeptAt: path.join(skillDir, 'evidence'),
  });
}

async function removeWithRetry(target, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await sleep(400);
    }
  }
  throw lastError ?? new Error(`Unable to remove ${target}`);
}

function resolveArtifactPath(rawPath) {
  if (!rawPath) fail('Missing --path');
  return path.isAbsolute(rawPath) ? rawPath : path.join(skillDir, rawPath);
}

async function runSnapshot(options) {
  const run = await requireCurrentRun();
  const artifactPath = resolveArtifactPath(options.path);
  const snapshot = await withCdp(run, (session) => session.evaluate(snapshotExpression()));
  await fs.mkdir(path.dirname(artifactPath), { recursive: true });
  const body = [
    `title: ${snapshot.title}`,
    '',
    '== visible text ==',
    snapshot.text,
    '',
    '== ax ==',
    snapshot.ax,
    '',
  ].join('\n');
  await fs.writeFile(artifactPath, body, 'utf8');
  printJson({ status: 'ok', path: artifactPath, title: snapshot.title });
}

async function runScreenshot(options) {
  const run = await requireCurrentRun();
  const artifactPath = resolveArtifactPath(options.path);
  const result = await withCdp(run, (session) =>
    session.send('Page.captureScreenshot', { format: 'png' }),
  );
  await fs.mkdir(path.dirname(artifactPath), { recursive: true });
  await fs.writeFile(artifactPath, Buffer.from(result.data, 'base64'));
  printJson({ status: 'ok', path: artifactPath });
}

async function locate(session, options) {
  if (!options.name && !options.role) fail('click/fill require --name and usually --role');
  const nth = options.nth == null || options.nth === true ? null : Number(options.nth);
  if (options.nth != null && options.nth !== true && !Number.isInteger(nth)) {
    fail('click --nth must be an integer index (0-based)');
  }
  const found = await session.evaluate(
    findControlExpression({
      role: options.role || '',
      name: String(options.name || ''),
      exact: Boolean(options.exact),
      nth,
    }),
  );
  if (found.status === 'missing') {
    fail(`No control matched role=${options.role ?? ''} name=${options.name}`, found.names);
  }
  if (found.status === 'ambiguous') {
    fail(
      `Ambiguous control role=${options.role ?? ''} name=${options.name}. Pass --nth 0 to pick the first match.`,
      found.names,
    );
  }
  return found;
}

async function dispatchMouseClick(session, x, y, clickCount) {
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  for (let count = 1; count <= clickCount; count += 1) {
    await session.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: count,
    });
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: count,
    });
  }
}

async function runClick(options) {
  const run = await requireCurrentRun();
  await withCdp(run, async (session) => {
    const found = await locate(session, options);
    const clickCount = options.double ? 2 : 1;
    await session.evaluate(`(() => {
      const el = document.querySelector('[data-verify-hit="1"]');
      if (el) el.removeAttribute('data-verify-hit');
      return true;
    })()`);
    await dispatchMouseClick(session, found.x, found.y, clickCount);
    printJson({ status: 'ok', name: found.name, disabled: found.disabled });
  });
}

/**
 * Feeds a file to the page's <input type="file"> without touching the OS dialog. Interception has
 * to be armed, the control clicked, and the chooser answered inside one CDP session, so this is a
 * single command rather than a click the caller follows up on.
 */
async function runUpload(options) {
  const run = await requireCurrentRun();
  if (!options.file) fail('upload requires --file');
  const filePath = path.resolve(repoRoot, String(options.file));
  if (!(await pathExists(filePath))) fail(`Missing file ${filePath}`);
  await withCdp(run, async (session) => {
    await session.send('DOM.enable');
    await session.send('Page.setInterceptFileChooserDialog', { enabled: true });
    // Arm the waiter before the click; the event can land before the click call resolves.
    const chooser = session.waitForEvent('Page.fileChooserOpened', 15_000);
    const found = await locate(session, options);
    await dispatchMouseClick(session, found.x, found.y, 1);
    const event = await chooser;
    await session.send('DOM.setFileInputFiles', {
      files: [filePath],
      backendNodeId: event.backendNodeId,
    });
    await session.send('Page.setInterceptFileChooserDialog', { enabled: false });
    printJson({ status: 'ok', name: found.name, file: filePath });
  });
}

async function runFill(options) {
  const run = await requireCurrentRun();
  if (options.value == null) fail('fill requires --value');
  await withCdp(run, async (session) => {
    if (!options.focused) await locate(session, options);
    const value = await session.evaluate(`(() => {
      const el = ${options.focused ? 'document.activeElement' : 'document.querySelector("[data-verify-hit=\\"1\\"]")'};
      if (!el) throw new Error('Lost fill target');
      if (!${options.focused ? 'true' : 'false'}) el.removeAttribute('data-verify-hit');
      el.focus();
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (!setter) throw new Error('No value setter on ' + el.tagName);
      try {
        setter.call(el, ${JSON.stringify(String(options.value))});
      } catch {
        throw new Error('No value setter on ' + el.tagName);
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return el.value;
    })()`);
    printJson({ status: 'ok', value });
  });
}

async function runType(options) {
  const run = await requireCurrentRun();
  const text = String(options.text ?? '');
  if (!text) fail('type requires --text');
  await withCdp(run, async (session) => {
    await session.send('Input.insertText', { text });
    printJson({ status: 'ok', text });
  });
}

// CDP modifier bits for `press --key Control+c` style chords.
const keyModifierBits = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

async function runPress(options) {
  const run = await requireCurrentRun();
  const chord = String(options.key || '');
  if (!chord) fail('press requires --key');
  const parts = chord.split('+');
  const key = parts.pop();
  let modifiers = 0;
  for (const part of parts) {
    if (!(part in keyModifierBits)) fail(`Unknown key modifier: ${part}`);
    modifiers |= keyModifierBits[part];
  }
  await withCdp(run, async (session) => {
    await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key, modifiers });
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key, modifiers });
    printJson({ status: 'ok', key: chord });
  });
}

async function runWait(options) {
  const run = await requireCurrentRun();
  const expected = String(options.text || '');
  if (!expected) fail('wait requires --text');
  const timeoutMs = Number(options.timeout ?? 10_000);
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    last = await withCdp(run, (session) =>
      session.evaluate('document.body ? document.body.innerText : ""'),
    );
    if (String(last).includes(expected)) {
      printJson({ status: 'ok', text: expected });
      return;
    }
    await sleep(250);
  }
  fail(`Timed out waiting for text: ${expected}`, last.slice(0, 2000));
}

async function runText() {
  const run = await requireCurrentRun();
  const text = await withCdp(run, (session) =>
    session.evaluate('document.body ? document.body.innerText : ""'),
  );
  console.log(text);
}

const command = process.argv[2];
const flags = parseFlags(process.argv.slice(3));

if (!command || !(command in commands)) {
  fail(
    `Usage: node ${path.relative(repoRoot, fileURLToPath(import.meta.url))} <${Object.keys(commands).join('|')}>`,
  );
}

await commands[command](flags);
