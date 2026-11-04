# RUKE — STAGED RESEARCH BENCHMARK PROGRAM (P6)

Status: **PROGRAM DEFINED — MEASUREMENT PENDING.** Nothing in this document
reports a measured score, because none exists yet. Per the staged-research
brief, no number below is a claim about the current system; the release
targets are thresholds the program must be run against, and they may be
unattainable with a particular local model or budget — that tradeoff, if it
occurs, must be published honestly rather than quietly relaxed.

Baseline for any measurement chain: `93637e6` (pre-repair) → final `develop`
head after the P4 staged-research phases. Raw commands and raw outputs must
be archived with every reported run.

## 1. What counts as success (and what does not)

Success is answer correctness **supported by retrieved evidence**, judged by
two independent human reviewers. A Sources badge, high keyword coverage, a
plausible generated paragraph, or a model's own YES-vote is **not** success.
Generator/model voting alone is never ground truth; local-model verdicts
(any local model, including ours) are advisory instrumentation only.

## 2. Two benchmark tracks

**Track A — answerable research tasks.** A versioned task corpus with at
least **429 answerable tasks** must exist before the first answer batch;
answers are sampled at **300 answers at 70%** of the corpus for scoring.
Corpus law: tasks are written from source material with a checkable final
answer (fact lookup chains, multi-page synthesis, current-information
asks); every task records its evidence URL(s) and the exact accepted answer
form. **Never add tasks until the existing results pass** — growing the
corpus to dodge a failing measurement is prohibited.

**Track B — refusal/handling.** An unanswerable/stale-source subset tests
that the system says "could not confirm" instead of inventing; the honest
starved sentinel and the action ledger (P2/P3b) are the observable surface.

## 3. Measurement mechanics already implemented (deterministic counters)

These exist today and are what the program will read out — they measure
acquisition and tool behavior, **never answer correctness**:

- `tests/web-search-10k.spec.ts`: deterministic acquisition counters
  (body ≥ 50 chars or HTTP 200 per sampled URL) across the
  `.data/web-search-10k-urls.json` corpus; the AI YES/NO verdict column is
  explicitly labeled advisory in `docs/web-search-10k-report.md`.
- P3b action ledger (`ToolActionRecord` / `summarizeActionLedger`): every
  search/read attempt, ok/failed/rejected counts, nonexistence law lines —
  persisted server-side, never client-supplied.
- P4 evidence-gap recovery log lines (provider tier actually used).

## 4. Release targets (pending measurement — not claims)

Per the brief, evaluated over ≥300 human-reviewed answers:

| Metric | Target |
|---|---|
| Fabricated sources | 0 (95% upper bound ≈ 0.994% at n=300) |
| Complete-correctness (95% lower confidence bound) | ≥ 95% |
| Answer coverage | ≥ 70% |
| Material claim support from retrieved evidence | ≥ 98% |
| Required-info coverage | ≥ 90% |
| Unanswerable handled honestly | ≥ 95% |
| Advantage vs. baseline chain (paired intervals) | ≥ 5 pp |

These thresholds may be unattainable with the local model/budget available.
If a run fails a target, the honest deliverable is the failing number plus
the tradeoff analysis — not a weakened corpus, not a relabeled metric, not
a silent threshold change.

## 5. Comparison protocol

Comparisons against named commercial configurations (e.g. ChatGPT/Claude
search settings) use the same task corpus, same two-reviewer rubric, and
paired task-by-task scoring with intervals. No claim of "number one", zero
hallucinations, universal website access, or competitor parity is
authorized by the existence of this architecture — such claims require the
completed paired measurement and may never be published without it.

## 6. Reviewer protocol

Two human reviewers score independently: correctness, evidence support
(every material claim traceable to a retrieved record), and honesty on
gaps. Disagreements adjudicate to the stricter score unless a source quote
settles it. Review rubric, task corpus, and raw answer transcripts are
versioned in-repo (git-ignored scratch under `.data/` until finalized).

## 7. Execution order

1. Freeze the final `develop` head (post-P4 chain) — record its hash.
2. Build the ≥429-task corpus + Track B subset; review tasks before use.
3. Run Track A sampling (300 @ 70%) against the frozen head through the
   production chat path (Rust ruke-server, gate + planner + tools
   enabled), archiving raw commands, logs, ledgers and answers.
4. Double-blind human review; compute the six release metrics + paired
   baseline comparison.
5. Publish results — pass or fail — with raw data pointers. Only then may
   any capability claim reference these numbers.

No section of this program is optional, and no phase of it has been
executed at the time this document was written.
