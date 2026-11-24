# File-reading regression — fr-20261122 (final report at user-requested stop)

Revision: HEAD `83bbce3e5183be2ffcf451f0c5cff1f7ed556fcd`, branch `local`,
worktree fingerprint in
`.data/tmp/file-regression/fr-20261122b/evidence/revision-fr-20261122b.txt`.
Run spec sha256 `5997718B64A2…` (frozen for the batch); post-run spec
(replay fingerprint, only the fr-Z0 probe rewritten) sha256 `7D1445A61F87…`.

**Verdict: HOLD.** 59 of 61 tests ran (40 ✓ / 19 ✘); test 60 was in flight and
test 61 never ran when the user requested the stop at 12:37 local. Full defect
register: `testing/ISSUES.md` F62–F75. The batch itself terminated cleanly:
gate PASS 61/61, lock released, fixture server + dev supervisor stopped,
sampler stopped, DONE = `ATTEMPT=fr-20261122b GATE=PASS EXIT=1 END=11/22/2026 12:37:17`.

## Attempt history (do not conflate)

| Attempt | Outcome |
|---|---|
| F78 (commit 83bbce3, historical) | 119-row frozen matrix green + 11 live rows green (previous run, recorded pass) |
| fr-20261122a (attempt-a) | **Zero live tests.** Backslash test path → Playwright positional regex → "No tests found" exit 1; DONE written to repo root (relative path after launcher `Set-Location`); sampler orphaned. Evidence preserved: repo-root `fr-live-DONE`, `.data/tmp/file-regression/fr-20261122b/evidence/` |
| fr-20261122b launch 1 (10:40) | Pre-lock gate throw EXIT=90: PS 5.1 ANSI-decodes BOM-less UTF-8 .ps1 → U+203A mojibake → empty ID list. Lock never taken. Fixed: runner is ASCII-only. |
| fr-20261122b launch 2 (10:41:41) | Gate PASS 61/61/0/0; lock runId 68d045a3; isolated store `.data/e2e-store`; **user-requested stop 12:37:17** after tests 1–59 (40 ✓ 19 ✘), 60 killed mid-flight, 61 not started. |

## Gates on the final tree (model-free, pre-submission)

cargo 741 passed / 0 failed (25.8 s) · vitest 2607 / 0 (68.1 s) · python 581 / 0
(64.6 s) · tsc 0 errors (4.1 s) · contracts OK (0.3 s) —
`.data/tmp/file-regression/fr-20261122b/gates-summary.txt`.
Frozen 119-row extension matrix (g102): 119/119, peak worker-tree 4906.4 MiB.
Fixtures: 55/55 sha256 verified against manifest.

## Live batch result table (per test, discovery order; transcript `fr2-submit.log`)

| # | Test | Result | Failure layer (see ISSUES.md) |
|---|---|---|---|
| 1 | fr-T1 utf16 tail + scroll-lock | ✘ | UI scroll-lock not released, F62 (answer itself OK) |
| 2 | fr-Z0 store isolation | ✘ | harness probe defect F75(a); isolation VERIFIED by ground truth |
| 3 | fr-T2 utf32 tail | ✓ | |
| 4 | fr-T3 quoted-multiline CSV row 50 | ✘ | CSV row addressing, F63 |
| 5 | fr-T4 JSONL final record | ✓ | |
| 6 | fr-T5 Dockerfile pins | ✓ | |
| 7 | fr-G2 whitespace-padded filename | ✓ | |
| 8 | fr-G1 text-as-PDF negative | ✘ | app refused at upload boundary (law satisfied); harness gap F75(b) |
| 9 | fr-D1 footnote-only word | ✓ | |
| 10 | fr-D5/D4 tracked deletion+insertion | ✓ | deletion visible; insertion MERIDIAN-2298; law rows recorded |
| 11 | fr-D6 docm Russian facts | ✘ | index readiness timeout, F71 |
| 12 | fr-S5 speaker-notes code | ✓ | |
| 13 | fr-S3 native chart largest value | ✘ | chart XML not extracted, F64 |
| 14 | fr-S1/S2 SEWP facts | ✓ | |
| 15 | fr-X2 fcff revenue cell | ✓ | |
| 16 | fr-X3 DfE rendered formula | ✓ | |
| 17 | fr-X1/S-X4 tuple + cached result | ✘ | X1 ✓ (Almarai); follow-up (cached A1) never replied, F72 |
| 18 | fr-X6 legacy BIFF8 NPV | ✓ | |
| 19 | fr-N1 notebook stored dims | ✓ | |
| 20 | fr-N2 stored slope digits | ✓ | |
| 21 | fr-A1/A2 nested zip + basename collision | ✓ | |
| 22 | fr-A3 large member tail | ✓ | |
| 23 | fr-A4 truncated archive | ✓ | |
| 24 | fr-A5 encrypted 7z | ✓ | |
| 25 | fr-P10 scanned PDF OCR | ✘ | OCR never ran, BLOCKED attribution per key, F65 |
| 26 | fr-P1 SPM figure legend | ✘ | key-vs-fixture ambiguity, F73 |
| 27 | fr-P5/P6 direction signature | ✓ | P6 Accounting officer |
| 28 | fr-P7/P8/P9 rotated SQL battery | ✘ | P7 omits `kestrel` (F74a); P8 ✓; P9 clean refusal ✓ (hallucination law row recorded) |
| 29 | fr-I1/I2 multipage TIFF page 2 | ✘ | only page 1 delivered, F66 |
| 30 | fr-I3 animated GIF last frame | ✘ | single static frame delivered, F67 |
| 31 | fr-I4 HEIC dimensions | ✘ | 1250×612 vs 1280×720, F68 |
| 32 | fr-I5 rotated JPEG orientation | ✓ | orientation law row recorded |
| 33 | fr-U1 audio ch1 scene | ✓ | |
| 34 | fr-U6 ch2 captains | ✘ | "Joe Harper" vs EXACT "Jo Harper", F74(b) (content correct) |
| 35 | fr-U4 ch3 guard number | ✓ | 400 |
| 36 | fr-V2 CS50 middle frame | ✘ | 15.0 min timeout, F70 |
| 37 | fr-V5/V7/V9 3h+ video battery | ✘ | 20.1 min timeout, F70 |
| 38 | fr-T7 UTF-16 past 48k → index route | ✓ | WALRUS-BOUNDARY-9131 |
| 39 | fr-R1 RTF price | ✘ | answered "42" (correct) vs EXACT phrase, F74(c) |
| 40 | fr-L1 legacy .doc | ✓ | |
| 41 | fr-L2 legacy .xls | ✓ | |
| 42 | fr-L3 legacy .ppt | ✓ | |
| 43 | fr-O1 ODF text | ✓ | |
| 44 | fr-O2 ODF spreadsheet | ✓ | |
| 45 | fr-O3 ODF presentation | ✓ | |
| 46 | fr-O4 epub | ✓ | |
| 47 | fr-XM1 xlsm, macros not executed | ✓ | |
| 48 | fr-M1 .mat | ✓ | |
| 49 | fr-A6 gz member | ✓ | |
| 50 | fr-A12 RAR honest-decoder law | ✓ | explicit member readout, no fabrication; chip row recorded |
| 51 | fr-N3 saved plot style (no exec) | ✓ | seaborn-whitegrid |
| 52 | fr-N4 exact integer 9007199254740993 | ✓ | |
| 53 | fr-U7 audio middle 47 kg | ✓ | |
| 54 | fr-P11 native PDF, OCR must NOT run | ✓ | Kandla + 4,18,25,000 p6 |
| 55 | fr-P4 242 MB 3970-page report | ✓ | AMS Glossary of Meteorology (6.2 min) |
| 56 | fr-P2/P3 SPM rate + SMB | ✘ | P2 ✓ (7 %/°C); P3 follow-up never recorded, F70/F72 family |
| 57 | fr-P5 latest month | ✘ | "July 2026" vs "March 2026", F69 |
| 58 | fr-D2 endnote XXX | ✓ | |
| 59 | fr-D3 field codes ANTONI 16 June 2010 | ✓ | |
| 60 | fr-V1/V3/V4 CS50 battery | KILLED | in flight at user stop; not scored |
| 61 | fr-Z1 mid-stream cancellation | NOT RUN | user stop |

## Measurement integrity

- **Three-way ID reconciliation:** discovery gate 61 == frozen plan 61 == 61
  list-reporter lines (40 ✓ + 19 ✘ + 1 in-flight (60) + 0 (61 started); the
  reporter's own "Total: 61" line reconciles with the plan, diff=0, dupes=0).
  Missing rows by design: tests failing inside `send()` record no answer row
  (fr-G1, fr-D6, fr-X4, fr-P3, fr-V2, fr-V5/7/9).
- **Scores:** 71 scored-question rows in
  `docs/overnight/file-regression-fr-20261122a/results-live.jsonl`
  (ts ≥ 2026-11-22T05:11:41Z) graded against ANSWER-KEY v1 + SUPPLEMENT v2.
  fr-X10 tuple `(ToC,B1,15)+SUM(B9:B19)` scored PASS; the swapped-sheet scorer
  self-test (scorer must FAIL a swapped answer) was not executed offline —
  scheduled for the replay.
- **Memory (15 s sampling, MiB, `fr2-mem.csv`, 5472 samples 10:41:41→12:37:14):**
  peak attributable non-LLM (node+ruke-server+chrome+python+ffmpeg;
  Strata inference 48.9 GB resident EXCLUDED): **4131.1 MiB at 12:18:13** —
  above the 4 GB (4096 MiB) line by ~35 MiB, far below 5 GB. Single-proc peaks:
  node 3697.9, python 430.8, chrome 386.4, ffmpeg 329.6, ruke-server 150.2.
- **:8080 exclusivity honesty:** 15 s TCP ESTABLISHED sampling shows the
  endpoint continuously busy (305/456 samples ≥1, max 2); sampling can miss
  sub-15 s requests and cannot prove client identity. Claude issued zero
  inference requests during the batch (submitter is `npx playwright` only).
- **Store isolation:** launcher banner `e2e conversation store isolated:
  .data\e2e-store (source: launcher default)` + ground-truth census
  (`evidence/store-isolation-groundtruth.txt`: real store 1230 files, 0 touched;
  e2e-store 10 touched).
- 913-byte maintenance-page fixture rule: no row hit it this batch.

## Exact replay

```
# from D:\Projects\WebUI\WebUI — pre-lock gate + exclusive batch + cleanup markers
powershell -NoProfile -ExecutionPolicy Bypass -File .data\tmp\file-regression\fr-20261122b\fr2-submit.ps1
# completion: .data\tmp\file-regression\fr-20261122b\fr2-live-DONE must contain ATTEMPT=fr-20261122b
# gates only:  powershell -NoProfile -ExecutionPolicy Bypass -File .data\tmp\file-regression\fr-20261122b\fr2-gates.ps1
# scoring:     docs/overnight/file-regression-fr-20261122a/ANSWER-KEY.md (frozen; never fed to Ruke)
```

Replay uses the post-fix spec (sha 7D1445A6…): fr-Z0 probe fixed (mtime +
real-store), G1 upload-boundary refusal accepted, per-test budgets for long
video to be raised before the V rows are trusted (F70).

---

# C6 final table + GREEN/HOLD recommendation — 2026-11-24 (runs F76–F151)

Supersedes the Nov-22 "HOLD" above: that verdict was scored at a mid-run user
stop (40 ✓ / 19 ✘, 2 rows unscored). Every layer it flagged has since been
fixed and live-verified across runs F76–F151 (full register: `testing/ISSUES.md`).

## Final scoreboard (all captured, 2026-11-24)

| Gate | Result |
|---|---|
| Live F-series suite (targeted f95-w2 replay, exclusive, GATE=PASS EXIT=0) | fr-W1a/W1b/C2 × all PASS; W1 paired journey GREEN end-to-end first time since 2026-11-22 (dispatch {7,92,163,[]} real ledger) |
| Frozen 119-row extension matrix (g100, stack up) | **105/119**; the 14 reds = GPU-mandatory ASR family only (overlap.* 6 audio, dual.* 8 video) → F123 honest INSTALLATION-fault chip at the probe boundary (no bridge secret in-proc; dev2.log ZERO asr activity) under the pinned Parakeet CUDA law; F78 baseline greenness came from the since-REMOVED Whisper CPU engine. Recorded, not hidden (ISSUES.md F143 row 2026-11-24). |
| python discover (plain, repo venv) | **746/746 OK** (skipped=1) |
| vitest full | **2691 passed / 0 failed**, 25 skipped (212 files) |
| tsc | **0 errors** |
| contracts:check | **OK** |
| cargo -p ruke-server | **EXIT=0** |
| cargo --workspace | **744 passed / 0 failed** (27 suites) |
| npm run build (production) | **EXIT=0** (25/25 pages) |

## Recommendation: **GREEN (conditional)**

- Product layer: GREEN — every model-free gate is green and every live
  acceptance row passes, including the rows the Nov-22 HOLD named
  (F62–F75 all closed; F147/F148/F151 closed live this run).
- Condition: the 14 ASR matrix rows require GPU-Parakeet; on this host CUDA
  init hits WinError 1455 (paging file too small) — a SYSTEM-STATE user
  decision (ISSUES.md F143), not a product defect. Raising/managing the
  pagefile converts the matrix to 119/119 without any code change.
- Release remains the user's call; no commits were made by overnight runs.

Exact replay: f95-w2 kit `.data/tmp/file-regression/f95-w2/` (fr2-submit
protocol); matrix `.data/tmp/g100-final/submit2.ps1`.
