# 11 - Simple browser E2E verification

**What to build:** One Playwright test that verifies the web application's open, edit, and export workflow in Chromium.

**Blocked by:** 08 - Web Export CSV + lifecycle.

**Status:** complete

- [x] Use Playwright directly with one config that starts the web app automatically.
- [x] Run one Chromium test that opens a CSV, edits a cell, downloads an export, and checks its contents.
- [x] Use one command, `pnpm test:browser`, locally and in the existing CI job.
- [x] Keep existing native and headless Wasm tests in Node.
- [x] Document engine installation and local execution in the root README.

The test uses the normal application and real data engine. Playwright handles browser startup, server startup, file selection, downloads, and failure screenshots without custom fixtures or commands.

The previously verified export correction remains: export reads use the existing pending-query API on a separate operation connection that closes after use.

Validation: the E2E test passed, including exact exported CSV contents, in 10.3 seconds including startup.
