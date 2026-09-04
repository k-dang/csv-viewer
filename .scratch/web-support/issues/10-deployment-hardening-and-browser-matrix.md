# 10 - Static deployment hardening + browser matrix

**What to build:** The release gate: a verified static artifact with enforced security posture, and the shared web behavior proven across the supported browser engines.

**Blocked by:** 08 - Web Export CSV + lifecycle, 09 - Capacity envelope, 11 - Browser test runner.

**Status:** ready-for-agent

- [ ] The web build produces a static artifact with no application backend; a deterministic build test verifies every pinned Worker, Wasm, and approved extension asset is included locally and no runtime engine asset references a CDN.
- [ ] The required Content Security Policy contract is asserted in tests or build checks, including the `wasm-unsafe-eval` allowance the engine needs and nothing broader.
- [ ] Host configuration requirements are captured and verified where possible: HTTPS, correct Worker/Wasm MIME types, and cache rules that prevent mixing incompatible application and engine assets.
- [ ] Security assertions cover remote-source rejection and disabled dynamic extension fetching in the built artifact.
- [ ] A smoke pass against current stable Chrome, Edge, Firefox, and Safari is documented as the release checklist. The automated Chromium/Firefox/WebKit run is ticket 11; this ticket only gates on it passing.
- [ ] No analytics, telemetry, or crash reporting is emitted by the built artifact, verified by test or network assertion.
