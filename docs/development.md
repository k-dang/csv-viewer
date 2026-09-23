# Development

The app uses Electron, React, TypeScript, AG Grid Community, native DuckDB, DuckDB-Wasm, Vite, Vitest and pnpm.

## Requirements

- Node.js 24 or newer
- pnpm 10.34.2

## Commands

```powershell
pnpm install
pnpm run dev:desktop
pnpm run dev:web
pnpm run build:desktop
pnpm run build:web
pnpm run typecheck
pnpm run test
pnpm run test:browser
pnpm run build
pnpm run package
```

- `dev:desktop` starts Vite and launches Electron against the local dev server. `dev` is an alias.
- `dev:web` starts the web app at `http://127.0.0.1:5173`.
- `build:desktop` creates the renderer plus standalone `main.cjs` and `preload.cjs` Electron bundles.
- `build:web` creates `apps/web/dist-web/`, including the self-hosted Worker and Wasm module.
- `typecheck` checks both applications and both shared packages.
- `test` runs the Vitest suite covering the workspace seam, editing, Comparison, runtime adapters, and CSV Tab behavior.
- `test:browser` starts the web app and runs Chromium tests for open/edit/export, delayed Reopen delivery after close, and multi-Tab Comparison closure. Install Chromium once with `pnpm exec playwright install chromium`, or add `--with-deps` on Linux. Use `pnpm test:browser --headed` to watch the tests. CI runs the same suite and retains failure screenshots.
- `build` runs typecheck and lint, then builds both applications.
- `package` builds the app and creates platform installers under `release/`.

## Validation

Before shipping changes, run `pnpm run test` and `pnpm run build`. The build includes the full TypeScript typecheck, and CI runs the same test and build gates for every pull request and push to `main`.

Feature validation belongs in deterministic tests at the data-service, workspace, IPC-facing, and CSV Tab boundaries. Release readiness does not depend on a separate manual validation checklist.

See [local diagnostics](local-diagnostics.md) to inspect operation timings and failures.

## Web deployment

The web runtime is deployed at [csv-viewer.vercel.app](https://csv-viewer.vercel.app).
Vercel builds every push to `main` from the repository root.

[vercel.json](../vercel.json) sets the install and web build commands, publishes
`apps/web/dist-web`, and applies the security and cache headers using
[Vercel's project configuration](https://vercel.com/docs/project-configuration/vercel-json).
The install command filters to `@csv-viewer/web...`, so only the web application and
its workspace dependencies are installed. [.vercelignore](../.vercelignore) keeps
desktop-only and development trees out of the upload.

The deployment serves static files only. There are no serverless functions, no
backend, and no analytics: Vercel Web Analytics and Speed Insights stay disabled.
CSV data never leaves the user's device.

For a local build, run `pnpm install --frozen-lockfile` and `pnpm run build:web`.

## Desktop packaging

`apps/desktop/package.json` owns the Electron Builder configuration. `pnpm run package` produces platform-specific release artifacts in `release/`. On Windows this creates an NSIS installer and a portable executable; the GitHub Actions release workflow also builds a macOS DMG and Linux AppImage on their native runners.
