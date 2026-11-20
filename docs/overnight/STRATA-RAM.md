# Strata RAM placement: the measured host bottleneck and the quality-preserving lever

Measured 2026-11-16 (this session, read-only probes; nothing was restarted or reconfigured).

## What the host actually looks like

| Quantity | Value | How measured |
| --- | --- | --- |
| Physical RAM total | 63.77 GiB (`65,299 MiB`) | `GlobalMemoryStatusEx` / `Win32_OperatingSystem` |
| Physical RAM free | **3.66 GiB** (was 4.9 GiB earlier in the evening, and it keeps shrinking) | same |
| Commit limit / free | 97.77 GiB / 26.85 GiB | same |
| Pagefile `C:\pagefile.sys` | 34,816 MiB allocated, 830 MiB used, 1,016 MiB peak | `Win32_PageFileUsage` |
| `strata.exe` (pid 5272, the shared main LLM) | **52,217 MiB working set / 62,800 MiB private** | `Win32_Process` |
| GPU RTX 3060 | 12,288 MiB, ~9.4 GiB used, compute app = strata.exe | `nvidia-smi` |
| Everything else | VS Code ~1.5 GiB total, MsMpEng 282 MiB, dwm 225 MiB | `Get-Process` |

The model files on disk: main GGUF `54,817,524,224 B` + PLE GGUF `28,800,138,432 B`.
Running command line (pid 5272) contains `--expert-profile … --expert-cache auto
--pcie-frac 0.20 --kv int8 --max-context 131072 --vram-reserve-mib 2048` and **no
`--ram-keep-gib`**, i.e. the default `0` = "use the resident expert arena whenever it fits".

So the 52 GiB resident working set is the **expert arena occupying all the physical RAM it
can get**. The PLE table is not the problem: `--ple-io` defaults to `direct`, whose documented
behaviour is "the table never enters RAM or the file cache".

## Why this decides the Ruke budget question

The agreed Ruke budget is 4,000,000,000 B target / 5,000,000,000 B hard maximum for the Ruke
runtime plus its processing children, **excluding** the main LLM and the coding agent. Those
5 GB cannot be added on top of a 52 GiB resident model that has already taken the last of the
free RAM: the arithmetic only "fits" by paging. That is the tradeoff to report, not hide, and
it is why Ruke now has a resident-RAM admission gate (see D-048) rather than only a commit
ceiling.

## The lever that costs speed, not answers

From `strata.exe --help` (verbatim semantics, not my interpretation):

```
--ram-keep-gib W   RAM to leave free for your own work, in GiB (default 0; STRATA_RAM_KEEP_GIB
                   is the same).  The expert arena is used only if W GiB stay available after
                   it; otherwise the hottest experts are kept in a RAM copy that leaves
                   max(W, 8 GiB on Windows / 4 GiB elsewhere) free and the rest are read from
                   the files.  0 = the arena whenever it fits.
```

and for the placement family:

```
--resident-experts  the low-RAM PC's resident mode (setup): --mmap-experts
                    --resident-cpu-experts with the copy page-locked when possible, 4 GiB
                    headroom, plain mmap if it does not fit.  Same answers as --mmap-experts
                    for the same placement.
--mmap-experts      R2.1: opt OUT of the resident expert arena, back to MapViewOfFile.
                    The A/B arm: the mmap's rate depends on the OS page cache holding 34 GB,
                    and measured 71.97 vs 34.78 ms/token cold vs warm.
```

`--ram-keep-gib` is the smallest change that matches the user's complaint: it changes **where
experts live**, not their precision, not the quantisation pack, and not the model. Answers are
unchanged for a given placement; the cost is tokens/s in the cold case (the `--mmap-experts`
row above is the published cold-vs-warm measurement for that placement family: 71.97 vs
34.78 ms/token). A smaller pack (e.g. `orca-iq3_xxs`) would free more RAM but is a capability
change, so it is not offered as a "no quality loss" option here.

Concretely, adding `--ram-keep-gib 16` to the serve args should leave ~16 GiB free instead of
~3.7 GiB, which is what makes a ~2-3 GiB OCR/ASR worker possible without evicting the model.
**This was not applied**: it requires restarting Strata, which is the endpoint this coding
session and Ruke are both using, and the rules forbid unloading or reconfiguring the shared
model outside the coordination mechanism. A physical RAM upgrade remains the only change with
no speed cost at all.

## How to apply it deliberately (user action, not this session)

```powershell
# preview only (default): prints the exact JSON edit, changes nothing
powershell -NoProfile -File scripts\strata-low-ram.ps1

# write it for the NEXT launch (takes effect only after Strata is restarted by its own
# launcher; restarting Strata ends any active Ruke chat and any active Codex model session)
powershell -NoProfile -File scripts\strata-low-ram.ps1 -Apply -KeepGiB 16

# check whether the running engine matches the file
powershell -NoProfile -File scripts\strata-low-ram.ps1 -Verify
```

`-Apply` writes a timestamped `.bak` of the active config first, and only edits the `args`
array. Rollback: put the `.bak` back and restart Strata.

## Ruke-side compensations that ARE live now

1. The 5 GB aggregate ceiling is enforced with a Windows **job object** on the supervisor
   process tree (children inherit at create time) and a per-worker private job ceiling.
2. A **resident free-RAM admission gate** refuses a weight-loading worker before it can page
   the model: `memory_pressure`, retryable, with the numbers and what would change the answer.
   Native readers (pypdf/OOXML, measured 22 MiB peak commit) are not refused for RAM they do
   not use.
3. A heavy worker's commit ceiling is **clamped to free physical RAM minus the floor** (commit
   is always ≥ the resident set, so that clamp is a resident-RAM guarantee).
4. Idle heavy workers are unloaded under pressure, and a heavy worker is released **immediately
   after its job** when the host is under pressure. Cost: cold start. Never a quality cost.
5. Heavy workers are serialised (one at a time), pinned to one native BLAS/OpenMP thread, and
   `/health` reports `memory_ceiling`, `host_memory` (free physical and commit, with the
   definitions), `ceiling_evidence` and `pressure_releases`.
