# Workspace layout

CSV Viewer is a pnpm workspace with runtime applications under `apps/` and shared product modules under `packages/`. The root package owns commands that operate across the workspace.

This top-level split and the use of narrow package subpath exports follow the useful parts of [T3 Code's workspace layout](https://github.com/pingdotgg/t3code/blob/main/docs/internals/workspace-layout.md). CSV Viewer keeps the idea small: two applications and two shared packages.

## Applications

- `apps/desktop` is the Electron application. It owns main, preload, IPC, native filesystem interaction, native DuckDB, CSP, window lifecycle, and Electron Builder configuration. Its build outputs are `apps/desktop/dist-electron/` and `apps/desktop/dist-renderer/`.
- `apps/web` is the browser application. It owns browser `File` selection, browser CSV Source identity, DuckDB-Wasm startup and assets, and browser startup checks. Its static build output is `apps/web/dist-web/`.

Each application is a composition root over the same UI and workspace behavior. Runtime adapters remain inside the application that uses them.

## Shared packages

- `packages/ui` is the single React product used by desktop and web. It depends on the `CsvViewer` interface and the shared comparison presentation helper. It does not import Electron, browser adapters, Node filesystem modules, or workspace implementation modules.
- `packages/workspace` owns the runtime-neutral CSV module. `CsvWorkspace`, query and editing behavior, comparison orchestration, database interfaces, and workspace-host interfaces live here. Its source does not import either application or a concrete DuckDB driver.

`packages/workspace` compiles to CommonJS for Electron main. Vite consumes its TypeScript source for desktop renderer and web builds. This preserves Electron's existing module format while keeping one workspace implementation.

## Package interfaces

Shared packages have explicit subpath exports and no barrel root. Callers import the narrow module they need, such as:

```ts
import type { CsvViewer } from '@csv-viewer/workspace/csv-viewer';
import { createCsvViewer } from '@csv-viewer/workspace/csv-workspace';
import { App } from '@csv-viewer/ui/App';
```

Files without package exports are implementation details. Tests inside `packages/workspace` may use the cross-runtime fixtures under `packages/workspace/test-helpers/`, but shipped workspace source stays runtime-neutral.

## Root commands

- `pnpm run dev:desktop` starts the Electron development application.
- `pnpm run dev:web` starts the browser application.
- `pnpm run build:desktop` and `pnpm run build:web` build one application.
- `pnpm run build` runs typecheck and lint, then builds both applications.
- `pnpm run test`, `pnpm run typecheck`, and `pnpm run lint` cover the workspace.
- `pnpm run package` builds the workspace and packages `apps/desktop`.

Tailwind source discovery lives in `packages/ui/src/styles.css`. It explicitly scans the shared UI plus both composition roots. Keep those paths current when application or package directories move.
