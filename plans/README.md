# Motion audit plans

Baseline: `859c4c5`. Source code was read only during this audit. Before evidence: 136 gallery screenshots plus explicit focus probes; native motion evidence is limited to code and the previous restore smoke.

| Order | Plan | Severity | Status | Dependency |
| --- | --- | --- | --- | --- |
| 1 | [Preserve transfer controls](001-preserve-transfer-controls.md) | HIGH | DONE | Coordinate shared transfer UI changes |
| 2 | [Debounce native collapse](002-debounce-native-collapse.md) | MEDIUM | DONE | Independent of renderer |
| 3 | [Optional occasional dialog entry](003-optional-dialog-entry.md) | LOW | DONE | After focus/lifecycle fixes; preserve keyboard immediacy |

- [Recon and motion surface](motion-recon.md)
- [All before page scores](motion-review-before.md)
- [Machine-readable scores/evidence](motion-before.json)

The nearby-discovery focus failure belongs to the shared UI implementation and is recorded in the scores; avoid a second competing fix. Do not add decorative movement to messages, transfer progress, frequent tabs, filter switches, native title drag or resize.

Final read-only verdict: **Approve**. [After scene scores and evidence](../docs/ui-review/2026-10-13-motion-after.md). Native debounce smoke passed; native WebKit/Android motion feel was not rated from screenshots.
