# 05 — Move platform failure classification into the hosts

**What to build:** Desktop and web hosts supply Effects for CSV Source selection and description, Recent CSV Sources, discard confirmation, and Export CSV delivery. Each platform classifies its own expected failures once, so users retain dropped-source, missing-source, capacity, and unreadable-source behavior without workspace Promise adapters deciding what an error means.

**Blocked by:** None — can start immediately. The resource-lifetime changes are implemented; remaining web UI verification is carried into ticket 06.

**Status:** ready-for-agent

- [ ] Change the working host methods to Effect-returning methods with expected `CsvSourceUnavailableError` or `WorkspaceRequestError` failures. Update both hosts, all workspace call sites, fixture hosts, and relevant test overrides together so this ticket lands independently.
- [ ] Desktop classifies filesystem failures from source inspection, reads, and writes explicitly at the platform operation. Web maps a failed `File` read to the existing unreadable-source error. Unexpected platform errors become defects; do not classify by message text or a generic list of known error classes.
- [ ] Prompts remain inside host implementations and are adapted there once. Keep picker cancellation, discard confirmation, export cancellation, Recent CSV Source behavior, and source capacity reservation/release unchanged.
- [ ] Convert the shared engine-source scope helper to accept Effects for acquisition and release. Hosts adapt any platform or driver Promises at their own edges; the shared helper only manages the existing scope and cleanup diagnostics. Preserve successful open/reopen when a later engine-source release fails.
- [ ] Update the desktop dropped-source entry to run the host Effect while preserving its existing sanitized IPC response translation. Do not alter the public request protocol or unrelated IPC wiring.
- [ ] Complete the host portion of the throw-site classification audit. If this ticket runs before ticket 01, record those classifications in its own comments for the later audit to incorporate.
- [ ] This ticket works against whichever database form is currently present. It does not require ticket 02: any adaptation of the current driver operations stays inside runtime adapters and can be replaced by direct database Effects when available.
- [ ] Existing desktop host, web host, capacity, engine-source cleanup, and IPC tests retain their message and classification assertions while adopting the Effect API. Shared source/open/export/lifecycle and diagnostics contracts pass on both drivers; type and lint checks pass.
- [ ] Confirm expected source failures retain their public messages and unexpected failures remain sanitized, with unchanged diagnostic stages, outcomes, and privacy rules.
