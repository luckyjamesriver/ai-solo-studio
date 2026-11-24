# Fingerprints — protected original workspace, unchanged

Two protected trees were involved in A0. This delivery **read** from both and
**wrote to neither**:

| Protected path | Branch | HEAD | Role in this delivery |
| :--- | :--- | :--- | :--- |
| `~/ai-solo-studio-rebuild` | `rebuild` | `8dfcfc19daf9ba890142be0075f9e869b6353731` | Original workspace containing the 8 uncommitted prototype files. Source of all 5 diffs, all 8 SHA-256 values and the 3 untracked file copies. |
| `~/ai-solo-studio-audit` | `audit/AISS-AUTONOMOUS-FEEDBACK-AUDIT-001` | `a8561a9ba47b898bd41c670593ff46bda0995e16` | Original A0 audit worktree. Source of the audit report, the probe file and the 2 applied prototype files. |

(Not touched at all: `~/ai-solo-studio-a1`, `~/ai-solo-studio-rebuild`'s branch
`rebuild`, and the GitHub branch `rebuild`.)

---

## 1. The 8 original-workspace files — SHA-256 vs the pre-work baseline

Reference file: `~/a1-evidence/BASELINE-ORIGINAL-WORKSPACE.txt`
(captured `2026-11-24T02:51:35Z`, before this delivery started). The values below
were re-hashed independently during this delivery.

| # | File | SHA-256 (re-captured by this delivery, 2026-11-24T03:01:25Z) | SHA-256 in BASELINE-ORIGINAL-WORKSPACE.txt | Match |
| :-: | :--- | :--- | :--- | :-: |
| 1 | `e2e/shell.e2e.ts` | `1059d524c53412f1b3ad5f7bde13c4b70e31ee7b026d684bb10426d3ad5aa93a` | `1059d524c53412f1b3ad5f7bde13c4b70e31ee7b026d684bb10426d3ad5aa93a` | YES |
| 2 | `src/core/app/task-controller.ts` | `40873cc12089ef94db563824b60135a56425c91ea6a4b42bc7e43ff990118881` | `40873cc12089ef94db563824b60135a56425c91ea6a4b42bc7e43ff990118881` | YES |
| 3 | `src/core/thinking/index.ts` | `cd4b5dd264b069bf558571916367e068f036496dc86da3c35466be5e43e9ecb5` | `cd4b5dd264b069bf558571916367e068f036496dc86da3c35466be5e43e9ecb5` | YES |
| 4 | `src/renderer/App.tsx` | `0127d93ce23138b099b3d66771d85666c257548e9186155799649385f33b9c30` | `0127d93ce23138b099b3d66771d85666c257548e9186155799649385f33b9c30` | YES |
| 5 | `src/renderer/SettingsPage.tsx` | `c0ee540629549ef39fc87f6b07778aa4350955746f86e13b13d5e55821a70765` | `c0ee540629549ef39fc87f6b07778aa4350955746f86e13b13d5e55821a70765` | YES |
| 6 | `src/core/app/autonomous-feedback-loop.ts` | `d5067b3fe176984f0115751f9fa5690d02b4dc121119bfb82981b83439424428` | `d5067b3fe176984f0115751f9fa5690d02b4dc121119bfb82981b83439424428` | YES |
| 7 | `src/core/thinking/chatgpt-devkit.ts` | `49f3cfce392320c4b399e05bddec19695f7d4bc78fa17acdc6f2471efdf49f35` | `49f3cfce392320c4b399e05bddec19695f7d4bc78fa17acdc6f2471efdf49f35` | YES |
| 8 | `tests/autonomous-feedback-loop.test.ts` | `caad1b563d77eac30fa4af96165bfc767c837fc2954d622b0cef0f75dc94eae3` | `caad1b563d77eac30fa4af96165bfc767c837fc2954d622b0cef0f75dc94eae3` | YES |

**Result: 8/8 match exactly.** No file in the protected original workspace was
modified, added, deleted or moved by this delivery.

---

## 2. `git rev-parse HEAD` — before and after

| When | UTC | `git rev-parse HEAD` | Branch |
| :--- | :--- | :--- | :--- |
| Pre-work baseline (`BASELINE-ORIGINAL-WORKSPACE.txt`) | `2026-11-24T02:51:35Z` | `8dfcfc19daf9ba890142be0075f9e869b6353731` | `rebuild` |
| This delivery, before any run | `2026-11-24T02:56:43Z` | `8dfcfc19daf9ba890142be0075f9e869b6353731` | `rebuild` |
| This delivery, after all runs (final check below) | `2026-11-24T03:01:21Z` → re-checked at commit time | `8dfcfc19daf9ba890142be0075f9e869b6353731` | `rebuild` |

HEAD did not move.

## 3. `git status --porcelain` — before and after (must be unchanged)

Before (`2026-11-24T02:56:43Z`) **and** after (`2026-11-24T03:01:21Z`), byte-identical:

```text
 M e2e/shell.e2e.ts
 M src/core/app/task-controller.ts
 M src/core/thinking/index.ts
 M src/renderer/App.tsx
 M src/renderer/SettingsPage.tsx
?? src/core/app/autonomous-feedback-loop.ts
?? src/core/thinking/chatgpt-devkit.ts
?? tests/autonomous-feedback-loop.test.ts
```

The only difference from the pre-work baseline file is that the baseline snapshot
was additionally listing the `node_modules` symlink as untracked in the *audit*
worktree context; in the rebuild worktree `node_modules/` is gitignored, so the
porcelain output is exactly the 5 `M` + 3 `??` shown above in both snapshots.

## 4. `git diff | sha256` — before and after (must be unchanged)

| Hash of | Before | After | Reference value in `BASELINE-ORIGINAL-WORKSPACE.txt` |
| :--- | :--- | :--- | :--- |
| `git diff` (working tree vs HEAD) | `8b80fb4c57c32e21f463a6e6b7c012862f97300e1312d00a6ba73c6d1f145672` | `8b80fb4c57c32e21f463a6e6b7c012862f97300e1312d00a6ba73c6d1f145672` | `8b80fb4c57c32e21f463a6e6b7c012862f97300e1312d00a6ba73c6d1f145672` — **match** |
| `git diff --cached` (index vs HEAD) | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` (empty) | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` (empty) | `e3b0c442…b855` — **match** |

The `git diff` hash is a whole-working-tree fingerprint: it did not change, which
is stronger evidence than the per-file hashes alone that nothing in the original
workspace moved.

## 5. The third worktree was never written to

For completeness, the audit worktree's own state was also unchanged by this
delivery (only read access was used):

```text
HEAD  a8561a9ba47b898bd41c670593ff46bda0995e16
git status --porcelain (unchanged before/after):
 M src/core/app/task-controller.ts
 M src/core/thinking/index.ts
?? node_modules
?? src/core/app/autonomous-feedback-loop.ts
?? src/core/thinking/chatgpt-devkit.ts
?? tests/autonomous-feedback-loop.test.ts
```

## 6. Delivery branch identity (the only tree this delivery writes)

| Fact | Value |
| :--- | :--- |
| Delivery worktree | `~/ai-solo-studio-a0-delivery` |
| Branch | `audit/AISS-AUTONOMOUS-FEEDBACK-AUDIT-001-delivery` |
| HEAD before commit | `e69ca8511a17acfc4427954af13ef6d364ffb553` |
| `HEAD^{tree}` before commit | `cf305cd625296a9a098c07cf07ad93f494dd660a` = `origin/rebuild^{tree}` — product tree byte-identical |
| `git status --porcelain` before commit | `?? docs/reviews/` only |
| Protected paths written | none |

The scratch test trees (`~/a0-scratch/proto`, `~/a0-scratch/applytest`,
`~/a0-scratch/discardtest`) are plain copies, **not** git worktrees and **not**
inside any protected path. They exist only to run/replay evidence and are not
published.

## 7. How to re-verify this file

```bash
cd ~/ai-solo-studio-rebuild
git rev-parse HEAD
git status --porcelain
git diff | shasum -a 256
git diff --cached | shasum -a 256
while read -r h p; do echo "$(shasum -a 256 "$p" | cut -d' ' -f1)  $p  (expected $h)"; done \
  < <(grep -E '^[0-9a-f]{64}  ' ~/a1-evidence/BASELINE-ORIGINAL-WORKSPACE.txt | awk '$2 != "-"')
```
