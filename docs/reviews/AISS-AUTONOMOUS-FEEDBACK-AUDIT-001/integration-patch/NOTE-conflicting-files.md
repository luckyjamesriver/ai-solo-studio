# NOTE — why the three conflicting files are discarded

The original workspace (`ai-solo-studio-rebuild`, HEAD `8dfcfc1…`) had **8**
uncommitted in-flight files. Five are modified vs its HEAD, three are untracked.
Only **two** of the five modified files are reusable against the audited baseline
`e69ca85…`; the other three are deliberately **not** part of the integration
patch and are not carried into the product tree of this delivery branch.

## What is discarded and what the empirical evidence says

Pre-image blob IDs below are git blob SHA-1 (`git rev-parse <rev>:<path>`); the
"against e69ca85" column is the result of `git apply --check` of the captured
diff applied to a clean `git archive e69ca85` scratch tree
(`~/a0-scratch/discardtest`, no `.git`, no `node_modules`).

| File | pre-image blob in original workspace (`8dfcfc1`) | pre-image blob at baseline (`e69ca85`) | `git apply --check` against `e69ca85` | Decision |
| :--- | :--- | :--- | :--- | :--- |
| `e2e/shell.e2e.ts` | `6b31d04aca4119a432d096a1d068f88680c4b216` | `19a40edd12f733a803e5e0bf0789522e951c0d0e` | **FAIL (exit 1)**: `error: patch failed: e2e/shell.e2e.ts:4` / `patch does not apply` | discarded |
| `src/renderer/App.tsx` | `df632641547031666b8fe68428b5385adf87bebe` | `1b920c05280635fa851640b5e183b4750b6cd4e3` | **exit 0** (textually applies) | discarded on semantic grounds — see below |
| `src/renderer/SettingsPage.tsx` | `a5ade870bd27fb222479787221d985bb252daaa3` | `a5ade870bd27fb222479787221d985bb252daaa3` (unchanged upstream) | **exit 0** | discarded as non-reusable prototype — see below |

## Reasons

### 1. `e2e/shell.e2e.ts` — hard textual conflict
The in-flight change only adds an unused `import net from 'node:net';`
(+1 line). Upstream baseline `e69ca85` rewrote the same import block (P0-2
companion-window / feedback-review e2e coverage). The patch cannot apply; there
is no feedback-loop behaviour in it to preserve. The audit report itself
(§2.1 item 6) recommends discarding it and syncing to upstream.

### 2. `src/renderer/App.tsx` — applies textually, conflicts semantically
The in-flight change edits the **old** `onImportPlanToTask` path and old sidebar
state. Baseline `e69ca85` merged PR #3, which introduced the explicit
`targetPid` target-project gate on the same call path. The patch hunks do not
overlap the exact context lines, so `git apply --check` succeeds, but applying it
would re-introduce the pre-P0-2 import path and bypass/undo the target-project
gate. That is a semantic conflict, not a textual one — hence it is discarded even
though `apply --check` returns 0. The audit report (§1.2, §5.1) classifies it as a
conflict with the merged P0-2 gate and recommends discarding.

### 3. `src/renderer/SettingsPage.tsx` — no textual conflict at all
Upstream did not change this file between `8dfcfc1` and `e69ca85` (identical
pre-image blob `a5ade87…`), so the captured diff applies cleanly. It is still
discarded because it is a **non-reusable prototype**: +607/−83 lines adding a
`squadExecutors` multi-seat builder UI backed by `localStorage` — a separate
prototype that is not part of the autonomous feedback loop under audit. The audit
report (§2.1 item 5, §5.1) recommends discarding/deferring UI changes and
re-planning them separately.

> **Discrepancy registered:** the audit report describes `SettingsPage.tsx` as a
> "conflict". Empirically it is *not* a textual conflict (identical pre-image);
> it is a design-scope exclusion. This is recorded as an OPEN item in
> `../open-items.md` rather than silently "fixed".

## Consequence for this delivery branch

* This branch does **not** touch `src/`, `tests/`, or `e2e/`. Its product tree is
  byte-identical to `origin/rebuild` `e69ca85…`; only `docs/` is added.
* The three discarded files remain fully recoverable from
  `../prototype-8-files/diffs/` (`01-…`, `04-…`, `05-…`) together with their
  pre-image blob IDs above, so a reviewer can reproduce the discard decision.
* If a future task wants the `App.tsx`/`SettingsPage.tsx` prototype, it must be
  re-based onto the P0-2 `targetPid` design first; do not machine-apply these
  diffs.
