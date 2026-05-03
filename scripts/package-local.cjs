const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');
const releaseDir = path.join(rootDir, 'release');
const stagingDir = path.join(releaseDir, 'staging');

const sourcePackageJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const stagedPackageJson = {
  name: sourcePackageJson.name,
  productName: sourcePackageJson.productName,
  version: sourcePackageJson.version,
  description: sourcePackageJson.description,
  main: sourcePackageJson.main,
  license: sourcePackageJson.license,
  dependencies: sourcePackageJson.dependencies,
};

fs.rmSync(stagingDir, { recursive: true, force: true });
fs.mkdirSync(stagingDir, { recursive: true });

copyDirectory(path.join(rootDir, 'dist-electron'), path.join(stagingDir, 'dist-electron'));
copyDirectory(path.join(rootDir, 'dist-renderer'), path.join(stagingDir, 'dist-renderer'));
copyFileIfExists(path.join(rootDir, 'README.md'), path.join(stagingDir, 'README.md'));
fs.writeFileSync(
  path.join(stagingDir, 'package.json'),
  `${JSON.stringify(stagedPackageJson, null, 2)}\n`,
  'utf8',
);

execFileSync('npm', ['install', '--omit=dev', '--package-lock=false'], {
  cwd: stagingDir,
  stdio: 'inherit',
});

execFileSync(
  process.execPath,
  [
    path.join(rootDir, 'node_modules', '@electron', 'packager', 'bin', 'electron-packager.mjs'),
    stagingDir,
    'CSV Viewer',
    '--out',
    releaseDir,
    '--overwrite',
    '--asar=false',
  ],
  {
    cwd: rootDir,
    stdio: 'inherit',
  },
);

fs.rmSync(stagingDir, { recursive: true, force: true });

function copyDirectory(source, destination) {
  fs.cpSync(source, destination, { recursive: true });
}

function copyFileIfExists(source, destination) {
  if (fs.existsSync(source)) {
    fs.copyFileSync(source, destination);
  }
}
