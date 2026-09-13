# Drag and drop to open CSV sources

Status: Approved and implemented.

## Confirmed decisions

- Support dropping files anywhere in the app, including when a CSV is already open.
- Show a drop hint on the empty screen.
- Highlight the drop area while files are dragged over the window.
- Keep the Open CSV button.
- Support both the desktop and web apps with the same visible interaction.
- Open multiple dropped files in sequence, each in its own CSV Tab, subject to the existing source identity rules.
- Accept only `.csv`, `.tsv`, and `.txt` files, ignoring extension case. Reject folders and other file types.
- For a mixed drop, open supported files and show a short message listing rejected items.
- Follow the existing source identity rules. Desktop focuses an already-open source's CSV Tab. Web creates a new source for each selection rather than inferring identity from names or sizes.
- Preserve existing tabs and their Unexported Changes when opening dropped files.
- Continue opening remaining files if one file fails. Keep successful tabs and show one summary of rejected or failed files after processing the drop.
- Keep the existing web size limits.
- Focus the last successfully opened file. Focusing an already-open source counts as a successful open for this rule.
- Decline additional drops while an open operation is running. Show: "Files are still opening. Try again when finished."
- Block file drops while a modal dialog is open. Preserve the dialog and its input, and prevent the browser from navigating to the dropped file.

## Existing behavior

- File pickers advertise CSV, TSV, and text files. The desktop picker also permits all files.
- Opening a CSV Source creates and focuses a CSV Tab. Existing tabs and their Unexported Changes remain intact.
- Desktop identifies an already-open local file and focuses its existing CSV Tab. Web selections currently receive new identities and create separate tabs.
- Both pickers currently select one file per action.
- Web opening has limits of 100 MB per source and 200 MB total reserved source bytes.

These facts describe the current implementation, not additional approved requirements. Domain terms are defined in [CONTEXT.md](../CONTEXT.md).

## Documentation decisions

The feature uses the existing CSV Source, CSV Tab, and Unexported Changes terms. No additional domain term is needed.

No decision in this interview requires an ADR. The interaction choices are reversible and follow the existing file-opening model.

## Verification

- Browser E2E tests cover mixed drops, extension case, TSV parsing, folder rejection, capacity failures, edit preservation, web duplicate selections, modal blocking, and drops during loading.
- Renderer tests cover sequential processing, continued processing after failures, existing-tab identity, and disposal during a batch.
- Desktop verification uses file-backed Chromium drag input through the preload bridge. It covers multiple files, unsupported files, duplicate identity, preserved edits, and modal blocking.
- Verification commands are in [the open-file recipe](../.agents/skills/verify-csv-viewer/features/open-csv.md).
