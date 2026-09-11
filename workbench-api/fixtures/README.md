# Frozen compatibility fixtures

These JavaScript files are test inputs, not runtime assets. They contain no task
data, production database, credentials or stored browser sessions. Do not serve
this directory from the production website.

| Fixture | Origin and purpose |
| --- | --- |
| `shared-store.prod3.js` | Exact source bytes from the published `20260911-prod3` shared store, originally archived at `outputs/group-workbench-paste-only-20260911/release/package/production/shared-store.20260911-prod3.js`. `verify-deletions.cjs` executes this real old client against a fresh local SQLite API to ensure deletion snapshots remove stale cached task IDs and allow reimport without breaking already-open pages. Do not replace it with the current shared store. |
| `workflow-demo-baseline.js` | Snapshot of the local `group-workbench-beta/workflow.js` on 2026-09-11. Preserves the existing projection-equality regression in `verify-deletions.cjs` without requiring the Demo project in the formal-mode checkout. This is a development baseline, not a claim that the same bytes were published to the Demo. |
| `data-io-demo-baseline.js` | Snapshot of the local `group-workbench-beta/data-io.js` on 2026-09-11. `scripts/verify-workbench-tid-input.cjs` keeps its equality assertion and runs all parser cases against both formal code and this baseline. |

The Demo-baseline equality assertions intentionally preserve the existing tests.
When product requirements justify a formal-only change, explicitly review and
replace the affected assertion with the intended compatibility behavior. Do not
overwrite these historical fixtures, weaken tests just to pass, or deploy changes
to a Demo merely to keep a test green.

Run from the repository root (Node 22.23.2 or the verified Node 24.18.0 runtime):

```text
node workbench-api/verify-deletions.cjs
node scripts/verify-workbench-tid-input.cjs
```

Deletion tests use a newly created temporary database and loopback-only HTTP.
Parser tests are pure local checks. Neither requires another repository, the
workspace `outputs/` directory, npm packages, a running website or production data.

SHA-256 at fixture capture (byte-for-byte copy):

| Fixture | SHA-256 |
| --- | --- |
| `shared-store.prod3.js` | `24643e245e75fdd2e2090c3f97ecb3c29578e13a8a58f594aa987cf5e00101e1` |
| `workflow-demo-baseline.js` | `0b85cf826c45ef7d0c92a4496c9fac5271795548d4b6b3ad257600ef118e98a5` |
| `data-io-demo-baseline.js` | `cb1db444edf83733c356c0187460ee208ba579ca7500852f87376a8bea640338` |
