const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');
for (const directory of ['dist-electron', 'dist-renderer', 'dist-web']) {
  fs.rmSync(path.join(rootDir, directory), { recursive: true, force: true });
}
