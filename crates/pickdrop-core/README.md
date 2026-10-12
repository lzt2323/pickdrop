# PickDrop shared native core

Version `0.6.0-alpha.1`. Tauri desktop and mobile hosts share this crate; no Node sidecar is required.

`Core::open(data_dir, kind)` creates or restores a device identity, validates persisted groups once, opens a native LAN HTTP listener, browses/announces `_pickdrop._tcp.local.`, and starts bounded foreground synchronization. Hosts should call `set_active` on app lifecycle changes and relay `Core::subscribe()` to their UI.

`Core::dispatch(method, params)` implements bootstrap, group CRUD/selection, text, invitations and approval, member removal/leave, paginated history, device rename, file send/receive, discovery and cache controls. Public DTOs exclude private keys. File methods return verified app-owned paths only after completion. `cancel_transfer {transferId}` cooperatively interrupts native copy, hashing, request/stream waits, removes partial files, and emits a terminal cancelled state. A cancelled send never appends file metadata. `send_file` accepts an optional `transferId` for matching progress to the UI queue; receive progress is identified by the signed message ID. State includes `membershipRevoked` for disabling sends after removal, separate `revision` and `presenceRevision`, and emitted message snapshots contain only the latest 60 messages.

The protocol matches `shared/peer-protocol.js`: canonical JSON, Ed25519 genesis/events/proofs, SHA256 event IDs, causal clocks, membership authorization and revocation projection, approval polling, incremental 128-event pages and native signed file fetches. Only new events are signature-validated during merge. An empty/duplicate merge returns immediately, preserving previously validated events and cached projections. Authorization rollback records changed IDs and cached state, never clones the complete replica for an idle poll. The core traverses the existing event DAG when needed rather than retaining quadratic ancestor sets. Normal linear text/file additions extend the cached message projection. Full projection is recomputed when membership or concurrent history changes require it.

Sync concurrency is bounded to four routes; known live routes have priority, failed routes back off exponentially, network address changes refresh invitations/announcements, and empty synchronization does not rewrite history or emit unchanged message state. Verified online presence has its own in-memory revision. Native file copy/download hashes streamed 256 KiB buffers once, with progress coalesced to 150 ms. Downloads use a connection timeout rather than a total duration limit, check signed size and SHA256, and publish through an atomic rename. Images are not auto-downloaded by the core.

## Tests

```sh
cargo test -p pickdrop-core
```

Tests cover exact existing JavaScript signed fixtures and canonical bytes, invalid-batch rollback, 1,004-event idle verification counters, two real HTTP nodes pairing and syncing both directions, native streamed file verification, history pagination and no-change persisted-file mtime, and non-destructive legacy import.

## Legacy desktop import

Close both apps and choose a new, empty destination directory:

```sh
cargo run -p pickdrop-core --example import_legacy -- /old/desktop/data /new/tauri/data
```

The importer validates every peer group before staging artifacts, retains device identity, rehashes existing file caches, and leaves the source untouched. Old hosted-mode groups are reported as skipped; mobile SecureStore secrets cannot be read from an Android file export, so mobile devices must explicitly export their identity or rejoin.

Remaining preview limits: inactive hosts keep the native listener bound but reject sync/pair/file requests. Discovery and native file-picker behavior still require physical LAN/mobile validation in addition to the automated node tests.
