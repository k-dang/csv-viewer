// Dev helper: drive the running Electron renderer over CDP (launch with --remote-debugging-port=9222).
// Usage: node scripts/cdp.mjs '<expression>'   |   node scripts/cdp.mjs --shot out.png
const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find((t) => t.type === 'page' && t.url.startsWith('http'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();

ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);
  if (pending.has(msg.id)) pending.get(msg.id)(msg);
});
await new Promise((r) => ws.addEventListener('open', r));

const send = (method, params = {}) =>
  new Promise((resolve) => {
    const n = ++id;
    pending.set(n, resolve);
    ws.send(JSON.stringify({ id: n, method, params }));
  });

const [flag, arg] = process.argv.slice(2);

if (flag === '--shot') {
  const { result } = await send('Page.captureScreenshot', { format: 'png' });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(arg, Buffer.from(result.data, 'base64'));
  console.log(arg);
} else {
  const { result } = await send('Runtime.evaluate', {
    expression: flag,
    awaitPromise: true,
    returnByValue: true,
  });
  console.log(JSON.stringify(result.result?.value ?? result, null, 2));
}
ws.close();
