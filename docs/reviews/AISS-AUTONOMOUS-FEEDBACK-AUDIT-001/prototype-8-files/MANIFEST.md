# MANIFEST — the 8 in-flight prototype files

Original workspace: `~/ai-solo-studio-rebuild` (protected; branch `rebuild`, HEAD
`8dfcfc19daf9ba890142be0075f9e869b6353731`). Nothing here was rebuilt from
memory: every value below was read out of the protected workspace and the full
content/diff is stored next to this manifest.

Terminology:

* **pre-image blob** = git blob SHA-1 of the file at the workspace HEAD, from
  `git rev-parse HEAD:<path>`.
* **post-image blob** = git blob SHA-1 of the in-flight content, from
  `git hash-object <path>`.
* **SHA-256** = `shasum -a 256 <path>` of the in-flight content on disk. This is
  the same hash family as `~/a1-evidence/BASELINE-ORIGINAL-WORKSPACE.txt`.

## Summary table

| # | Path | git status | SHA-256 (in-flight content) | pre-image blob (workspace HEAD `8dfcfc1`) | post-image blob | Stored as | Matches `BASELINE-ORIGINAL-WORKSPACE.txt`? |
| :-: | :--- | :-: | :--- | :--- | :--- | :--- | :-: |
| 1 | `e2e/shell.e2e.ts` | M | `1059d524c53412f1b3ad5f7bde13c4b70e31ee7b026d684bb10426d3ad5aa93a` | `6b31d04aca4119a432d096a1d068f88680c4b216` | `d1297839662d3f09d43c01fa954332001731f315` | `diffs/01-…diff` + `post-images/e2e/shell.e2e.ts` | YES |
| 2 | `src/core/app/task-controller.ts` | M | `40873cc12089ef94db563824b60135a56425c91ea6a4b42bc7e43ff990118881` | `0ca1e1754788364dc6000e8fb42985ee4bd7d2c6` | `57798e681a0f9a1cd2399c5c173bbf0e07f82350` | `diffs/02-…diff` + `post-images/src/core/app/task-controller.ts` | YES |
| 3 | `src/core/thinking/index.ts` | M | `cd4b5dd264b069bf558571916367e068f036496dc86da3c35466be5e43e9ecb5` | `42773dda3dddd26c2de2f6b67c89de7d1ea7f46c` | `45d1b58845a01628a7999989c0e5fe1738c63652` | `diffs/03-…diff` + `post-images/src/core/thinking/index.ts` | YES |
| 4 | `src/renderer/App.tsx` | M | `0127d93ce23138b099b3d66771d85666c257548e9186155799649385f33b9c30` | `df632641547031666b8fe68428b5385adf87bebe` | `b3c1ba7c2218ff82f2fd183efcfcf21d6033d897` | `diffs/04-…diff` + `post-images/src/renderer/App.tsx` | YES |
| 5 | `src/renderer/SettingsPage.tsx` | M | `c0ee540629549ef39fc87f6b07778aa4350955746f86e13b13d5e55821a70765` | `a5ade870bd27fb222479787221d985bb252daaa3` | `a21baaef84b85ddf6fec4eb749f8b85cfed16c54` | `diffs/05-…diff` + `post-images/src/renderer/SettingsPage.tsx` | YES |
| 6 | `src/core/app/autonomous-feedback-loop.ts` | ?? | `d5067b3fe176984f0115751f9fa5690d02b4dc121119bfb82981b83439424428` | *(untracked)* | `c750a4f54d0a323a21605903f2d2e3c53477e25b` | `untracked/src/core/app/autonomous-feedback-loop.ts` (214 lines) | YES |
| 7 | `src/core/thinking/chatgpt-devkit.ts` | ?? | `49f3cfce392320c4b399e05bddec19695f7d4bc78fa17acdc6f2471efdf49f35` | *(untracked)* | `f3efaef49e2e4b57b6617ceb46f20c3583719d88` | `untracked/src/core/thinking/chatgpt-devkit.ts` (207 lines) | YES |
| 8 | `tests/autonomous-feedback-loop.test.ts` | ?? | `caad1b563d77eac30fa4af96165bfc767c837fc2954d622b0cef0f75dc94eae3` | *(untracked)* | `107d3bbc1f8a49fe7471c1097e4c7850b3ab4b50` | `untracked/tests/autonomous-feedback-loop.test.ts` (295 lines) | YES |

All 8 SHA-256 values match `~/a1-evidence/BASELINE-ORIGINAL-WORKSPACE.txt`
byte-for-byte (that file was captured at `2026-11-24T02:51:35Z`; this manifest was
produced from an independent re-hash during this delivery). Because the same
content was re-hashed on disk, the pre/post *git blob* values above are the
SHA-1 blob identity of the same bytes; the SHA-256 values are the identity that a
third party should compare.

## Diffs

| Diff file | Source command | Source worktree | SHA-256 of diff file |
| :--- | :--- | :--- | :--- |
| `diffs/01-e2e-shell.e2e.ts.diff` | `git diff -- e2e/shell.e2e.ts` | protected `~/ai-solo-studio-rebuild` (HEAD `8dfcfc1`) | `6837dd7849134826659cf3068f94009d30a958ca5b7d4717914c15e8506e2179` |
| `diffs/02-src_core_app_task-controller.ts.diff` | `git diff HEAD -- src/core/app/task-controller.ts` | protected `~/ai-solo-studio-audit` (HEAD `a8561a9`, `src/` tree identical to `e69ca85`), verified byte-identical to the `8dfcfc1` diff | `06f993a14d0ddc0d21e9095c7e8844c57a5086db0ed27da52c33fde18340c958` |
| `diffs/03-src_core_thinking_index.ts.diff` | `git diff HEAD -- src/core/thinking/index.ts` | protected `~/ai-solo-studio-audit` (HEAD `a8561a9`), verified byte-identical to the `8dfcfc1` diff | `54e05357f5517bbcc859ef716766aaccf1bc0b0f02a968e9c3f074c11ddd7129` |
| `diffs/04-src_renderer_App.tsx.diff` | `git diff -- src/renderer/App.tsx` | protected `~/ai-solo-studio-rebuild` (HEAD `8dfcfc1`) | `bc350924626c8eaa91d8cbb5473dfe6b51663b6cc589a2f6c0aa43c548dfe8b2` |
| `diffs/05-src_renderer_SettingsPage.tsx.diff` | `git diff -- src/renderer/SettingsPage.tsx` | protected `~/ai-solo-studio-rebuild` (HEAD `8dfcfc1`) | `9b36ad326065e1c20db3e252f47ab50050b43d8fd66063d7be37c6fbb5a5a012` |

Each diff file begins with a `# source:` line; `git apply` ignores leading text
before the `diff --git` header, and all five were captured with the audit/rebuild
worktree as the source of truth. Files 2 and 3 are the reusable pair — the same
two hunks are the content of `../integration-patch/integration.patch`.

## Why only 2 modified files are reusable

See `../integration-patch/NOTE-conflicting-files.md`. Short version:
`e2e/shell.e2e.ts` cannot apply to `e69ca85` (upstream rewrote its import block);
`App.tsx` applies textually but would undo the merged P0-2 `targetPid` gate;
`SettingsPage.tsx` is a non-reusable `squadExecutors` UI prototype (and its
pre-image is actually unchanged upstream — it is a scope exclusion, not a textual
conflict).

## Reproducing this manifest

```bash
cd ~/ai-solo-studio-rebuild          # protected original workspace
git rev-parse HEAD                   # 8dfcfc19daf9ba890142be0075f9e869b6353731
git status --porcelain               # 5 M + 3 ?? (+ the local node_modules symlink/copy, gitignored)
for f in e2e/shell.e2e.ts src/core/app/task-controller.ts src/core/thinking/index.ts \
         src/renderer/App.tsx src/renderer/SettingsPage.tsx; do
  printf '%s  %s\n' "$(git rev-parse HEAD:$f)" "$f"
  printf '%s  %s\n' "$(git hash-object "$f")" "$f"
  printf '%s  %s\n' "$(shasum -a 256 "$f" | cut -d' ' -f1)" "$f"
done
for f in src/core/app/autonomous-feedback-loop.ts src/core/thinking/chatgpt-devkit.ts \
         tests/autonomous-feedback-loop.test.ts; do
  printf '%s  %s\n' "$(shasum -a 256 "$f" | cut -d' ' -f1)" "$f"
done
```
