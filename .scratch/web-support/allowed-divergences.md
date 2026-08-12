# Allowed engine divergences

Observable behavioral differences between the native DuckDB and DuckDB-Wasm adapters that the shared contract suite is permitted to accept for a release.

**This is a release artifact, not a standing exemption.** A divergence observed by the contract suite and absent from this list blocks release. Every entry is re-checked when either engine is repinned; an entry whose tracking issue is closed, or whose engine pairing has changed, is removed and the divergence must either disappear or be re-argued.

Adding an entry requires review. "The test fails on Wasm" is not a reason; the reason must be a property of the engines that the adapters cannot normalize.

## Entries

None. Same-core pinning is the target; see ticket 00 for whether it is attainable.

<!--
Template - copy per entry:

### <short title>

- **Observed by:** <contract test name and file>
- **Native behavior:** <what native DuckDB does>
- **Wasm behavior:** <what DuckDB-Wasm does>
- **Why adapters cannot normalize it:** <engine property, not an implementation shortcut>
- **User-visible impact:** <what a user would notice, or "none">
- **Tracking issue:** <link>
- **Added:** <date> for release <version>
- **Engine pairing at time of entry:** node-api <x>, duckdb-wasm <y>, core <z>
-->
