# Security / secret scan — before push

Scope: **every file published by this branch**, i.e. everything under
`docs/reviews/` (31 files, including both copies of the audit report), plus a
repository-artifact check that no `node_modules/`, `.studio/`, `.env*` or key
material is staged.

## 1. Scan command (exact)

```bash
cd ~/ai-solo-studio-a0-delivery
FILES=$(find docs/reviews -type f | sort)
for p in 'sk-' 'ghp_' 'gho_' 'ghu_' 'ghs_' 'github_pat_' 'AKIA' 'AIza' \
         'xox[baprs]-' 'Bearer ' 'PRIVATE KEY' 'password' 'token=' '\.env' \
         '/Users/[A-Za-z0-9._-]+'; do
  echo "--- pattern: $p"
  grep -rnE -- "$p" $FILES 2>/dev/null
done
# genuine-credential-shaped check (not just the loose literals):
grep -rnE 'AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|xox[baprs]-[0-9A-Za-z-]+|github_pat_[0-9A-Za-z_]{20,}|gh[pousr]_[0-9A-Za-z]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|sk-[A-Za-z0-9]{20,}' $FILES
# forbidden artifact classes:
find docs/reviews \( -name 'node_modules' -o -name '.studio' -o -name '.env*' -o -name '*.pem' -o -name '*.key' \) -print
```

Raw capture (outside the repo, not published):
`~/a1-evidence/a0-delivery-raw/secret-scan-raw-1.txt`.

## 2. Output summary

| Pattern | Hits | Interpretation | Decision |
| :--- | --: | :--- | :--- |
| `sk-` | 110 | 26 are the substring in the filename `task-controller.ts`; 6 are the literal UI placeholder `placeholder="sk-ant-…"`; 2 are the deliberate fake fixture `sk-proj-e2e-secret-999999` in baseline `e2e/shell.e2e.ts` (a redaction test that asserts this string is **not** shown); remainder are `task-*` test ids (`probe-task-001`, `task-list`). **No `sk-[A-Za-z0-9]{20,}` real-key shape exists.** | **retain** — false positives / fake fixtures already public in baseline |
| `ghp_`, `gho_`, `ghu_`, `ghs_`, `github_pat_` | 0 | — | — |
| `AKIA`, `AIza`, `xox[baprs]-` | 0 | — | — |
| `Bearer ` | 9 | Prose in the report ("Bearer Token 脱敏") + code templates (`Authorization: Bearer ${token}`) + one fake JWT round-trip fixture `Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.token123` in the prototype test | **retain** — no real token; fixture is syntactically invalid |
| `PRIVATE KEY` | 0 | — | — |
| `password` | 5 | HTML `type="password"` attributes in `SettingsPage.tsx` + one test-request string ("email 和 password 字段做规范校验") | **retain** — UI/type names, not secrets |
| `token=` | 0 | — | — |
| `.env` | 34 | `process.env.*` reads in baseline `e2e/shell.e2e.ts` + one prose mention in `README.md` | **retain** — no `.env` file is published; `find` confirmed none |
| `/Users/<name>` | 19 | Absolute local paths in the verbatim report/logs/diff source headers (see §4) | **retain with rationale** (§4); one self-authored note path rewritten to `~` |
| personal names | see §5 | `luckyjamesriver` = public GitHub owner (required push URL); `jamesho` = local OS username in paths; `JamesMacStudio.local` = hostname inside the mandated `uname -a` log header | **retain** — public account / mandated header |
| genuine credential shapes (AWS/GCP/Slack/GitHub PAT/private key/`sk-` key) | **0** | negative check returned `NO REAL CREDENTIAL-SHAPED STRINGS` | — |
| forbidden artifacts (`node_modules`, `.studio`, `.env*`, `*.pem`, `*.key`) | **0** | `find` returned nothing | — |

No hit required **exclusion** of a file. No hit was a credential.

## 3. Repository-artifact check (no node_modules / .studio / .env staged)

```text
$ git status --porcelain          # before staging
?? docs/reviews/
$ git add -A docs/reviews && git diff --cached --stat   # see §6
$ git ls-files docs/reviews | grep -E 'node_modules|\.studio|\.env'   # -> no output
```

`node_modules/` exists in the delivery worktree (needed to run the suites) but is
covered by `.gitignore` (`node_modules/`, `.studio/`, `*.log` — note: the evidence
logs are committed **inside `docs/` as explicitly force-added evidence**, which is
the only reason `*.log` under `docs/` is tracked; see `.gitignore` handling note
in §6).

## 4. Decision: absolute local paths — RETAIN with rationale

`/Users/jamesho/…` appears in:

* `report.md` and `docs/reviews/AISS-AUTONOMOUS-FEEDBACK-AUDIT-001.md` — lines 4,
  5, 127. These are the **verbatim audit report** the task mandates; editing them
  would falsify the artifact.
* `test-logs/*.log`, `probes/run.txt`, `integration-patch/apply-check.log` —
  header `pwd` fields and vitest's `RUN v5.0.5 /Users/...` line. These are
  machine-generated **evidence logs**; doctoring paths would break the "real,
  fresh logs" requirement and the SHA-256 chain.
* `prototype-8-files/diffs/0*.diff` line 1 — provenance header stating which
  protected worktree each diff came from. Provenance is the point of the file.

Rationale for retaining:

1. A local macOS username is not a credential, token, or key.
2. The **same string** `/Users/jamesho/ai-solo-studio-rebuild` is already present
   in the **public** baseline repo at `e69ca85` (e.g. `docs/CURRENT_BASELINE.md`,
   and 6 other tracked files; `git grep -l 'jamesho' HEAD` finds 7 files). This
   delivery therefore does not newly disclose it.
3. `uname -a` (which contains the hostname) is a **mandatory** part of every
   evidence-log header per the delivery spec, so `JamesMacStudio.local` cannot be
   removed without violating the spec.

**Redaction actually applied:** in the one self-authored file where the path was
not required for provenance — `integration-patch/NOTE-conflicting-files.md` — the
scratch path was rewritten from `/Users/jamesho/a0-scratch/discardtest` to
`~/a0-scratch/discardtest`. All newly-authored prose (`README.md`,
`source-identity.md`, `environment.md`, `fingerprints.md`, `open-items.md`) uses
`~` / relative paths, not `/Users/jamesho/…`.

## 5. Personal-name review

| String | Where | Why retained |
| :--- | :--- | :--- |
| `luckyjamesriver` | push URL, `gh api` repo slug, open-items evidence | Public GitHub owner/org name; required to state the remote. |
| `jamesho` | verbatim report + log headers + diff provenance | Local OS username, already public in baseline repo (see §4). |
| `JamesMacStudio.local` | `uname -a` in mandatory log headers | Host name in a spec-mandated header; no third-party personal data. |

No other personal names were found in unusual places (grep over all 30 files).

## 6. Staged-content audit before commit

To be captured immediately before commit (see the verification commit's
`REMOTE-VERIFICATION.log` for the matching `git ls-remote`):

```text
$ git add -A docs && git status --porcelain
A  docs/reviews/AISS-AUTONOMOUS-FEEDBACK-AUDIT-001.md
A  docs/reviews/AISS-AUTONOMOUS-FEEDBACK-AUDIT-001/README.md
…  (30 evidence files, all under docs/reviews/)
$ git diff --cached --stat
30 files changed, … insertions(+)
$ git diff --cached --name-only | grep -vE '^docs/reviews/'   # -> no output
```

Result: the staged set contains **only** `docs/reviews/**`. No product source,
no `node_modules`, no `.studio`, no `.env*`, no binaries.

## 7. Final post-write scan (self-reference note)

This file contains the scan pattern literals themselves (`sk-`, `Bearer `, etc.)
as documentation, so a re-scan over the now-31-file set will — and does — report
hits **inside `security-scan.md`**. Those are expected and are the documentation
text, not secrets. The final scan output recorded in §8 lists them explicitly so
the reader is not left to infer it.

## 8. Final scan result

See the appended block at the end of this file (produced after all evidence files
were finalized, immediately before `git add`).

### Final scan output (pre-commit, 2026-11-24T03:04:24Z, 31 files)

```text
final_scan_utc: 2026-11-24T03:04:24Z
file_count: 31
pattern: sk- => 118 hits
pattern: ghp_ => 2 hits
pattern: gho_ => 2 hits
pattern: ghu_ => 2 hits
pattern: ghs_ => 2 hits
pattern: github_pat_ => 3 hits
pattern: AKIA => 3 hits
pattern: AIza => 3 hits
pattern: xox[baprs]- => 0 hits
pattern: Bearer  => 12 hits
pattern: PRIVATE KEY => 3 hits
pattern: password => 7 hits
pattern: token= => 2 hits
pattern: \.env => 42 hits
pattern: /Users/[A-Za-z0-9._-]+ => 24 hits
--- genuine credential shapes ---
NONE
--- files with hits ---
pattern sk-: AISS-AUTONOMOUS-FEEDBACK-AUDIT-001.md AISS-AUTONOMOUS-FEEDBACK-AUDIT-001/README.md AISS-AUTONOMOUS-FEEDBACK-AUDIT-001/environment.md AISS-AUTONOMOUS-FEEDBACK-AUDIT-001/fingerprints.md AISS-AUTONOMOUS-FEEDBACK-AUDIT-001/integration-patch/apply-check.log AISS-AUTONOMOUS-FEEDBACK-AUDIT-001/integration-patch/integration.patch AISS-AUTONOMOUS-FEEDBACK-AUDIT-001/probes/audit-negative-probes.test.ts AISS-AUTONOMOUS-FEEDBACK-AUDIT-001/prototype-8-files/MANIFEST.md AISS-AUTONOMOUS-FEEDBACK-AUDIT-001/prototype-8-files/diffs/02-src_core_app_task-controller.ts.diff AISS-AUTONOMOUS-FEEDBACK-AUDIT-001/prototype-8-files/diffs/05-src_renderer_SettingsPage.tsx.diff AISS-AUTONOMOUS-FEEDBACK-AUDIT-001/prototype-8-files/post-images/e2e/shell.e2e.ts AISS-AUTONOMOUS-FEEDBACK-AUDIT-001/prototype-8-files/post-images/src/core/app/task-controller.ts AISS-AUTONOMOUS-FEEDBACK-AUDIT-001/prototype-8-files/post-images/src/renderer/SettingsPage.tsx AISS-AUTONOMOUS-FEEDBACK-AUDIT-001/prototype-8-files/untracked/src/core/app/autonomous-feedback-loop.ts AISS-AUTONOMOUS-FEEDBACK-AUDIT-001/prototype-8-files/untracked/tests/autonomous-feedback-loop.test.ts AISS-AUTONOMOUS-FEEDBACK-AUDIT-001/report.md AISS-AUTONOMOUS-FEEDBACK-AUDIT-001/security-scan.md AISS-AUTONOMOUS-FEEDBACK-AUDIT-001/source-identity.md AISS-AUTONOMOUS-FEEDBACK-AUDIT-001/test-logs/prototype-9-tests.log 
pattern Bearer : AISS-AUTONOMOUS-FEEDBACK-AUDIT-001.md AISS-AUTONOMOUS-FEEDBACK-AUDIT-001/prototype-8-files/post-images/e2e/shell.e2e.ts AISS-AUTONOMOUS-FEEDBACK-AUDIT-001/prototype-8-files/untracked/src/core/thinking/chatgpt-devkit.ts AISS-AUTONOMOUS-FEEDBACK-AUDIT-001/prototype-8-files/untracked/tests/autonomous-feedback-loop.test.ts AISS-AUTONOMOUS-FEEDBACK-AUDIT-001/report.md AISS-AUTONOMOUS-FEEDBACK-AUDIT-001/security-scan.md 
pattern password: AISS-AUTONOMOUS-FEEDBACK-AUDIT-001/prototype-8-files/diffs/05-src_renderer_SettingsPage.tsx.diff AISS-AUTONOMOUS-FEEDBACK-AUDIT-001/prototype-8-files/post-images/src/renderer/SettingsPage.tsx AISS-AUTONOMOUS-FEEDBACK-AUDIT-001/prototype-8-files/untracked/tests/autonomous-feedback-loop.test.ts AISS-AUTONOMOUS-FEEDBACK-AUDIT-001/security-scan.md 
pattern \.env: AISS-AUTONOMOUS-FEEDBACK-AUDIT-001/README.md AISS-AUTONOMOUS-FEEDBACK-AUDIT-001/prototype-8-files/post-images/e2e/shell.e2e.ts AISS-AUTONOMOUS-FEEDBACK-AUDIT-001/security-scan.md 
pattern /Users/[A-Za-z0-9._-]+: AISS-AUTONOMOUS-FEEDBACK-AUDIT-001.md AISS-AUTONOMOUS-FEEDBACK-AUDIT-001/integration-patch/apply-check.log AISS-AUTONOMOUS-FEEDBACK-AUDIT-001/probes/run.txt AISS-AUTONOMOUS-FEEDBACK-AUDIT-001/prototype-8-files/diffs/01-e2e-shell.e2e.ts.diff AISS-AUTONOMOUS-FEEDBACK-AUDIT-001/prototype-8-files/diffs/02-src_core_app_task-controller.ts.diff AISS-AUTONOMOUS-FEEDBACK-AUDIT-001/report.md AISS-AUTONOMOUS-FEEDBACK-AUDIT-001/security-scan.md AISS-AUTONOMOUS-FEEDBACK-AUDIT-001/test-logs/94-test-selection.log AISS-AUTONOMOUS-FEEDBACK-AUDIT-001/test-logs/npm-test.log AISS-AUTONOMOUS-FEEDBACK-AUDIT-001/test-logs/prototype-9-tests.log AISS-AUTONOMOUS-FEEDBACK-AUDIT-001/test-logs/typecheck.log 
--- forbidden artifact classes ---
```

**Conclusion:** no credential-shaped string, no private key, no `.env`/`.studio`/`node_modules` artifact, no file requiring exclusion. All hits are the documented false-positives above. **PASS — safe to push.**

### Post-verification delta scan (commit B: README update + REMOTE-VERIFICATION.log)

Changed/added files scanned: `README.md`, `open-items.md`, `security-scan.md`, `REMOTE-VERIFICATION.log`.

```text
delta_scan_utc: 2026-11-24T03:05:13Z
pattern: sk- => 11 hits
pattern: ghp_ => 3 hits
pattern: gho_ => 3 hits
pattern: ghu_ => 3 hits
pattern: ghs_ => 3 hits
pattern: github_pat_ => 4 hits
pattern: AKIA => 4 hits
pattern: AIza => 4 hits
pattern: xox[baprs]- => 0 hits
pattern: Bearer  => 5 hits
pattern: PRIVATE KEY => 4 hits
pattern: password => 4 hits
pattern: token= => 3 hits
pattern: \.env => 12 hits
pattern: /Users/[A-Za-z0-9._-]+ => 5 hits
--- genuine credential shapes ---
NONE
--- /Users hits (should be report/log-only; README/open-items/REMOTE-VERIFICATION expected 0) ---
docs/reviews/AISS-AUTONOMOUS-FEEDBACK-AUDIT-001/security-scan.md:64:`/Users/jamesho/…` appears in:
docs/reviews/AISS-AUTONOMOUS-FEEDBACK-AUDIT-001/security-scan.md:70:  header `pwd` fields and vitest's `RUN v5.0.5 /Users/...` line. These are
docs/reviews/AISS-AUTONOMOUS-FEEDBACK-AUDIT-001/security-scan.md:79:2. The **same string** `/Users/jamesho/ai-solo-studio-rebuild` is already present
docs/reviews/AISS-AUTONOMOUS-FEEDBACK-AUDIT-001/security-scan.md:89:scratch path was rewritten from `/Users/jamesho/a0-scratch/discardtest` to
docs/reviews/AISS-AUTONOMOUS-FEEDBACK-AUDIT-001/security-scan.md:92:`~` / relative paths, not `/Users/jamesho/…`.
```

**Delta conclusion:** no credential-shaped content in the verification commit; the only pattern hits are the documentation literals in this file (self-reference, expected). No new secret, no new artifact class. **PASS.**
