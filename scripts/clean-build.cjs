const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');
for (const directory of [
  'apps/desktop/dist-electron',
  'apps/desktop/dist-renderer',
  'apps/web/dist-web',
  'packages/workspace/dist',
]) {
  fs.rmSync(path.join(rootDir, directory), { recursive: true, force: true });
}
