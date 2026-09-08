# 10 - Static web deployment

**What to build:** A static site that can be hosted over HTTPS, with local engine assets and no CSV uploads.

**Status:** complete

- [x] `pnpm run build:web` produces a static site in `apps/web/dist-web` with no application backend.
- [x] The build includes the pinned DuckDB Worker and Wasm assets locally.
- [x] CSV processing stays on the device; existing engine tests cover remote-source rejection and disabled dynamic extension fetching.
- [x] Static security headers and short HTTPS hosting instructions are included.
