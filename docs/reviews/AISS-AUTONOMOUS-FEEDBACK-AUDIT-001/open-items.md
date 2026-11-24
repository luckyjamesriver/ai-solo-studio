# OPEN items — A0 items that remain **not** independently verified

This is a deliberately negative register. Anything listed here is **not** claimed
as passed, fixed, or proven. The delivery reproduces the three headline test
counts and the audit report's file fingerprints; it does **not** re-audit the
product, fix the prototype, or promote the prototype to `rebuild`.

Status legend: **OPEN** = not verifiable / not verified here. **RESOLVED BY THIS
BRANCH** = was unverifiable before, now directly verified by a published artifact
(the evidence for the resolution is cited).

---

## OPEN-1 — Original A0 audit branch was unreadable from GitHub

| Field | Value |
| :--- | :--- |
| Status | **RESOLVED BY THIS BRANCH** (only after the remote check below passed) |
| Observed before this delivery (`2026-11-24T03:01Z`) | `gh api repos/luckyjamesriver/ai-solo-studio/branches/audit/AISS-AUTONOMOUS-FEEDBACK-AUDIT-001` → **HTTP 404 Branch not found**; `git ls-remote --heads origin 'audit/*'` → **no refs**. The A0 audit worktree `a8561a9…` existed only locally. |
| Resolution | The audit report + probe + prototype evidence are now published on `audit/AISS-AUTONOMOUS-FEEDBACK-AUDIT-001-delivery` (see `README.md` and `Remote verification` below). |
| Evidence of resolution | `REMOTE-VERIFICATION.log` — `git ls-remote --heads origin audit/AISS-AUTONOMOUS-FEEDBACK-AUDIT-001-delivery` and `gh api …/branches/audit/AISS-AUTONOMOUS-FEEDBACK-AUDIT-001-delivery` returned the same commit SHA as the local branch tip. |
| Caveat | The **original** branch name `audit/AISS-AUTONOMOUS-FEEDBACK-AUDIT-001` is still absent remotely. Only the `-delivery` branch is public; the original worktree commit `a8561a9…` itself is **not** pushed. This delivery reproduces its content (report + probes + 2 modified files + 3 untracked files) but does not publish the original commit object. Do not cite `a8561a9…` as remotely reachable. |

## OPEN-2 — 12 real-service integration suites were skipped, not run

| Field | Value |
| :--- | :--- |
| Status | **OPEN** — not executed, not claimed |
| Observation | `npm test` reports `12 skipped files`, `38 skipped tests`. All 12 are `tests/integration/*.real.test.ts` (gated behind `STUDIO_REAL_CODEX=1` / real credentials). The delivery environment has no real Codex/Claude credentials, so these cannot be run here. |
| Files | see `source-identity.md` §1.2 (12 files, all SHA-256 recorded) |
| Why it matters | The audit report's "677 passed" must not be read as "all 715 tests exercised". 38 tests were skipped by design. |
| How to close | Run `npm run test:real` with real credentials on a machine that has them; publish its log with the same header format. |

## OPEN-3 — Electron E2E suite was not run

| Field | Value |
| :--- | :--- |
| Status | **OPEN** — not executed |
| Observation | `npm run test:e2e` needs `npm run build` + the `electron@45.0.0` binary. In this environment the Electron post-install binary was **not** downloaded (`node_modules/electron/dist` absent; `npm ci` did not run the post-install script). No E2E run is claimed. |
| Why it matters | The audit report's stage-3 plan mentions a future full Electron E2E gate; that gate is not part of A0 and is not evidenced here. |
| How to close | Install Electron with post-install allowed, run `npm run test:e2e`, publish the log. |

## OPEN-4 — Audit report §4.1 wording overstates the full-suite result

| Field | Value |
| :--- | :--- |
| Status | **OPEN** (documentation discrepancy; counts themselves reproduce) |
| Report claim | "主干基线回归：58 个测试文件、677 个单元测试全部通过（0 失败）" |
| Observed | `58` files total is correct, `677 passed`, `0 failed` is correct — but **12 files / 38 tests were skipped**, so "全部通过 / all passed" is imprecise. |
| Decision | Not edited: `report.md` is published verbatim as the audited artifact. This register is the correction of record. |

## OPEN-5 — Audit report's `SettingsPage.tsx` "conflict" is not a textual conflict

| Field | Value |
| :--- | :--- |
| Status | **OPEN** (unresolved discrepancy) |
| Report claim | §1.2 lists `src/renderer/SettingsPage.tsx` as conflicting with upstream; §5.1 recommends discarding it. |
| Observed | The pre-image blob is **identical** at `8dfcfc1` and `e69ca85` (`a5ade870bd27fb222479787221d985bb252daaa3`), i.e. upstream never changed this file. `git apply --check` of the captured diff against a clean `e69ca85` archive returns **exit 0**. It is a *scope exclusion* (a +607/−83 `squadExecutors` UI prototype unrelated to the feedback loop), not a conflict. |
| Decision | File still discarded (scope exclusion is a valid reason), but the wording "conflict" is not supported. Recorded in `integration-patch/NOTE-conflicting-files.md`; report left verbatim. |

## OPEN-6 — `App.tsx` applies textually but is semantically unsafe

| Field | Value |
| :--- | :--- |
| Status | **OPEN** (semantic conflict not machine-provable here) |
| Observed | `git apply --check` of the `App.tsx` diff against clean `e69ca85` returns **exit 0**, because the hunks do not overlap the changed context lines. However the change edits the pre-P0-2 `onImportPlanToTask` path, while `e69ca85` carries the merged `targetPid` target-project gate. Applying it would silently bypass/undo that gate. |
| Decision | Discarded. The textual-applies / semantically-unsafe distinction cannot be proven by a static check; it rests on reading the P0-2 diff, not on a test. Do not machine-apply this diff. |

## OPEN-7 — Prototype's audit findings are still unfixed

| Field | Value |
| :--- | :--- |
| Status | **OPEN** — product findings, out of scope for an evidence-only delivery |
| Findings (from the report, unchanged) | (a) missing-tests false PASS: empty `currentChecks` + exit 0 ⇒ `passed: true`; (b) no tamper-proofing against deleting assertions/tests; (c) race risk from `void this.runFeedbackLoop(...)` inside `runner.on('update')` with no lock; (d) no token/time budget for the review loop; (e) no auto-resume of `reviewing` tasks after app restart. |
| Why it matters | Probe 2 is a *negative* probe that **passes by demonstrating (a)**. A green probe run is evidence the vulnerability exists, **not** evidence it is fixed. Nothing in this delivery fixes any of (a)–(e). |
| How to close | Phase 1/2 of the report's roadmap, with a probe-2-style test inverted to assert `passed: false` when no evidence exists. |

## OPEN-8 — Probe 4 does not exercise the real authorization layer

| Field | Value |
| :--- | :--- |
| Status | **OPEN** (test-quality observation) |
| Report claim | §4.2 probe 4: "验证了通过非法 taskId 注入时，Controller 基础安全层可靠拦截" |
| Observed | The probe injects `load: vi.fn().mockRejectedValue(...)` and asserts the rejection propagates from `processTaskReview`. That proves **error propagation through the loop**, not that `TaskController`'s real authorization/isolation layer intercepts a forged task id. The probe never instantiates a real `TaskController` for this case. |
| Decision | Probe reproduced as-is (4/4 pass, exit 0) but the report's interpretation is stronger than the test. Register as OPEN; do not cite probe 4 as authorization evidence. |

## OPEN-9 — Report §6 documentation-governance claims not re-verified

| Field | Value |
| :--- | :--- |
| Status | **OPEN** — not independently verified by this delivery |
| Claims | §6.1 WebBridge companion-window path ("manual import + fallback, no cross-window DOM"); §6.2 `ChatGPTPlanConfirmDialog` / `ChatGPTFeedbackModal` / `buildChatGPTFeedbackPacket(opts)` signature identity; §6.3 CRG build SHA `9ce89e2` vs HEAD `e69ca85`. |
| Why open | This delivery is an *evidence publication*, not a re-audit. §6.3's CRG index is not contained in the repository checkout, so it cannot be re-derived from `e69ca85` alone. §6.1/§6.2 would require a source-level re-review (which was not requested here). |
| How to close | A follow-up audit pass over the named components + the CRG build identity, with the same log-header discipline. |

## OPEN-10 — Timing figures in the audit report do not reproduce exactly

| Field | Value |
| :--- | :--- |
| Status | **OPEN** (minor; counts match, wall-clock does not) |
| Report claim | §4.1 item 3: 9 prototype tests pass in `170ms`. |
| Observed | Count reproduces exactly (`9 passed (9)`, exit 0) but wall-clock is `845ms` in this run (`Test Files 1 passed`, `Duration 845ms`); one sub-test alone takes ~635ms because it builds a real `TaskController`. |
| Decision | Counts are the reproducible identity; wall-clock is machine/load dependent and is excluded from `source-identity.md` on purpose. Not treated as a failure. |

## OPEN-11 — Delivery branch must never be merged into `rebuild`

| Field | Value |
| :--- | :--- |
| Status | **OPEN by design** (governance constraint) |
| Constraint | This branch is evidence-only. Its product tree is byte-identical to `origin/rebuild` `e69ca85…`; only `docs/` is added. It carries no product change and must not be merged. No PR was opened. |
| How verified | `git rev-parse HEAD^{tree}` before commit == `origin/rebuild^{tree}` (`cf305cd625296a9a098c07cf07ad93f494dd660a`); `git status` shows only `docs/reviews/`. No push to `rebuild` was made. |
| Residual risk | Nothing in git prevents a future merge; the constraint is documentary. A branch-protection rule or CODEOWNERS gate is the enforcement mechanism, not this pack. |

## OPEN-12 — Third-party reproduction requires network + Node 22

| Field | Value |
| :--- | :--- |
| Status | **OPEN** (environment dependency) |
| Observation | `node_modules/` is gitignored and is **not** published. A third party must run `npm ci` (network access) with Node `>=22.22.2 <23`; the system default Node 26 does **not** satisfy `package.json#engines` and is not supported. Electron's post-install binary is additionally needed only for E2E (see OPEN-3). |
| How to close | Not closable by this pack; documented in `environment.md` with exact commands and versions. |

---

## Not open (verified by this delivery)

* The three headline counts reproduce exactly: **677** / **94** / **9**, all exit 0 — see `source-identity.md` and `test-logs/`.
* `npm run typecheck` exit 0 (`test-logs/typecheck.log`).
* 4/4 negative probes exit 0 (`probes/run.txt`) — subject to OPEN-7/OPEN-8 interpretation.
* The 8 in-flight file fingerprints match the pre-work baseline exactly (`fingerprints.md`).
* Protected workspaces unchanged before/after (`fingerprints.md`).
* Integration patch applies cleanly to a clean `e69ca85` archive (`integration-patch/apply-check.log`, exit 0).
* Secret scan performed over every published file (`security-scan.md`).
