# F78 — file-reading release (2026-11-21/22)

**Objective (frozen brief):** finish the file-reading release on branch `local`: reproduce every
audit defect against current code, fix, verify; freeze the extension inventory + acceptance matrix;
final gates + exclusive Playwright; end with one PASS/FAIL/BLOCKED table.

**Identity at start:** branch `local`, HEAD **3295f43**, `git status --porcelain` clean (audit
baseline = this commit). Audit workspace:
`C:\Users\Ruku\Documents\Codex\2026-11-13\few-issues-in-the-screenshot-even\work` — fixtures
COPIED project-relative to **`docs/overnight/fixtures/f78/`** (all-readers/, native/, review-docs/,
review-complex-1121/ incl. README.md acceptance spec). Scratch counter: next free **g102** (g81–g89 used: g81 baseline, g82/g87 law probes, g83–g86 fix probes, g89 structural ground truth; g90–g95 Family E; g96 = Family E delivery/RAM evidence; g97 = mat at job boundary; g98 = Family G baseline reproduction; g99 = Family G verification/RAM; g100 = frozen-matrix pass; g100xlsm = xlsm index probe; g101 = xlsm att-id repro).
Live law from F77 unchanged: :3000/:3101/:8080 reuse-never-kill; every dispatch pins
`RUKE_LLM_AUTOMATIC_HANDOFF=0 RUKE_OCR_ALLOW_UNLOAD=0`; exclusive Playwright via
`scripts/run-browser-e2e-exclusive.ps1` (forward-slash test paths).

## Frozen acceptance matrix (baseline 111 extensions + Dockerfile, Makefile, .env)

Inventory authority = `lib/files/extensions.ts` EXT_CATEGORY (111 keys) + NAME_CATEGORY
(Dockerfile, Makefile, .env) + ACCEPT_EXTENSIONS. Aliases covered by fixtures: .cc (→text),
.avi (→video), .tif/.tiff (→image), compound .tar.xz/.tar.bz2/.tgz (→archive), .htm, .kt/kts,
.gql/graphql, .m. Images carry color-frame assertions; media carries ASR/OCR marker assertions.

Matrix rows below; one row per family + per live-browser proof. Statuses: PASS / FAIL / BLOCKED.

## Family status table

| # | Family | Repro (fixture) | Baseline actual | Production path | Fix location | Test command | Outcome |
|---|---|---|---|---|---|---|---|
| A | BOM text → MP3 | all-readers sample.{csv,md,ts,…} large:true (FF FE, >48000 B) | ffmpeg "Invalid data" — sniffed strong-audio | lib/server/extract/sniff.ts:66 `FF Fx` = MP3 | sniff.ts + encoding.ts shared BOM table | `npx vitest run __tests__/server/extract-bom-text.test.ts` | **PASS 2026-11-21** — detectBom (longest-first) exported from encoding.ts, shared by decodeText + sniff; sniff nulls BOM'd heads; MP3 = full frame validation (mp3FrameSync: version/layer/bitrate/freq + next-frame sync at computed stride); sniff head 64→2048 B (index.ts). 8/8 new + 14/14 neighbours (extract-encoding, extract-identity). New fixture all-readers/untagged.mp3 (ffmpeg libmp3lame 128k, FF FB 90 C0, genuine untagged) keeps strong-audio law |
| B | images | panel.gif/webp 2-frame, panel.tif/tiff 2-page, reference.heic/heif | ffmpeg gif pages blank-centre (no disposal), webp "image data not found" 0 pages, tiff page-1-only, heic/heif "moov atom not found" → 422 | docProcessor encodeImage + ffmpeg.ts image path | ffmpeg.ts (sharp→wasm-HEIF→ffmpeg chain) + docProcessor ANIMATED_CONTAINERS | `npx vitest run __tests__/server/extract-images-pages.test.ts` | **PASS 2026-11-21** — g79 probe measured all four ffmpeg defects with exact production args. Fix: libvips (`sharp`, vendored vips 8.18.7) decodes animated gif/webp + multi-page tiff per-page via `{page:i}` with correct composited pixels; HEVC HEIC/HEIF via wasm libheif (`heic-decode` 2.1.0 — vendored libheif lacks libde265; its `decode.all()` yields LAZY handles, pixels only after per-image `handle.decode()`, array has `dispose()`; reading `.data` directly = undefined = the swallowed-null root cause); ffmpeg remains fallback (ico). Client: ANIMATED_CONTAINERS route gif/webp/apng/avif straight to server (createImageBitmap decodes frame 1 only). Page colours asserted at g80-locked fixture positions (page1 RED TL / BLUE BR, page2 swapped); `at` = 1-based page ids; 8-page cap visible; single-frame inputs get no fake frames. 10/10 new + 2/2 extract-image-ffmpeg (I07) + 18/18 neighbours (identity, frame-labels, token-image-cost, hardening-payload) + tsc 0. tsconfig: docs/overnight/fixtures excluded (fixture .ts is data); types/heic-decode.d.ts added |
| C | RAR | all-readers audit.rar (3 members) | 422 "File read error"; direct extraction yields all | lib/server/extract/sniff→archives.ts extractRar | archives.ts extractRar | `npx vitest run __tests__/server/extract-archives.test.ts` | **PASS 2026-11-21** — root cause: getFileList().fileHeaders is a lazy generator over the archive stream; the old per-member extract() loop opened a 2nd RarArchive on the SAME data-seek cursor → two readers raced one file position → ERAR_EREAD "File read error". Headers carry name+flags.directory (code read fileName/directory = undefined). Fix: drain header list fully (closes list archive), ONE extract() pass, read Uint8Array extraction directly, backslash→slash names. 8/8 new (all 3 members 66719/45103/918, nested paths, duplicate basenames, UTF-8, truncated→partial+ledger, zip/tar/tgz/7z/gz, .tar.xz/.bz2 compound controls) + 23 neighbours (archive-coverage, zip) green |
| D | Office | sample.pptx (61 litres/83/42), sample.ods (Cash/Debt, 9 chars), sample.odp (Intake/Return), review-docs/*, book.xlsx (Ledger2 D799=1596, Ledger5 D799=3990), smoke.doc/xls/ppt, simple.doc/SampleShow.ppt/solver.xls | pptx missing 61/83/42; ods 9 chars; odp missing Intake/Return; mat string-fallback; legacy = printable strings | python-backend/ruke_ml/documents/parser.py + merge/index | parser.py + opendoc.py + legacy.py + render.py + lib/server/extract/index.ts (legacy branch capability-first) | `-m unittest tests.test_f78_office tests.test_retrieval_documents tests.test_document_render tests.test_handoff_devices` (py, from python-backend) + `npx vitest run __tests__/server/extract-legacy-capability.test.ts __tests__/documents/artifact-reopen-parity.test.ts` | **PASS 2026-11-21** — DOCX tracked deletions kept inline ("[deleted revision: 910 seats]" beside "307 seats") + footnotes/headers (side parts) + OMML linearized "(u+7)/(v-4)" with disclosure; PPTX p:sldIdLst display order (FULL-resolution law: any unresolvable r:id → full filename order + disclosed note, ho-slides proves the silent-move trap), speaker note 61 litres lands on display slide 3, chart CACHED values "East=83, West=42" cited at slide 3; XLSX/ODS sheet identity + formula+cached (Cash!D41=89, E41=178 of:=[.D41]*2, Debt!A1=12; book.xlsx D799=1596/3990 pair intact); ODT body+lists, ODP named pages + presenter notes (gate 76/52), EPUB spine reading order (Arrival→Calibration), RTF visible-only (Café/42, hidden \v 918 excluded + declared); legacy real parsers replace byte-scan: Word97 piece table (simple.doc "Word 97-SR2"), PPT atoms (SampleShow + basic_test measured 5/3, empty [4,5], complete=false), BIFF8 SST/RK (solver.xls 7 sheets, Quick Tour B18=40), MAT v4 column-major exact values (12.25/98.75/63.5/440.125); malformed OLE (smoke.*) + non-zip package claims are TYPED refusals ("malformed legacy binary", "not a readable X package"), byte-scan demoted to labeled fallback; TS legacy branch capability-first (mergeOfficeText bypassed by law: byte-scan junk is not a comparable reader body — it would register as lostTokens and permanently protect the weaker reader). Evidence: g82+g87 probes TOTAL FAILS: 0; g89 structural dump; NEW tests: test_f78_office 18 + extract-legacy-capability 5 + parity law update; full gates: py 557 OK (discover -s tests -t .; bare `discover -s tests` breaks test_handoff_devices relative import — invocation artifact), vitest 2592/25 skipped, tsc 0, cargo 740/0 x3 (fixed flaky admission.rs age test: 1s window sat on the whole-second floor-difference quantum of record_age_secs, load flips it; window 3s/sleep 3.5s keeps the law, adds 2s margin), contracts:check OK |
| E | PDF | review-complex-1121 mixed.pdf p92 (4,18,25,000 rupees scan), mixed-tagged.pdf, plot-a/plot-b.pdf (bars 98/31 vs 31/98) | untagged p92 skipped; chart Qs answered from text not pixels | pdf.ts + python pdf.py OCR cascade + retrieval routing | per-page OCR decision + visual routing | `-m unittest tests.test_f78_pdf tests.test_ocr_fallback` (py, from python-backend) + `npx vitest run __tests__/server/extract-pdf-visual.test.ts __tests__/server/extract-document-capability.test.ts __tests__/server/extract-legacy-capability.test.ts` | **PASS 2026-11-22** — (1) language law extended: explicit payload → "requested"; /Lang → "declared by the document (/Lang)"; else VALIDATED detection = tesseract OSD script (conf ≥ 2.0, measured) → general SCRIPT_TO_TESSERACT map → pack addressable → verification OCR pass (lines≥2, mean conf≥0.60, glyphs≥80, words≥12 — all measured on this host); verified → cascade runs, `language_source="detected: …"`, report exposes `language_detection`; ANY failure keeps the typed needs_language refusal with BOTH reasons ("never defaulted to English" + detection refusal reason). (2) chart routing: pdf.py counts PAINT OPS per page (rect fills < 0.8·MediaBox + Bezier curves; background/clip excluded — plot-a ops==2 = the two bars exactly) → meta `pages_with_visual`; `_visual_pages` renders flagged pages (dpi 150, caps 12 pages / 400 KB page / 1.5 MB total, ranked ops desc, page-ordered) → payload `visual_pages` → TS `visualPages` → cap-ready pdf branch ships `frames [{dataUrl, at:page}]` ONLY when non-empty. Real-engine E2E: mixed.pdf p92 delivers "4,18,25,000" through the real job with detected eng, engine named. Engine reality: PaddleOCR primary refused by the resource window ("commit ceiling 5000000000 B under the 6264193024 B this worker needs"; provisional demand basis) → tesseract v5.5.3 recovery is this host's production path; PaddleOCR live delivery = open gate. Evidence: g90/g95 probes; NEW test_f78_pdf **23 OK** + test_ocr_fallback **21 OK** (F74 refusal test rewritten to the two-half law) + extract-pdf-visual **4 OK** + capability **51 OK** + legacy **5 OK**; tsc 0 |
| F | notebook/mat | native/exact.ipynb (9007199254740993), all-readers sample.mat (440.125, 98.75) | ipynb missing exact_id (JSON float64 coercion); mat missing values | lib/server/extract/notebook.ts; python mat reader | notebook.ts keep-raw tokens; parser mat (Family D) | `npx vitest run __tests__/server/extract-notebook.test.ts` + probe g97 | **PASS 2026-11-22** — reproduced: JSON.parse rounds 9007199254740993→9007199254740992 before the reader sees it. Fix: string-aware scanner replaces number literals the double cannot carry (big ints, 1e3 exponents, 1e400, -0) with per-parse-nonce placeholders; after render they are restored to the file's EXACT literal (quoted inside stringified JSON payloads, bare for template insertions like execution_count); code cell sources are string content, never touched; placeholders can't leak (nonce + restore check); notebook code is never executed — stored stdout 0.72 vs source 0.81 shown unreconciled (results.ipynb key). mat: Family D mat-numeric reader verified at the real job boundary (g97: 440.125/98.75/12.25/63.5 all delivered, method mat-numeric). 16/16 notebook tests incl. production-path rows for exact.ipynb + results.ipynb (KeyError amber_partition, fold 7, recall 0.639, 4116-char base64 LABELLED not decoded) |
| G | long video/audio | three-hours.mp4 (COBALT VALVE @01:31:00; PAUSE 793 6381–6383 s), sound.wav (3/61/119 s), overlap.wav stereo | exact-time Q returned only 00:36/2:06 previews; sound times omitted; stereo overlap merged | timeline index + retrieval lead-in + audio.ts ASR | ffmpeg.ts (channel probe/decode) + extract/index.ts (timed/channels/spread) + attachindex/turn.ts (frames-only time_range branch) | `npx vitest run __tests__/server/extract-media-delivery.test.ts` + probe g99 (resources) | **PASS 2026-11-22** — all four defects (g98 baseline) fixed at the production boundary: timed `[HH:MM:SS - HH:MM:SS]` lines on every short audio/video transcript; per-channel decode+ASR with `[channel k]` labels and explicit "carry speech simultaneously" overlap law; frames-only time_range delivery serves the nearest saved moments with requested-vs-sampled attribution (01:31:00 exact; 01:46:21 → 01:47:00 distance-honest; comparative pair both attributed) + unconfirmable-between law; short-video keyframes spread inline (≥15 s, cap 6) before dir cleanup. Two in-flight defects caught by the regression: ffmpeg-static PCM probe prints "2 channels" not "stereo" (numeric parse added); router clips cue windows at t=0 → cue un-clipped from the clipped edge. 6/6 regression (real ffmpeg+whisper, no mocks) + 232 neighbor tests green. On-demand exact-second decode = OPEN GATE (no source retention). Live-browser video row: root-caused 2026-11-22 to the Rust mirror gap (ruke-attach turn.rs lacked the frames branch; mirrored + unit test, 88/0) — live-certified 2026-11-22 run 3: "COBALT VALVE" in the live reply (14.5 s), see Live-UI section |

## Detailed per-fixture checklist

Model-free rows: expected facts from `all-readers/plan.json` + `native-plan.json` +
`review-docs/*.answer.json` + `review-complex-1121/*.target.json` + README.md ground truth.
Live rows: exclusive Playwright, one browser question per distinct production reader with an
independently known answer + source location.

(append per-family run logs under docs/overnight/logs/f78-*.log)

### Family E baseline (2026-11-21, probe .data/tmp/g90.py, python-backend/.venv -I)

Production python path (`parser.load_document` + `ocr.assess` + `_ocr_language` law + engine status):

| Fixture | Baseline actual (measured) | Ground truth (README.md + target.json) |
|---|---|---|
| mixed.pdf (141 p) | p92 in `units_needing_ocr`, `pages_with_images={92:1}`; NO `/Lang` → language law `('','none')` → typed needs_language refusal, page skipped; 20 blank units honestly recorded uncovered | p92 scan = "4,18,25,000 rupees" (Indian grouping), award 14 Nov 2021, ninety days, 6% interest; locator = PDF page index (printed labels unreliable) |
| mixed-tagged.pdf | identical coverage, `/Lang='en-US'` → OCR path available (audit run: tesseract v5.5.3 read p92) | same facts must reach chat with page attribution |
| plot-a.pdf / plot-b.pdf | 1 page; blocks = "Reservoir measurements \| West East"; `assess` → **layout_model**, units escalated = [] (raster-only view: `pages_with_images={}`); pypdf `get_contents()` = **0 bytes** (bars not in page content stream — locate before visual-flag design) | bars 98/31 px (A) vs 31/98 (B); answer West/East with page attribution; route chart Qs to VISUAL page evidence |
| engines | tesseract project-local v5.5.3 **languages eng + osd** (validated detection feasible); rasterizer pypdfium2 5.6.0; Paddle primary = paddleocr-vl-1.6 CPU-pinned (blockers: read full status_report) | README: "Primary PaddleOCR, a real low-memory Strata swap and representative three-hour lecture accuracy remain open" |

Fix design (Family E): (1) VALIDATED language detection when no explicit/declared language: tesseract OSD on the flagged page raster → candidate, then verification OCR (confident non-garbage) before use; record `language_source="detected"` + confidence; failure keeps the typed refusal + unresolved coverage exposure. (2) content-derived per-page **visual-content flag** (vector paint ops incl. Form XObjects) → page-image on-demand evidence through the existing `frames`/`at`=page channel → model answers chart questions with page attribution. NO fixture names / marker words / phrase matchers in production.

### Family E run log (2026-11-21/22)

Probes: g90 baseline (g91–g94 design probes: plot walk, rects/raster/readiness, OSD format, verification numbers — g92 facts settled, do not re-run); g95 new-code ground truth; g96 delivery + RAM.
g96 (real dispatches, pins `RUKE_LLM_AUTOMATIC_HANDOFF=0 RUKE_OCR_ALLOW_UNLOAD=0`, fixtures under -I):
- plot-a/plot-b: `visual_pages n=1 pages=[1] ops=[2] b64len≈24.7 KB` + visual_note — chart evidence ships through the production job; OCR correctly not run (no scan units).
- mixed.pdf (no /Lang): `ran=True language='eng' source="detected: the engine's script analysis of page 92 (latin), validated by a verification OCR pass"`, `language_detection verified=True conf=0.9636 glyphs=142 words=28`, page 92 `recognised engine='tesseract v5.5.3.20260724'`, fact "4,18,25,000" in delivered document: **True**, coverage 141/121.
- mixed-tagged.pdf: `source='declared by the document (/Lang)'`, ran=True, p92 recognised, fact True — declared path never detects.
- Engine reality (both PDFs, verbatim): paddle primary "refusing to spawn: the normal window can offer a commit ceiling of 5000000000 B (4768 MiB), under the 6264193024 B this worker needs (5190451200 B charged demand + 1024 MiB margin; demand basis: provisional: pinned weight bytes 1966 MiB + paddle runtime and activation allowance; NOT yet a measured cold-load peak)" → typed resource_limit → tesseract recovery ran. PaddleOCR live delivery = open gate.
- RAM: peak RSS of the dispatching worker across the full mixed E2E = **43.9 MiB** (tasklist 0.5 s poll); tesseract children are short-lived and admission-bounded (staged resource window). Well under the 4 GB target.

Changed files: `python-backend/ruke_ml/documents/pdf.py` (paint-op flag), `ocr_tesseract.py` (OSD+verification), `workers/document_jobs.py` (detection block, `_visual_pages`, payload keys), `lib/server/extract/document-capability.ts` (visualPages), `lib/server/extract/index.ts` (frames branch); tests: NEW `tests/test_f78_pdf.py` 23 OK, NEW `__tests__/server/extract-pdf-visual.test.ts` 4 OK, `test_ocr_fallback.py` refusal law rewritten to the two-half contract (21 OK), capability/legacy doc() literals updated (51+5 OK). tsc 0.

### Family F run log (2026-11-22)

Repro (raw-text, pre-parse): `JSON.parse` rounds `9007199254740993`→`…992` before the notebook
reader sees the file — recorded with `notebookText` on RAW JSON (a stringify-built test hides the
defect, so the test file writes raw literals).
Fix: `lib/server/extract/notebook.ts` — string-aware scanner `protectNumberLiterals` replaces
number literals the IEEE-754 double cannot carry (integers beyond 2^53, exponent tokens like
`1e3`, overflow `1e400`, `-0`) with per-parse-nonce placeholders (`\u0001<nonce>:<i>\u0001`);
`restoreNumberLiterals` runs two passes (quoted inside JSON-string payloads, bare for template
insertions like `execution_count`) restoring the file's EXACT literal; code cell sources are
string content, never scanned; nonce + leak check proven in tests; notebook code is never
executed — stored stdout `0.72` vs source `0.81` shown unreconciled (results.ipynb key).
mat: `mat-numeric` reader verified at the REAL job boundary (probe `.data/tmp/g97.py`,
`runner.dispatch` documents.parse): `state ok`, facts **440.125 / 98.75 / 12.25 / 63.5 all
delivered=True**, coverage `method="mat-numeric"`.
Tests: `__tests__/server/extract-notebook.test.ts` **16/16** incl. production-path rows
(`extractFileFromPath` on fixtures f78/all-readers/native/exact.ipynb + review-docs/results.ipynb).

### Family G baseline (2026-11-22, probe `.data/tmp/g98.test.ts` — green EXIT=0, wall 28.4 s)

Real production boundary (`extractFileFromPath` + `readIndex` + `buildAttachmentTurn`), pins
`RUKE_LLM_AUTOMATIC_HANDOFF=0 RUKE_OCR_ALLOW_UNLOAD=0`, `WHISPER_CPU_IDLE_MS=0`, live-provider
guard active. ALL FOUR defects reproduced against current code:

| Leg | Measured baseline | Ground truth (README) |
|---|---|---|
| (A) three-hours.mp4 | 8.7 s, indexed=true, **chunkCount=1** (frames-only: no audio track → coverage-note chunk + 90 keyframes, ats 60…10740). Frame at 5460 s (01:31:00) IS indexed; NO frame in [6375,6390] (PAUSE 793 @6381–6383), nearest 6420. Exact-time turn `buildAttachmentTurn("What is on screen at 01:31:00?")`: **injectedBlocks=0, imageParts=0, no system block** — the model receives ZERO video evidence for the question it was routed to answer | COBALT VALVE @01:31:00 answerable from the indexed frame; PAUSE 793 = honest between-samples refusal territory |
| (B) sound.wav (125 s) | indexed=false; facts Monday/Toronto/47 present; transcript carries **NO [HH:MM:SS] times** | 3/61/119 s with times preserved |
| (C) overlap.wav (20 s stereo) | mono-merged transcript byte-matches the audit baseline; **no channel attribution** (probe regex `L\b` matched "final" — spurious; the transcript plainly has none) | stereo channel-preserving |
| (D) mixed-av.mp4 (125 s) | inline frames ats=25, 87.5 only; transcript no times; **keyframes dir DELETED on the short path** (`framesDir` exists=false) | 61-s A/V alignment control ("47 kg" @61 s next to the ~60 s frame) |
| Resources | peak worker-tree RSS (node+ffmpeg+ffprobe+python+tesseract, tasklist 1 s poll) **2863.9 MiB** < 4 GB target; `.data/tmp` new residue: **(none)** | 4 GB target / 5 GB ceiling |

Root causes in current code: (A) frames-only index → the single coverage chunk never matches the
time_range window as text → `turn.ts:381 if (!ev.text) continue;` fires BEFORE `nearestFrames`
(:389); `frameAts` derive only from chunk `startSec` (retrieve.ts:170). (B/D) the three short
returns (`deliverSpoken` index.ts:257, audio TS path :677, video short :879) hand back merged
`asr.text`; ASR segments (which DO carry times, audio.ts `AsrSegment`) are consumed only on the
indexed path; video short path rmSyncs the keyframes dir (:878). (C) `decodeAudioPcmFile`
(ffmpeg.ts:536) forces `-ac 1`; no channel-preserving path exists.
Source-file retention: NONE (grep over attachindex/ + extract/ for `sourcePath|srcPath|retain`
= empty) → the README's "decode the requested instant on demand when source is retained"
condition is FALSE in production → bounded on-demand exact-second decode = recorded open gate,
not implemented dishonestly.

Fix design (four changes; generic time/number/channel laws only — NO fixture names, marker words,
topics or phrase matchers in production; mirrored byte-strings `rules()`/`FRAME_LEAD_IN`/coverage
marker untouched): (1) `timedTranscriptText(segments)` → `[HH:MM:SS - HH:MM:SS] text` lines
(same header form retrieve.ts:99 cites to the model) on all three short paths; (2) ffprobe
channel count + per-channel mono decode (`-af pan=mono|c0=cK`), sequential per-channel ASR
(RAM bounded as today), delivered as channel-labelled timed lines + explicit overlap
uncertainty note for time ranges where two channels speak simultaneously; (3) turn.ts: routed
time_range over a frames-only index → nearest frame to the window midpoint (FRAME_WINDOW_SEC 180
honesty: label requested time vs shown sampled time, unconfirmable-between law), then images
ride the normal path; (4) short-video keyframes merged into inline `frames` (dedupe by `at`,
capped) BEFORE the short-path dir removal.

### Family G run log (2026-11-22)

All four fixes shipped; regression `__tests__/server/extract-media-delivery.test.ts` **6/6 green**
(20.3 s) — REAL ffmpeg + REAL local whisper + real router/retrieve/buildAttachmentTurn on the real
f78 fixtures (no mocked responses; release law).

| Fix | Location | Verified fact |
|---|---|---|
| (1) timed transcripts | extract/index.ts `timedTranscriptText` (exported) wired into `deliverSpoken`, audio TS short path, video short path | sound.wav: "Monday" on a timed line with start ≤20 s, "47" 45–80 s, "Toronto" 100–125 s (fixture spec 3/61/119 s) |
| (2) stereo channels | ffmpeg.ts `parseAudioChannelCount`/`probeAudioChannels`/`decodeAudioPcmFileChannel`; index.ts `transcribeChannelsTs` (≤8 ch, sequential) + `composeChannelTranscript` (exported) | overlap.wav: `[channel 1]` + `[channel 2]` timed lines, "carries 2 separate audio channels" head, "channel 1 and channel 2 carry speech simultaneously between …"; Monday/47/Toronto all recovered |
| (3) frames-only time_range delivery | turn.ts: `coverageMarker`/`rankingMarker` extracted byte-identically (shared with passage path); new branch before `if (!ev.text) continue;` — per-cue `nearestFrames` + requested-vs-sampled attribution + unconfirmable-between law | "What is on screen at 01:31:00?" → block ≥1, images ≥1, "Asked time 01:31:00: … is at 01:31:00"; PAUSE cue → "Asked time 01:46:21 … 01:47:00" (nearest 6420, distance honest, never labeled as the asked second); comparative pair → both cue lines + ≥2 images; coverage "[coverage: 0 of 1 …; 2 of 90 saved keyframes shown …]" + ranking line intact |
| (4) inline keyframe spread | index.ts `spreadKeyframes` (greedy max-min-gap, ≥15 s, cap 6) merged into short-path `frames` BEFORE `fs.rmSync(framesDir)` | mixed-av.mp4: frames ⊇ {25, 87.5} spread ≥14 s, count ≥3; timed "47" line; `framesDir` gone (cleanup law preserved) |

Two defects caught BY the regression, fixed in-flight: (a) `parseAudioChannelCount` returned 0 on
PCM WAV because ffmpeg-static prints "**2 channels**", not a layout name — numeric `N channels`
form added; (b) the router CLIPS cue windows at t=0 (cue 45 s → window [0,225]) so window-midpoint
cue reconstruction mislabeled "Asked time 00:01:53" for a 00:00:45 ask — cue is now un-clipped
from the clipped edge (`cueAt` in turn.ts).
Neighbors: 22 files/232 tests (attach-*/audio-*/speech/video-asr-failure-coverage) green, 6 skipped
(live gates); tsc 0. Rust mirror: coverage/ranking/FRAME_LEAD_IN byte templates moved verbatim into
builders (attachment_replay goldens ride the full cargo gate). On-demand exact-second decode stays
an OPEN GATE (no source retention in production — see baseline).

Resource probe **g99** (production boundary, all four legs, asserts + tasklist worker poll): green
EXIT=0, wall 19.7 s. Facts: exact 01:31:00 → blocks=1 images=1 "…nearest 01:31:00 is at 01:31:00";
PAUSE 01:46:21 → "…is at 01:47:00" (distance-honest); comparative pair → both cue lines, images=2,
00:00:45 → 00:01:00; sound facts on timed lines; overlap `[channel 1]`/`[channel 2]` +
"simultaneously between" + all three facts; mixed-av frames ≥3 spread, timed "47", frames dir gone;
`.data/tmp` residue **(none)**. Peak worker-tree RSS **4029.2 MiB** — under the 5 GB ceiling; the
poll counts EVERY node process on the host (persistent :3000 dev server, :3101 ruke-server,
this agent's shell), so the worker-attributable delta over the g98 baseline (2863.9 MiB, same
method) is ~1.17 GB (whisper + ffmpeg) — within the 4 GB target. Probe artifact: g99's first run
failed on its OWN regex (mono lines start `[HH:MM:`, channel lines `[channel 1] [`); production
timed lines were present — probe fixed, rerun green.

### Family D run log (2026-11-21)

Probes: g82+g87 law probes TOTAL FAILS 0; g83–g86 fix probes; g89 structural dump.
New tests: `python-backend/tests/test_f78_office.py` 18 green; `__tests__/server/extract-legacy-capability.test.ts` 5 green; `artifact-reopen-parity.test.ts` chart-disclosure law updated.
Gates (post-Family-D, this segment): py `discover -s . -p "test_*.py" -t .` Ran **557 OK**; vitest **2592 passed / 25 skipped**; tsc **0 errors**; cargo `--no-fail-fast` **740 passed / 0 failed ×3** (flaky `admission.rs` age test fixed test-only: 1s window sat on `record_age_secs` whole-second floor quantum → window 3s + 3.5s sleep, law unchanged); `npm run contracts:check` OK.

### Family D baseline (2026-11-21, probe .data/tmp/g81.py, python-backend/.venv -I)

Production python reader (`parser.load_document` + `render.render_units`) on the fixtures:

| Fixture | Baseline actual (measured) | Ground truth (fixture-verified) missing |
|---|---|---|
| policy.docx | 1 unit, 466 chars; "307 seats" present | "910 seats" (w:del/w:delText lost), footnote "17 June 2031", header "Cedar group" |
| equation.docx | parsed; OMML probes "7"/"4" only via 47/73 substrings | (u+7)/(v-4) — m:t text never joined (OMML lost) |
| deck.pptx | 3 units 491 chars; "61" FOUND but on slide 2 (numeric slideN order) | sldIdLst display order (rId4,rId2,rId3 → slide3,1,2 ⇒ note 61 belongs at display slide 3); chart East=83 West=42 (chart1.xml caches) lost |
| structured.ods | kind "unsupported" (typed refusal) | Cash!D41=89 (row repeat 40), E41=178 formula of:=[.D41]*2, Debt!A1=12 |
| structured.odt | kind "unsupported" | note body "Temporary limit 37 bars.", 41 bars, Delta |
| structured.odp | kind "unsupported" | page Intake/Return order, notes gate 76/52 |
| manual.epub | kind "unsupported" | spine order z.xhtml (Arrival/red crate) then a.xhtml (Calibration/341 volts) — TS filename sort inverts |
| sample.rtf | kind "unsupported" (python); TS rtf visible-only | visible "Visible price 42."/"Café Nord."; \v hidden "PRIVATE ALTERNATE 918" must stay out |
| book.xlsx | rich (7 units, 19227 blocks, sheet identity "Ledger 1"…formula+cached) | probe artifact only: "Ledger2" misses because sheets are "Ledger 2" (space); D799=1596/3990 present |
| smoke.doc/.xls/.ppt | python unsupported; TS extractStrings recovers markers | malformed stubs (nfat=0, DIFAT zeros) — no valid FAT; byte-scan is the honest labeled path (release row for malformed inputs) |
| simple.doc | python unsupported | real OLE2: Word piece table → "This is a simple file created with Word 97-SR2." (prototype decode PROVEN) |
| SampleShow.ppt / basic_test_ppt_file.ppt | python unsupported | PPT atom walk (TextChars 0x0FA0 utf-16 / TextBytes 0x0FA8) → titles/bullets/notes (prototype PROVEN) |
| solver.xls | python unsupported | BIFF8 SST/LABELSST/NUMBER/RK → "Quick Tour of Microsoft Excel Solver" + labels (prototype PROVEN; RK double = HIGH 32 bits) |
| sample.mat (MAT v4) | python unsupported; TS byte-scan | name "yields", dims 2x2, doubles 12.25/98.75/63.5/440.125 (hex-decoded: [flags,m=2,n=2,imag,nameLen=7,'yields\0',4x f8]) |

Fix route (decided): parser.py becomes the content superset; `mergeOfficeText` promotion law carries it (TS office.ts unchanged); ODF/EPUB/RTF/legacy were python-"unsupported" so python adds the only real parser; legacy .doc/.xls/.ppt/.mat TS branch switches from byte-scan to capability body, byte-scan stays as labeled recovery for malformed containers (smoke.* row). Legacy OLE laws proven this session: header nfat@0x2C, DIFAT self-verify `fat[sid%(ssz/4)]==-3`, mini-stream when size<cutoff, piece FcCompressed `compressed=(raw>>30)&1; fc=(raw&0x3FFFFFFF)>>1`.

## Frozen-matrix complete pass (2026-11-22, probe `.data/tmp/g100.test.ts` + `.data/tmp/g100-pyreader.py`)

One complete pass of the frozen matrix: **119 rows** = plan.json manifest 112 (111 advertised
extensions + Dockerfile/Makefile/.env name aliases) + reference.heic/.heif (advertised, absent
from the manifest) + 5 native/ alias rows (bare Dockerfile, bare Makefile, exact.ipynb,
combined.tar.bz2, combined.tar.xz). Every row: valid fixture → real production extraction
boundary (`extractFileFromPath`, pins `RUKE_LLM_AUTOMATIC_HANDOFF=0 RUKE_OCR_ALLOW_UNLOAD=0`,
live-provider guard) → CONTENT assertion (fact bytes in text/transcript/index chunks, decoded
pixels + page/frame law for images). No upload badge, no mock: every row delivers recorded
fact bytes.

**Green run: EXIT=0, rows 119, failures 0, wall 56.3 s.** Peak worker-tree RSS **4823.4 MiB**
(tasklist node+ffmpeg+ffprobe+python+tesseract host-wide, 5120 MiB ceiling asserted); the
persistent :3000/:3101 baseline (2863.9 MiB, g98 method) leaves a worker-attributable delta
≈ **1959.5 MiB** — within the 4 GB target. `.data/tmp` residue **(none)**. Structured leg:
capability-gated rows (office/pdf/mat) ran through the production Python job entry
(`document_jobs.parse_job` = the worker's own entry: load_document → assess → OCR cascade) and
delivered every recorded fact.

Reader routing recorded honestly: text/rtf/notebook/archive/legacy-scan/image/audio/video facts
are certified at the TS boundary; office/pdf/mat facts at the capability job boundary (the probe
process cannot hold the per-run bridge secret — it lives in the running supervisor's environment;
recorded BLOCKED for probe-level HTTP, certified live by the exclusive Playwright rows).

Debug trail (runs 1–4 → 119/119) — three root-cause classes, all production findings:
1. **plan.json over-spec**: sample.pdf's "4,18,25,000" is the p92 SCAN fact of mixed.pdf (Family
   E OCR cascade, certified there); the tagged copy carries a text layer → matrix asserts its
   text facts ("Kestrel Basin Hydrological Survey", "approved on 8 August"). The .env alias
   fixture on disk is `native/.env` (ground truth retired=917/active=413); classification is by
   BASE name so location is irrelevant.
2. **xlsm production law**: the python capability answers the TYPED refusal "No parser is
   configured for .xlsm" (verified at the job boundary); production content is the TS OOXML
   worksheet scan, and facts beyond the 48000-char inline prompt cap (TEXT_CHAR_LIMIT) live ONLY
   in the async full-text index (263 chunks; "Mistral settlement" confirmed in index chunks,
   g101). The content assertion must read text+transcript+index after the write lands.
3. **att-id schema law**: `ATT_ID_RE = /^att_[a-z0-9]{4,32}$/` (extract/index.ts:113) — an
   att id with an underscore in the SUFFIX is rejected → `att=undefined` → indexing is silently
   disabled and oversized content is capped at 48000 chars with the tail lost. Probe ids
   `att_g100_75`-style tripped this; production upload ids are `att_` + [a-z0-9] and unaffected.
   Probe fixed to `att_g100n<i>`; g101 repro: valid id → indexed=true, 263 chunks, fact at t+0.

## Live-UI acceptance rows (exclusive Playwright, final)

Implemented as `tests/file-reading-f78.spec.ts` (5 live rows; row 6's laws
asserted inside row 1's journey): real picker upload → extraction chip
ready → real model reply → CONTENT assertion on the reply bytes. Run under
`scripts/run-browser-e2e-exclusive.ps1 -TestFiles 'tests/file-reading-f78.spec.ts'`
(atomic lock, reuse-never-kill on :3000/:3101/:8080, pins per brief).

**Run 1 (2026-11-22, exclusive launcher, 3 passed / 2 failed, lock released clean):**

| Row | Status | Evidence |
|---|---|---|
| picker/drop → upload → ready (BOM text large file) → FINAL-681 in reply | **PASS (content)** | reply preview "Thought for <1s … FINAL-681 …" — fact bytes in the completed reply |
| office complex (book.xlsx D799 pair) answer w/ 1596 + 3990 | **PASS** | both numbers in the reply (Ledger 2 / Ledger 5) |
| PDF mixed p92 fact through normal upload (OCR cascade) → 4,18,25,000 | **PASS** | digits 41825000 in the reply — full :3000→:3101→python OCR cascade live |
| notebook exact_id answer → 9007199254740993 | **PASS** | exact integer in the reply |
| video exact-time Q (three-hours.mp4 @01:31:00) → COBALT VALVE | **FAIL → root-caused, fix landed; live re-run pending ruke-server rebuild** | see Rust-mirror finding below |
| stage indicators clear / answer once / no retry text / scroll lock (inside row 1) | **law corrected → re-run** | run-1 assert "chip count 0" was a MISREAD of the F77 law: the chip PERSISTS by design (dismissable, click-to-close; browser-model-acceptance asserts it VISIBLE after a capped turn). True law: chip label flips off "Step N of M" (complete → "Done", turnProgress.ts snapshot) and "RUKE is driving" count 0. Spec updated to that law; content assertions untouched |

**Rust-mirror finding (row 5 root cause, 2026-11-22):**
- Pixel ground truth: ffmpeg-static `-ss 5460` on three-hours.mp4 → frame reads **COBALT VALVE** (.data/tmp/f78-frame-5460.jpg, viewed).
- The F78 frames-only time_range branch (turn.ts:449) exists ONLY in TS. The live UI chat runs on the Rust owner (:3101 ruke-attach) — turn.rs had `if ev.text.is_empty() { continue; }` with no frames branch, so the exact-time question delivered ZERO evidence and the model answered NO in ~1 s. g99 (TS probe) had passed because the probe calls the TS builder directly. **A TS-only fix does not ship the live law.**
- Fix: mirrored the branch into `rust-backend/crates/ruke-attach/src/turn.rs` (cue un-clip law, nearest_frames with FRAME_WINDOW honesty, requested-vs-sampled attribution, unconfirmable-between law, coverage + ranking honesty lines, rules). New unit test `frames_only_time_range_serves_the_nearest_saved_moment` — serve at 01:31:00, edge-clip cue labeled 00:00:45 (not midpoint 00:01:53), I18b refusal at 01:40:00 (nothing served). ruke-attach **88 passed / 0 failed**.
- **Outstanding check (exact):** the running :3101 binary predates the mirror (supervisor does the cargo build only at start; no hot-restart; reuse-never-kill leaves it alone). To certify row 5 live: restart the dev supervisor (`npm run dev` rebuilds Rust), then `scripts/run-browser-e2e-exclusive.ps1 -TestFiles "tests/file-reading-f78.spec.ts"`. Until then row 5 = BLOCKED for live UI (pixel truth + TS boundary + Rust unit test are green).

**Run 2 (2026-11-22, `-Grep "row [1-4]"`, exclusive launcher, 4 passed (1.5m), exit 0, lock released):**
rows 1–4 live-PASS with the corrected F77 laws — row 1 "YES FINAL-681" +
chip-label/driving/answer-once/no-retry/scroll laws (10.0 s); row 2 "Ledger 2 →
D799 = 1596 … Ledger 5 → D799 = 3990" (50.1 s); row 3 "4,18,25,000 rupees"
(22.4 s); row 4 "9007199254740993" (9.1 s). The launcher found no answering
:3000 (the interactive supervisor had stopped), so it started and stopped its
own supervisor tree (PID 20272) — reuse-never-kill untouched.

**Run 3 — FULL FROZEN-MATRIX LIVE PASS (2026-11-22, exclusive launcher, 5 passed
(2.3m), exit 0, lock released):** the launcher's startup `cargo build` compiled
the current source INCLUDING the Rust mirror, so row 5 certified live:

| Row | Status | Live reply evidence (from the model's completed reply) |
|---|---|---|
| 1 BOM text FINAL-681 + stage/answer-once/no-retry/scroll laws | **PASS** (10.0 s) | "YES FINAL-681"; chip label off "Step N of M"; driving 0; 1 reply; 0 errors; bottom-anchored |
| 2 book.xlsx D799 pair | **PASS** (50.1 s) | "Ledger 2 → D799 = 1596 — row 799 is 'Part 798' with Units 798 × Price 2, formula =B799*C79…" + 3990 |
| 3 mixed.pdf p92 OCR | **PASS** (56.4 s) | "4,18,25,000 rupees … exactly as printed on page 92 (the scanned page, read by OCR)" |
| 4 exact.ipynb exact_id | **PASS** (8.5 s) | "9007199254740993" |
| 5 three-hours.mp4 @01:31:00 | **PASS** (14.5 s) | "COBALT VALVE" — Rust-mirror frames branch served the exact-time evidence through the live UI |

All five mandatory live rows now carry passing content evidence. Row 5 is no
longer BLOCKED. Post-mirror workspace re-certification: cargo run4 = **741
passed / 0 failed** (27 suites, incl. ruke-attach 88 with the mirror test and
ruke-server attachment-replay/store-compat goldens), `.data/tmp/cargo-f78-run4.log`.
