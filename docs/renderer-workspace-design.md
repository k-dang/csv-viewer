# Renderer workspace lifecycle

Both desktop and web use the persistent [renderer workspace module](../packages/ui/src/renderer-workspace.ts). It owns Tab lifecycle independently of React, so commands and events use current state without waiting for a render to commit.

## Ownership

- The renderer workspace owns the Tab collection, Active Tab, opening status, open/close errors, and viewer events. It coordinates open, reopen, confirmation, dependent Comparison removal, and renderer Tab disposal.
- App displays the module's snapshot and supplies form validation and Tab-close confirmation. Theme, dialect inputs, dialog display, and keyboard bindings remain in App.
- Each CSV Tab owns its query, editing, Export CSV, and Stats Panel state. Reopen preserves the CSV Tab object and resets its query, selection, and Stats Panel.
- The shared workspace owns data safety, close-impact validation, and Reopen discard confirmation through its runtime host. Disposing the renderer module does not dispose the runtime's data workspace.

## Ordering decisions

- Toolbar and menu commands admit one Open or Reopen at a time. Repeated commands are ignored rather than queued, matching the disabled toolbar controls. Tab switching and closing remain available.
- Reopen targets the CSV Tab selected when invoked. Successful Open and Reopen focus their returned CSV Tab, including after the user switches Tabs while waiting.
- Successful close wins over an earlier Open or Reopen response. A delayed result cannot restore a closed Tab; a later explicit Open remains valid. The same lifetime rule protects Comparison open responses.
- Closing an inactive Tab preserves the Active Tab. Closing the Active Tab selects its next neighbor, then its previous neighbor.
- A close prompt confirms the current impact. If the shared workspace returns a changed impact, the renderer asks again. Cancellation or cleanup failure retains the CSV Tab.
- Disposal and fatal engine failure unsubscribe viewer events, dispose owned CSV Tabs, and invalidate pending results. React creates the module in an effect so Strict Mode replay disposes the discarded instance.

## Verification

[Module tests](../packages/ui/src/renderer-workspace.test.ts) exercise complete lifecycle sequences through the same interface as App, using controlled viewer responses and confirmation outcomes. They replace the reducer tests. App tests retain intent wiring, Strict Mode subscription ownership, unload warnings, and error presentation.

[Browser tests](../e2e/tab-lifecycle.spec.ts) exercise the real web runtime for delayed Reopen delivery and multi-Tab Comparison closure. The delayed-result test reproduced a closed Tab returning before the fix. A rendered App test reproduced repeated Open intents making two calls while the first was pending. The native accelerator overlap was not established through the desktop helper.

Both native DuckDB and DuckDB-Wasm continue to run the shared workspace contract tests. Electron UI verification covers opening a Recent CSV Source, searching, Reopen reset, and close.
