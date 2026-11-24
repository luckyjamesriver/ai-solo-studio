# Environment — A0 independent audit delivery

All values below were captured on the machine that produced the evidence in this
directory. Any third party reproducing the numbers should expect the test counts to
be identical (they are deterministic unit tests) but may see different wall-clock
times and different OS/build metadata.

## Host

| Fact | Value |
| :--- | :--- |
| OS | macOS 27.2.1 (build `26B131`) |
| Kernel | `Darwin 27.2.0` / `xnu-13432.41.4~25/RELEASE_ARM64_T6000` |
| Architecture | `arm64` (Apple Silicon) |
| CPU | Apple M1 Ultra, 20 logical cores |
| Memory | 64 GiB (68 719 476 736 bytes) |
| Timezone | `Asia/Singapore` (`+08`, `+0800`) |
| Xcode / CLT | Xcode present at `/Applications/Xcode.app/Contents/Developer`; `com.apple.pkg.CLTools_Executables` version `27.2.0.0.1792721180` |
| Hostname note | The kernel hostname is intentionally not reproduced here; it is not needed to reproduce any count. |

## Toolchain

| Tool | Version | Path / notes |
| :--- | :--- | :--- |
| Node.js | `v22.23.5` | `/opt/homebrew/opt/node@22/bin/node` (required; system node is v26 and is **not** compatible with the project engines range) |
| npm | `10.9.9` | `/opt/homebrew/opt/node@22/bin/npm` |
| vitest | `5.0.5` (`vitest/5.0.5 darwin-arm64 node-v22.23.5`) | installed by `npm ci` from `package-lock.json` |
| TypeScript | `5.9.3` | installed by `npm ci` |
| Electron (declared devDependency) | `45.0.0` | binary post-install was not required for any recorded run (no recorded run imports the Electron runtime; unit tests are Node-only) |
| gh CLI | `2.105.0` (2026-11-17) | authenticated as `luckyjamesriver`, scopes `repo` + `workflow` |
| git | `2.54.0` (Apple Git-157) | |
| Python (not used by any recorded run) | `3.13.13` | recorded only for completeness |

## Repository identity

| Fact | Value |
| :--- | :--- |
| Baseline commit (`origin/rebuild`) | `e69ca8511a17acfc4427954af13ef6d364ffb553` |
| Delivery worktree | `~/ai-solo-studio-a0-delivery` |
| Delivery branch | `audit/AISS-AUTONOMOUS-FEEDBACK-AUDIT-001-delivery` |
| Dependency install | `npm ci` (executed fresh inside the delivery worktree on 2026-11-24; 105 packages, 0 vulnerabilities) |

## Exact reproduction commands

Every command below assumes `PATH` is put on Node 22 first:

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
cd ~/ai-solo-studio-a0-delivery     # or: git clone -b audit/AISS-AUTONOMOUS-FEEDBACK-AUDIT-001-delivery <remote>
npm ci

# (a) typecheck
npm run typecheck

# (b) full suite — expect Test Files 46 passed | 12 skipped (58),
#     Tests 677 passed | 38 skipped (715), exit 0
npm test

# (c) 94-test selection — expect Tests 94 passed (94), exit 0
npx vitest run tests/b4-2-controller.test.ts tests/runner.test.ts tests/flow.test.ts
```

The prototype (9-test) run needs a **scratch** copy of the baseline that the
delivery branch deliberately does not modify. See `source-identity.md` §3 and
`prototype-8-files/MANIFEST.md`; the short form is:

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
S=~/a0-scratch/proto
mkdir -p "$S"
git archive e69ca8511a17acfc4427954af13ef6d364ffb553 | tar -x -C "$S"
cp -R ~/ai-solo-studio-a0-delivery/node_modules "$S/node_modules"
cp prototype-8-files/untracked/src/core/app/autonomous-feedback-loop.ts      "$S/src/core/app/"
cp prototype-8-files/untracked/src/core/thinking/chatgpt-devkit.ts           "$S/src/core/thinking/"
cp prototype-8-files/untracked/tests/autonomous-feedback-loop.test.ts        "$S/tests/"
cp prototype-8-files/post-images/src/core/app/task-controller.ts             "$S/src/core/app/"
cp prototype-8-files/post-images/src/core/thinking/index.ts                  "$S/src/core/thinking/"
cd "$S" && npx vitest run tests/autonomous-feedback-loop.test.ts
```

Negative-probe run (4 probes, expected 4/4 pass, exit 0) is described in
`probes/run.txt`.

## Caveat on determinism

Test counts are deterministic. Two things are *not* guaranteed across machines:

1. Wall-clock durations in the logs (`tests/security.test.ts` and the stage-6
   suites are deliberately slow; a first run can take ~3–5 minutes total).
2. The `electron@45.0.0` package's post-install binary is not downloaded in this
   environment; that does not affect any recorded run, but a future E2E
   reproduction (`npm run test:e2e`) would require a full post-install.
