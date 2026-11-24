# Source identity — which exact tree, commit and files produced each count

This file exists so a third party can reproduce each of the **three** reported
test counts **independently**, and prove that no count was re-labelled or reused.
Every run below was executed on `2026-11-24` (UTC) by the delivery agent, after
`npm ci` from the committed `package-lock.json`.

## Common identity

| Fact | Value |
| :--- | :--- |
| Audited baseline commit | `e69ca8511a17acfc4427954af13ef6d364ffb553` (`origin/rebuild`) |
| Delivery branch HEAD (unchanged before, during and after all runs) | `e69ca8511a17acfc4427954af13ef6d364ffb553` |
| Delivery product tree (== `origin/rebuild^{tree}`) | `cf305cd625296a9a098c07cf07ad93f494dd660a` |
| `src/` tree object | `bcf7f9cda26264147ced06a957c9db5e03c665f8` (141 files) |
| `tests/` tree object | `542468547a062f7d13a1c1580cd90aae471fb8cd` (58 `*.test.ts`) |
| Node.js | `v22.23.5` (`/opt/homebrew/opt/node@22/bin/node`) |
| npm | `10.9.9` |
| vitest | `5.0.5` (darwin-arm64, bundled with node 22.23.5) |
| vitest selection rule | `vitest.config.ts`: `test.include = ['tests/**/*.test.ts']` (SHA-256 `54f750b0876b16bd71d13006f163b3636789965aa2d82e2f7469351f5e9c5c8a`) |
| `package-lock.json` | SHA-256 `cc3d0612c2b30c1ca6d8381215bbd763f8e3a7d6598402caeda7be7656b81438` |
| `package.json` | SHA-256 `28004785802a471c244f10a3a086e96188a0c487fe51cf6d88b69ebd2ad56a49` |

> Three counts, three different execution contexts — do not conflate them:
> **677** and **94** were run in the delivery worktree (baseline product tree, no
> prototype code); **9** was run in a *scratch* copy of the baseline with the
> prototype files dropped in, because the delivery branch intentionally does not
> modify `src/` or `tests/`.

---

## 1. Count A — full suite: `677 passed | 38 skipped (715)`, `46 passed | 12 skipped (58)` files, exit 0

| Fact | Value |
| :--- | :--- |
| Execution context | `~/ai-solo-studio-a0-delivery` — delivery worktree, **no prototype files** |
| `git rev-parse HEAD` | `e69ca8511a17acfc4427954af13ef6d364ffb553` |
| Branch | `audit/AISS-AUTONOMOUS-FEEDBACK-AUDIT-001-delivery` |
| Command | `npm test` (= `vitest run`) |
| Selection | all `tests/**/*.test.ts` = 58 files (see tables below) |
| Result line | `Test Files  46 passed | 12 skipped (58)` / `Tests  677 passed | 38 skipped (715)` |
| Duration | `97.43s` (wall clock; not part of the identity) |
| Log (verbatim, with header + exit code) | [`test-logs/npm-test.log`](test-logs/npm-test.log) |
| Exit code | `0` |
| node / npm / vitest | `v22.23.5` / `10.9.9` / `5.0.5` |

### 1.1 The 46 test files that passed

| # | test file (46 passed) | SHA-256 |
| :-: | :--- | :--- |
| 1 | `tests/acceptance.test.ts` | `075cbd5f2b18b480a2c4130a932e311c8b66981c429c1a44e26a0dbf246c04af` |
| 2 | `tests/adr-0005-scenarios.test.ts` | `6a29ce6eb17a8928578a5f0ee79e48d6c7b61ee6da00ed02f3e65f73cc7d5262` |
| 3 | `tests/b4-2-controller.test.ts` | `b42972c61df79f369d0da5c882c40869ac1960728c51bd56aeb1d55ead57fc69` |
| 4 | `tests/b4-2-fix.test.ts` | `9ea30226ce5fb8ee3d7fa6930dc8b5a94f6987eed146b9c17a27f26a5fc8e24d` |
| 5 | `tests/b4-2-view.test.ts` | `c99030b3a0bad3eca7c0e2579a13b971ec0c6d021598e4ace34c04dc90ad4c05` |
| 6 | `tests/b4-git.test.ts` | `37037b3d296372eee5a126c1790a26491bc044cd7e03c6eda7a6ae021213f387` |
| 7 | `tests/b4-save.test.ts` | `3504b6fbc1aa2654b642be052b57d97117a28677846fdebbfc12f2e7af023881` |
| 8 | `tests/b4-sentinel.test.ts` | `61025d490baee67cce5a5821d8a2140e31ba4a523b8f2ffb7ffe26dc35f7289d` |
| 9 | `tests/capabilities.test.ts` | `66f23393c837a26fde943a1d00aa8a63f891f85aa003538172b119c89dee7233` |
| 10 | `tests/chatgpt-secure-interaction.test.ts` | `0d1c12893e1ae3c0f4bd304229136b2725fc917eb1ce46740affeb2fe44be517` |
| 11 | `tests/cli.test.ts` | `5cc2961b7357afabb918991359fa373b093109111c1a9d025757ed367ea8ec09` |
| 12 | `tests/codex-adapter.test.ts` | `5a684caa23599337ca8a050542d616fe6d92a6aa38adbdf06d11ea789248c5d4` |
| 13 | `tests/construction-ui.test.ts` | `332b7ae003c0ea0cd922108a9f773380373499ef232c9463dfc25b9d016e9c37` |
| 14 | `tests/design-tokens.test.ts` | `53b78f1c9c5ef95e03c961fd4ba943df6d5f1e97ce19716e9267048a37243054` |
| 15 | `tests/env.test.ts` | `e34185750e11bcc3cbe385b8d11574644d2e1008efbf02a584d1e9b6d3f538b8` |
| 16 | `tests/external-services.test.ts` | `69ffd9e2f44713e4a3225ccd68737cfcd61a5d6468698f3f8d7fafb357824b7c` |
| 17 | `tests/flow.test.ts` | `ef97d135e5345deae7ddac5f6f613d5a9e228294c8d16904f146f353b7df1b7e` |
| 18 | `tests/git.test.ts` | `d760566354f5d4bc40322cb2ea6a5041a4de1bf2914ae22a3e405c4e02e79b03` |
| 19 | `tests/handoff.test.ts` | `4a25c71797f4c69ab78087b3c4f7f956f385122f448d0ddf011ec0261d2d78da` |
| 20 | `tests/learning-engine.test.ts` | `166043ec07e1bd8abf41b102a2fd1d090b5750b66cfa39ec4b35d1788816f205` |
| 21 | `tests/multi-project.test.ts` | `bc38d3efe70953c50f3d1368b8f4deafd9df228b80e3cb45959843df81555663` |
| 22 | `tests/persistence.test.ts` | `c9a654a0e99eb7b0bdd5c5b32f10ddd7585577e67662e9216af3aa8f5b94aa97` |
| 23 | `tests/policy.test.ts` | `b79718e8606011cdc34e2eb4c43a2acf2125bda61a7426b4f564cc60d6f775a6` |
| 24 | `tests/preview-url.test.ts` | `56d2ae97574a49fdfd73db26e0fabf60b57133933bfb24ca7eed04853d097bb0` |
| 25 | `tests/proc.test.ts` | `36d3164a0034a3899b25ed7be1bf1729e6b8f23311243263fbfbf56bf1a3a1c5` |
| 26 | `tests/runner.test.ts` | `fb6ee5231d5fe326b27b3746b41b1db45cf131d05ed624ed11271e46c223e5bc` |
| 27 | `tests/save-safety.test.ts` | `78b1b89bbf048f86c8cd113e6cbc8ad7df9e4b858ed23954d61a3f47442abafa` |
| 28 | `tests/security.test.ts` | `7006adc4bc4e682ecbafbff1f7ff42dd676487496014f1fdd03cac43cd8e9810` |
| 29 | `tests/stage3-plan-run.test.ts` | `134bc39bfe046be26e50085a38ea06dd936fc4a110ad56131f6e189bb73a61f4` |
| 30 | `tests/stage4-review.test.ts` | `dc830657f08de123f6231aadde2be37696570ea790a3508d985d8583c5c8f65f` |
| 31 | `tests/stage5-discuss.test.ts` | `7d576320dd3ffbca60bdee2acfe9a81ac2f4167e7cedc83b88fc5411af5ea5d3` |
| 32 | `tests/stage5b-ai-roles.test.ts` | `f44e39dfe0d1c24447dde6369557c97e23fdc20dd0234d3d4ce4a8865fdd1ca9` |
| 33 | `tests/stage5b-claude-key.test.ts` | `ba9ebbbed5e129da03fe0c613ffa283a29e3ac6ad49dbca2ef1f2d1bf53722ec` |
| 34 | `tests/stage6-save-ui.test.ts` | `781d4e54fb0e959876ae57acb478edd1670ad549f66de48cdcab9357cda3d149` |
| 35 | `tests/stage7-handoff.test.ts` | `3fe00d81bb1eef4eb92906e354a4a267da20f39cfcdebcb05991f46f7ad25671` |
| 36 | `tests/stage7-rounds.test.ts` | `1f396613a1c6ed9702c1db73a322b16d0e106338e6919b7679c0f46eb3786ba9` |
| 37 | `tests/stage8a-controller.test.ts` | `0d22b463e794af3ae2939ee10107582c7b55fddf088e8420a6d2fa8b9fe1a91a` |
| 38 | `tests/stage8a-executor.test.ts` | `8f73535ace7008c59db09c19394257c35f61c892f7db6ff4cadd592e0bf86062` |
| 39 | `tests/stage8a-providers.test.ts` | `1c1376fb4694b8f20935d4da974628bbcb56eeba8c515ae2a6dbf46774157b8e` |
| 40 | `tests/stage8b-acp.test.ts` | `eae7e0b95b7f5639b70730d66f7a8154a511418e0eef16db4fedff3a97e90fcc` |
| 41 | `tests/stage8b-claude-code.test.ts` | `2f80a2d1cb63aa6f2bccb8652f30a766b4b1f56c406d40c8a3e0c0fe9c46cdb6` |
| 42 | `tests/stage8b-controller.test.ts` | `756037aae9704b65413b02366825b0e5fff49333ec285acc59c287d59d71c403` |
| 43 | `tests/stage8c-controller.test.ts` | `7b01f48510863d1df84bf290b6676e30778f2e42c24b4980f60b235142a1f21e` |
| 44 | `tests/stage8c-seatbelt.test.ts` | `04bab6c2074bf507030573f3f20267f764ce7c5fd31d338ed8ad96067ce03ec4` |
| 45 | `tests/state.test.ts` | `1c2666fcda64943ef3a0622950396ec51da61340d97720abda452d9b47b47acf` |
| 46 | `tests/thinking.test.ts` | `29cd35a6ffbface081be8f702f77a77b8c834b735c6428efc6085886ca42b6ce` |

### 1.2 The 12 skipped test files (38 skipped tests — all real-service `*.real.test.ts` suites, gated off by design)

| # | test file (12 skipped) | SHA-256 | skipped tests |
| :-: | :--- | :--- | :-: |
| 1 | `tests/integration/b3-1-probes.real.test.ts` | `6b862ce0324d803566910ac19179a953f5dee60c6a0b9a27d9f7be1f0b3b9881` | 11 |
| 2 | `tests/integration/b3-1b-worktree.real.test.ts` | `418487640a92a73e7c587a13ec491fc12df782abb8332c72253563f3ea8d99d6` | 3 |
| 3 | `tests/integration/b3-modes.real.test.ts` | `c4114c095a9e5950b7f57fa2cb920351d5441581773424b4e8086fc6f96029e4` | 10 |
| 4 | `tests/integration/b4-1.real.test.ts` | `77304ae3722e171a50ed3ad419001ca2f8447116daa4cda6f3cd63c8a521db4d` | 1 |
| 5 | `tests/integration/claude-api.real.test.ts` | `260e014e6cd673c1728ccad549fd12318d33213ff323fd160d690b7eed23d74c` | 1 |
| 6 | `tests/integration/codex.real.test.ts` | `2200377b7cb39fbfd8be19f81afc13cef3d4ed00a2f1ffa96c3cc87d848d32a8` | 2 |
| 7 | `tests/integration/extensions.real.test.ts` | `22d54dae41cc4c5b5ccb5992b93bb11f9d50aab9dd5b8ec3746fb947f71b335a` | 2 |
| 8 | `tests/integration/path.real.test.ts` | `0bab6f3eb5a7456ab662a4a579d1733170c8bb8304fb3bf3fa0ee322bf0e8ef0` | 1 |
| 9 | `tests/integration/persist.real.test.ts` | `ee0a75a8e3abadfeb4307c26f2b4202939b3cdd0561f3f47430360b9b77d7020` | 1 |
| 10 | `tests/integration/sentinel.real.test.ts` | `8c03f3b865b008e9d7a1298259abe8f9d1e812a56a9896df5aff548495b8c9e1` | 3 |
| 11 | `tests/integration/think-flow.real.test.ts` | `24553978c8c2b89553fd73339d231b0ae2d246ef39f2f9ac5aac2122c72dee19` | 1 |
| 12 | `tests/integration/thinker.real.test.ts` | `9751a3dd9b110c71fd9754094e811d26ab53d940461e7f0d758bad75375d2ed2` | 2 |

The 12 skipped files are `tests/integration/*.real.test.ts`; they skip unless
`STUDIO_REAL_CODEX=1` / real credentials are supplied, which is the documented
behaviour of `npm test` (the separate script `npm run test:real` is the one that
enables them). No test was skipped by this delivery.

---

## 2. Count B — 94-test selection: `94 passed (94)` in 3 files, exit 0

| Fact | Value |
| :--- | :--- |
| Execution context | `~/ai-solo-studio-a0-delivery` — delivery worktree, **no prototype files** |
| `git rev-parse HEAD` | `e69ca8511a17acfc4427954af13ef6d364ffb553` |
| Command | `npx vitest run tests/b4-2-controller.test.ts tests/runner.test.ts tests/flow.test.ts` |
| Result line | `Test Files  3 passed (3)` / `Tests  94 passed (94)` |
| Duration | `79.10s` |
| Log | [`test-logs/94-test-selection.log`](test-logs/94-test-selection.log) |
| Exit code | `0` |
| node / npm / vitest | `v22.23.5` / `10.9.9` / `5.0.5` |

### 2.1 Selected test files (SHA-256)

| # | Test file | Tests in file | SHA-256 |
| :-: | :--- | :-: | :--- |
| 1 | `tests/b4-2-controller.test.ts` | (part of 94) | `b42972c61df79f369d0da5c882c40869ac1960728c51bd56aeb1d55ead57fc69` |
| 2 | `tests/runner.test.ts` | (part of 94) | `fb6ee5231d5fe326b27b3746b41b1db45cf131d05ed624ed11271e46c223e5bc` |
| 3 | `tests/flow.test.ts` | (part of 94) | `ef97d135e5345deae7ddac5f6f613d5a9e228294c8d16904f146f353b7df1b7e` |

The per-file test counts are visible in the log; the authoritative aggregate is
the `Tests  94 passed (94)` summary line.

### 2.2 Source files these tests import directly (SHA-256, from the same `e69ca85` tree)

| Source file | SHA-256 |
| :--- | :--- |
| `src/core/app/task-controller.ts` | `0fc51871e1c6d928c2214e4f84a942958d9696aa70d03e738ca452af8e98a292` |
| `src/core/task/runner.ts` | `4014f3fcc453cf986491bf0d388845db8574bd1f73f71165e9d8d61605de8e93` |
| `src/core/acceptance/view.ts` | `2190fc571ce23b5c3fc573b29dbc2cd8d1d2586611d9c40373e3a237de30216c` |
| `src/core/app/prefs.ts` | `880b707c7a58c58748a2e38b00312f90ac5f0350c7577a442d501caa2aaaa373` |
| `src/core/executor/adapters/fake.ts` | `adabbea5ae04cdefbe95d224146dfa4de4416dc101c1e9e58f3010abd7759084` |
| `src/core/executor/channel.ts` | `3960a8ddaf14021929cffb2e255ed1f7481ed5ff09adaab034bf71d205ce9d78` |
| `src/core/executor/types.ts` | `f20f2b2b81dfe407bbbb76bfe621757736c2ac3bd77f190ba31aa48490fc8627` |
| `src/core/git/git.ts` | `f4e80df56edaa5bf3764b49f6b9cf753da9895ed9385314a8db4fea1d6a5018a` |
| `src/core/task/messages.ts` | `09125695296c9dfa935c7f1ab9b27aad8795fd71b58ccb7b395c860d098745bd` |
| `src/core/thinking/flow/index.ts` | `474cc1f3fad81273d04da764a56aad832792ebdb3e639bd7610fb4d9751771c0` |
| `src/core/thinking/index.ts` | `3f08e1ef823275876fc1b84a574b00c915a81f27b96b4affcabe86e178144b14` |
| `tests/helpers.ts` | `a3b70e0537d449b4ac2ecf3c70850065a0e2720c40b6b5df46cbc735d31dd483` |
| `tests/flow-helpers.ts` | `70b8bbff6de477b9297a81e6fc799c6ac099a49d32cc10b62d4dee943edb791b` |

The remaining transitive sources are pinned by the `src/` tree object
`bcf7f9cda26264147ced06a957c9db5e03c665f8` above.

---

## 3. Count C — 9 prototype tests: `9 passed (9)` in 1 file, exit 0

| Fact | Value |
| :--- | :--- |
| Execution context | `~/a0-scratch/proto` — **scratch copy**, not a git worktree, not a protected directory |
| How it was built | `git archive e69ca85… \| tar -x -C ~/a0-scratch/proto`, then `cp -R` of the fresh `npm ci` `node_modules`, then the 5 prototype source files copied in from the protected audit worktree |
| `git HEAD` | none (scratch has no `.git`); the tree is baseline `e69ca8511a17acfc4427954af13ef6d364ffb553` **plus** the prototype files below |
| Command | `npx vitest run tests/autonomous-feedback-loop.test.ts` |
| Result line | `Test Files  1 passed (1)` / `Tests  9 passed (9)` |
| Duration | `845ms` |
| Log (header lists all source hashes + exit code) | [`test-logs/prototype-9-tests.log`](test-logs/prototype-9-tests.log) |
| Exit code | `0` |
| node / npm / vitest | `v22.23.5` / `10.9.9` / `5.0.5` |

### 3.1 Files that differ from baseline in the scratch dir (all copied out of the protected audit worktree)

| File | Baseline (`e69ca85`) | Scratch / prototype | SHA-256 used | Evidence copy |
| :--- | :--- | :--- | :--- | :--- |
| `tests/autonomous-feedback-loop.test.ts` | absent | added | `caad1b563d77eac30fa4af96165bfc767c837fc2954d622b0cef0f75dc94eae3` | `prototype-8-files/untracked/tests/…` |
| `src/core/app/autonomous-feedback-loop.ts` | absent | added | `d5067b3fe176984f0115751f9fa5690d02b4dc121119bfb82981b83439424428` | `prototype-8-files/untracked/src/core/app/…` |
| `src/core/thinking/chatgpt-devkit.ts` | absent | added | `49f3cfce392320c4b399e05bddec19695f7d4bc78fa17acdc6f2471efdf49f35` | `prototype-8-files/untracked/src/core/thinking/…` |
| `src/core/app/task-controller.ts` | `0fc51871…e98a292` | modified (prototype) | `40873cc12089ef94db563824b60135a56425c91ea6a4b42bc7e43ff990118881` | `prototype-8-files/post-images/src/core/app/…` |
| `src/core/thinking/index.ts` | `3f08e1ef…4b14` | modified (prototype) | `cd4b5dd264b069bf558571916367e068f036496dc86da3c35466be5e43e9ecb5` | `prototype-8-files/post-images/src/core/thinking/…` |

The two `post-images/` files are byte-identical to the in-flight files in the
protected original workspace (verified by SHA-256 against
`~/a1-evidence/BASELINE-ORIGINAL-WORKSPACE.txt`).

### 3.2 Unmodified dependencies the 9 tests import (SHA-256, baseline content)

| File | SHA-256 |
| :--- | :--- |
| `src/core/app/loop-guard.ts` | `b34113ba7a20737fcc9afc2b10849266dc63a23c37570a4c47212c463784e9fe` |
| `src/core/app/task-view.ts` | `9b93e7b70d1990d9c9b15ba5ed8dc4a5b8b73830889b99e59bdbd5797ce55eaf` |
| `src/core/thinking/types.ts` | `4f0b0261f80ab320c41385208cb9c59af87748074926ebc9d25250298c5758fc` |
| `src/core/thinking/errors.ts` | `8ccef520bf5056a453079ef24ee924d6a06be73ca1a3bfde404c0f0c428fbe21` |
| `src/core/thinking/prompt.ts` | `9db1eb3976f3e24d962840d11cb7337a89acb2a8c79a9ebeb8b32f1e17bdb15d` |
| `src/core/task/model.ts` | `3221bf5c5874893a463f4949000e8dfcb5afa145408723e98f596c94b03eb801` |
| `vitest.config.ts` | `54f750b0876b16bd71d13006f163b3636789965aa2d82e2f7469351f5e9c5c8a` |

---

## 4. Ancillary — 4 negative probes: `4 passed (4)`, exit 0

Run in the same scratch tree as Count C, against
`tests/probes/audit-negative-probes.test.ts`
(`93be939f661d752e03b91e26777f96e75994e38133543a2cd96cb8603205c018`).
This is **not** one of the three headline counts; it is the A0 negative-probe
evidence required by the report (§4.2). Log: [`probes/run.txt`](probes/run.txt),
exit `0`.

> Note: probe 2 is a *negative* probe — it is supposed to pass by **demonstrating
> the vulnerability** (`passed: true` when no tests ran). A green probe run is
> therefore evidence that the vulnerability is real, not evidence that it is
> fixed. Do not read "4/4 probes passed" as "the feedback loop is safe".

---

## 5. Minimal reproduction of each count

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
git clone -b audit/AISS-AUTONOMOUS-FEEDBACK-AUDIT-001-delivery \
  https://github.com/luckyjamesriver/ai-solo-studio.git a0-delivery
cd a0-delivery && git rev-parse HEAD   # must print e69ca8511a17acfc4427954af13ef6d364ffb553... (see README for delivery HEAD)
npm ci

# A: 677 passed | 38 skipped
npm test

# B: 94 passed
npx vitest run tests/b4-2-controller.test.ts tests/runner.test.ts tests/flow.test.ts

# C: 9 passed  (scratch tree; see environment.md for the full copy recipe)
S=~/a0-scratch/proto
mkdir -p "$S" && git archive e69ca85 | tar -x -C "$S"
cp -R node_modules "$S/node_modules"
# copy 5 files per §3.1 (3 untracked + 2 post-images), then:
cd "$S" && npx vitest run tests/autonomous-feedback-loop.test.ts
```

## 6. What this identity does **not** prove

* It does not prove the prototype is correct, secure or production-ready; it only
  fixes *which bytes* produced *which count*. The audit's OPEN findings live in
  `open-items.md`.
* It does not pin the OS/build/hardware (macOS 27.2.1, arm64, M1 Ultra). Test
  counts are deterministic on any supported platform; wall-clock durations are
  not, and are excluded from the identity on purpose.
* The delivery branch SHA-256 values are for files at `e69ca85`; they will not
  match a future `rebuild` tip. Reproduce against the audited commit only.
