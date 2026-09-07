// Serves the built CSV Viewer Web app and opens it in a plain Chromium window.
//
// This is deliberately NOT the desktop app: there is no preload, so `window.csvViewer` never
// exists and the page must reach DuckDB-Wasm through its own web composition, exactly as a
// browser tab would. Serving happens in this same process so a verification run stays one pid.
//
// ponytail: Electron's bundled Chromium stands in for "a browser". It proves the web build's
// behavior, not cross-browser support. Drive a real Firefox/Safari by hand if that is the claim.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const webRoot = process.env.CSV_VIEWER_WEB_ROOT;
const port = Number(process.env.CSV_VIEWER_WEB_PORT);
const downloadDir = process.env.CSV_VIEWER_DOWNLOAD_DIR;

if (!webRoot || !port || !downloadDir) {
  console.error('CSV_VIEWER_WEB_ROOT, CSV_VIEWER_WEB_PORT and CSV_VIEWER_DOWNLOAD_DIR are required.');
  app.exit(1);
}

// WebAssembly.instantiateStreaming rejects anything but application/wasm, and the DuckDB worker
// is served from this origin too, so these types are load-bearing rather than cosmetic.
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
};

function serve(request, response) {
  const requestUrl = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
  const relativePath = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, '');
  const resolved = path.resolve(webRoot, relativePath || 'index.html');
  // Refuse to serve anything the built app did not emit, however the path was spelled.
  if (resolved !== webRoot && !resolved.startsWith(webRoot + path.sep)) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(resolved, (error, contents) => {
    if (error) {
      response.writeHead(404).end('Not found');
      return;
    }
    response.writeHead(200, {
      'Content-Type': mimeTypes[path.extname(resolved)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    response.end(contents);
  });
}

app.whenReady().then(() => {
  fs.mkdirSync(downloadDir, { recursive: true });
  // Export CSV on web is an <a download> click. Landing it in the run directory without a dialog
  // is what makes the export round trip provable at all.
  session.defaultSession.on('will-download', (_event, item) => {
    item.setSavePath(path.join(downloadDir, item.getFilename()));
  });

  const server = http.createServer(serve);
  server.listen(port, '127.0.0.1', () => {
    const window = new BrowserWindow({
      width: 1440,
      height: 900,
      show: true,
      // Without this an unfocused window throttles rAF, so AG Grid never paints its rows and
      // `text`/`wait` see a grid that the screenshot clearly shows. Verification runs are
      // unfocused by definition.
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    void window.loadURL(`http://127.0.0.1:${port}/index.html`);
  });
});

app.on('window-all-closed', () => app.quit());
