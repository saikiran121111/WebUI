# fr-20261122a — Frozen answer key (file-reading real-world regression)

Frozen 2026-11-22 BEFORE any model reply was requested. This file is the
grading key and is NEVER fed to Ruke. Attachment-only questions: web search
must be OFF for every row marked [ATTACH]. Questions never contain the
answer. Held-out copies are uploaded under the neutral names in the
"Held-out upload names" table; questions reference them only as "the file".

Scoring layers per row: U=upload accepted, X=extraction/index (model-free
where probeable), R=retrieval (relevant content surfaced), A=final answer.
A row is PASS only if U,A pass; X,R failures are reported separately.

Tolerance classes: EXACT (verbatim string/number), NUM(±tol), SEMANTIC
(paraphrase of OCR'd/archaic wording allowed; entity + number must match),
VISUAL (answer readable at stated frame resolution; low-res frames:
entity/heading text only, not fine print).

## PDF

| # | Question [ATTACH] | Answer (key) | Source (exact) | Tolerance |
|---|---|---|---|---|
| P1 | SUPERSEDED 2026-11-22 (F73): "Figure 4.2 / 0 to 7 °C on p.16" is FALSE for this fixture — model-free census: "Figure 4.2" on NO page, "0 to 7" on NO page; p16 is a text page (the 7 is the B.2.4 rate, 7 % per °C). Retargeted: "On p.17, Figure SPM.5 precipitation colour-scale legend — what numeric range (with % sign)?" | `–40 % to 40 %` (per °C) | doc-a.pdf physical p17, Figure SPM.5 legend end ticks | EXACT (both end ticks + %) | Evidence: evidence-f73-spm-legend.txt |
| P2 | Per paragraph B.2.4, by what % does intense-tropical-cyclone intensity increase per 1°C of global warming? | about 7% | SPM p16 B.2.4 | EXACT 7% |
| P3 | In the 3949-page report, p.500: what is the estimated SMB growth rate in Antarctica 1800–2010? | 7.0 ± 0.1 Gt per decade | IPCC_AR6_WGI_Full_Report.pdf p500 (Thomas et al. 2017) | NUM ±0.1, must cite Gt/decade |
| P4 | In the full report's final page (glossary references), which 2021 AMS glossary is cited? | Glossary of Meteorology (AMS, 2021) | full report p3949 first reference | EXACT |
| P5 | Direction PDF: which month/year is on the cover? | March 2026 | college-accounts-direction-2025-26.pdf p1 | EXACT |
| P6 | Direction PDF p.18: what role signs the boxed block? | Accounting officer | p18 "[Signed] [Name to be typed] Accounting officer" | EXACT |
| P7 [mid] | mixed.pdf p.4 shows a rotated SQL statement — which column is selected and from what? | SELECT gauge_id FROM stations WHERE basin = 'kestrel' | mixed.pdf p4 rotated 270° | EXACT (gauge_id, kestrel) |
| P8 [end] | mixed.pdf p.7: on what date was the Kestrel weir closure approved? (distractor: footbridge) | 8 August | mixed.pdf p7 | EXACT date; mention footbridge = distractor fail |
| P9 UNANSWERABLE | "What is the name of the chief engineer who signed the Kestrel report?" | Refusal / not-in-file; any name = hallucination fail | not present in mixed.pdf | any concrete name fails |
| P10 OCR | d1_scanned.pdf body text (engine attribution graded separately: PaddleOCR vs Tesseract) | per d1 fixture expected text (docs/overnight/fixtures/d1/) | d1_scanned.pdf | SEMANTIC; engine recorded per row |
| P11 OCR | F78 AMBER.png/BASALT.png embedded-text rows (reuse F78 answer key) | docs/overnight/fixtures/f78/review-complex-1121 answer json | F78 fixtures | EXACT |

## DOC / DOCX

| # | Question | Answer | Source | Tolerance |
|---|---|---|---|---|
| D1 | footnotes.docx: what word appears ONLY in the footnote? | snoska | word/footnotes.xml | EXACT |
| D2 | endnotes.docx: what string is the endnote? | XXX | word/endnotes.xml | EXACT |
| D3 | FieldCodes.docx: what name+date does the field render? | ANTONI 16 June 2010 | word/document.xml (field result) | EXACT |
| D4 | tracked-changes.docx: what boiler number appears in the ACCEPTED text only (insertion)? | MERIDIAN-2298 (refurbished in 2026) | w:ins run | EXACT; 7741 here = fail (that is the deleted text) |
| D5 | tracked-changes.docx: which boiler number appears ONLY as a tracked deletion? | MERIDIAN-7741 (decommissioned) | w:delText run | EXACT; refusal/"none" = fail if reader shows revisions; acceptable per product law if it answers from accepted-only text — record which law the app implements |
| D6 | 45690.docm: quoted distance of Sgr A* with uncertainty? | 25900±1400 light-years (7940±420 pc) | docm body (Russian) | NUM ±0 on both; language-tolerant |
| D7 [end] | 45690.docm: final December 2008 refined mass figure? | 4.31 ± 0.06 million solar masses | docm body end | NUM exact pair |
| D8 UNANSWERABLE | "Who is the author of 45690.docm?" | not stated → refusal; any name fails | — | — |
| D9 macros | 45690.docm answers must come with macros DISABLED (content is in text, no execution) | U/A same as D6 | production law | record macro-disable evidence |
| D10 | Word95.doc / equation.doc legacy + equation rows (F78 policy/draft reuse where applicable) | F78 keys | f78 fixtures | EXACT |

## PPTX

| # | Question | Answer | Source | Tolerance |
|---|---|---|---|---|
| S1 | SEWP slides: how many Prime Contract Holders? | 137 | slide2 text | EXACT |
| S2 [mid] | SEWP: annual obligated value figure for FY25? | over $12.2 B | slide2 | EXACT 12.2 |
| S3 | scatter-chart.pptx native chart: series name + largest value? | series "Sales", max 8.2 (1st Qtr) | ppt/charts/chart1.xml xVal/yVal | EXACT |
| S4 | notes-only.pptx: marker visible on the slide? | SC-ALPHA-4460 | slide1 a:t | EXACT |
| S5 [notes] | notes-only.pptx: contingency code (speaker notes only)? | ZEBRA-9152 | notesSlide1 | EXACT; slide-only reader → refusal acceptable, record law |
| S6 UNANSWERABLE | "What date is the SEWP deck for?" | May 2026 is in the FILENAME only, not slide text → refusal from slide content; filename answer = fail | deck text | — |

## Spreadsheets — grade (sheet, cell, formula, value) tuples

| # | Question | Answer | Source | Tolerance |
|---|---|---|---|---|
| X1 | fcffsimpleginzu.xlsx: company name in Input sheet? | B4 = Almarai | sharedStrings via raw parse | EXACT |
| X2 | fcffsimpleginzu.xlsx: revenues value in the most-recent-12-months column? | B11 = 21765.4 | Input sheet | NUM ±0.1 |
| X3 | DfE ToC cell C3: formula + rendered value? | formula IF-style Welcome concat → "Welcome to the FY2026 Finance Record" | ToC C3 (formula '"Welcome to the "&Parameters!E3&" Finance Record"') | EXACT value; formula mention = bonus |
| X4 [mid] | DfE ToC A1: formula + value? | IF(SUM(A9:A19)=0, 0, 1) → 0 | ToC A1 | EXACT pair |
| X5 | DfE version marker cell? | H1 = F6.0 | ToC H1 | EXACT |
| X6 | capbudg.xls (legacy BIFF8): NPV cell value? | NPV = 47927.65 (R54C3; sheet CapBudgWS) | biff8 dump inspect-out/capbudg-cells.txt | NUM ±0.01 |
| X7 [end] | capbudg.xls: IRR? | ≈0.2355 (23.55%) (R55C3) | same | NUM ±0.001 |
| X8 | capbudg.xls: computed discount rate used? | 0.10685 (R11C11, formula result) | same | NUM ±0.0001 |
| X9 UNANSWERABLE | "fcff file: what is Almarai's share price?" | not in file → refusal; any number fails | — | — |
| X10 | Cross-sheet formula rows present in DfE workbook (sheet, cell, formula, value) tuples sampled from dump | dfe-cells.txt tuples | DfE dump | EXACT tuple |

## Notebooks (stored outputs only; uploaded code must NEVER execute)

| # | Question | Answer | Source | Tolerance |
|---|---|---|---|---|
| N1 | 02.02: shape/size/dtype of x3 printed in the stored output? | ndim 3, shape (3, 4, 5), size 60, int64 | stored stream cell 6 | EXACT tuple |
| N2 [mid] | 05.06: model slope and intercept in stored output? | 2.0272088103606953 / -4.998577085553204 | stored stream cell 8 | NUM ±1e-6 |
| N3 | 04.01: which matplotlib style is set in the code cell? | seaborn-whitegrid | cell 2 | EXACT |
| N4 UNANSWERABLE | "How long did the cells take to run?" | no execution timing stored → refusal; any timing fails | — | — |

## Archives

| # | Question | Answer | Source | Tolerance |
|---|---|---|---|---|
| A1 | nested.zip: content of deep/secret.txt (inner archive)? | NESTED-DEEP-FACT 33071 | inner.zip member | EXACT |
| A2 | nested.zip: what does dirB/notes.txt say about valve 12? | CLOSED (per evening log) | dirB/notes.txt | EXACT; "OPEN" = basename-collision fail |
| A3 | large-tail.zip: TAILFACT code near the end of the last member and the mail line? | TAILFACT-3Q8K; bug-hello@gnu.org | hello-README-tail.txt tail | EXACT both |
| A4 truncated.zip | upload → clear partial results naming readable members, or clean refusal; no hang/garbage | structural | derived/truncated.zip | law check |
| A5 encrypted.7z / encrypted.zip | clear refusal to prompt-for-nothing; name encrypted members; no hang | structural | derived/encrypted.* | law check |
| A6 7z2606-extra.7z (BCJ2-era real 7z) | list members incl. 7-zip.chm (127,444 B) | listing | dl/archive | EXACT size ±0 |
| A7 node-v22.20.0-headers.tar.gz member 127 (0-based) | node-v22.20.0/include/node/uv/win.h (Joyent copyright header) | tar list index 127 | tar.gz | EXACT path |
| A8 zip_sample_file_1MB.zip | member + size | filler.bin, 1,048,576 bytes | zip listing | EXACT |
| A9 RAR3 / RAR5 (testfile.rar3.rar, testfile.rar5.rar) | production reader rows (7za has no Rar codec → live row only) | app-dependent | live | record |
| A10 UNANSWERABLE | "What is the password of encrypted.zip?" | not in file → refusal; must NOT guess | — | — |

## Video — 3-hour gate fixture FCC (freeCodeCamp "Data Analysis with Python", 04:22:12) + CS50

Frame facts (VISUAL). CS50 low-res OK for slide text; FCC 426×240 → heading
text only. Beginning/middle/end separation is mandatory.

| # | Question | Answer | Source | Tolerance |
|---|---|---|---|---|
| V1 | CS50 first 3 minutes: what is the title slide text? | "Welcome to CS50" | frame @120s (frame @60s is black — begin-sample law) | EXACT |
| V2 [mid] | CS50 ~59m: phone-book pseudocode — what does line 7 say? | "Open to middle of left half of book" | frame @3568s (13 lines; line 13 "Quit") | EXACT |
| V3 [between-samples] | Between 3568s and 3700s the slide changes (ffmpeg scene @3625.75s). What question does the new slide pose? | "How do you search for a phone number?" ("Phone book example" slide) | frame @3626s, ffmpeg-verified | EXACT |
| V4 [end] | CS50 last minutes: the Scratch game's closing sentence says Harvard saved the world through a combination of raw talent and what? (word spelled with a typo on screen) | "will power"; screen spells "heirarchy" | frame @7100s | EXACT quote; typo preserved |
| V5 | FCC first 2 minutes: title card text? | "Data Analysis with Python" + "Full tutorial for beginners" — KEY CONFIRMED 2026-11-23 (F89): v2-60.jpg is exactly this card; the RMOTR promo the C3 model quoted is the CLOSING page (v2-15600.jpg, ~4h20m) → no key change, fr-V5 stays a product begin-window row (evidence-f89-key-verification.txt) | frame @60s | EXACT heading |
| V6 [mid ~2h11m] | FCC middle: notebook section heading visible? | "Conditional selection (boolean arrays)" | frame @7866s | EXACT heading |
| V7 [end] | FCC last minutes: large heading near the end? | "We're just getting started!" | frame @15700s | EXACT |
| V8 frame-only | A fact present in frames but NOT in any caption/ASR: e.g. V4 text. | per row | captions absent (no CC track) | VISUAL |
| V9 summary | 3-hour summary row: ask for a summary; must be consistent with the video's arc (title → notebooks → closing promo), no fabricated specific numbers | structural | whole file | SEMANTIC; invented timestamps = fail |

## Audio (Huck Finn LibriVox ch1-3; transcript = epub Gutenberg text; IA 1884 OCR fallback, SEMANTIC tolerance recorded)

| # | Question | Answer | Source | Tolerance |
|---|---|---|---|---|
| U1 | ch1 opening scene: what do the new clothes make the boy do? | sweat (sweat and sweat, cramped up) after the widow/dress-up scene | ch1 head ("LEARNING ABOUT MOSES AND THE BULRUSHERS" section) | SEMANTIC |
| U2 [late ~8:00] | ch1, around 8 minutes: what sound does the narrator imitate, and who is waiting? | cat-call "me-yow!" → Tom Sawyer is waiting | ch1 ~08:00; OCR line 111 | SEMANTIC; timing graded separately (±60s) |
| U3 [end] | ch2 ending: who is the first "captain", and who is second? | Tom Sawyer first captain; Jo Harper second | ch2 end | EXACT names |
| U4 [mid] | ch3 middle: the fictional caravan has a guard of how many soldiers? | four hundred | ch3 mid | NUM 400 (words OK) |
| U5 [late ~9:00] | ch3, late: the wish made the genie do what (what "kind of sweat")? | sweat "like an Injun" → "all that stuff was only just one of Tom Sawyer's lies" | ch3 late; 1884 OCR wording | SEMANTIC; offensive archaic term per 1884 edition — accept euphemistic paraphrase |
| U6 names | Proper nouns: name both boys in ch2 (captains). | Tom Sawyer, Jo Harper | ch2 | EXACT, with PREDECLARED tolerance (2026-11-22, F74(b)): ASR transcribes the name phonetically — "Jo Harper" accepted as "Joe Harper" (spelling-only, this row only; identity requirement unchanged) |
| U7 quiet/turns | F78 rows first/middle/last.wav, sound.wav, overlap.wav (content + timing graded separately) | F78 answer json | f78 fixtures | EXACT + timing tol |
| U8 UNANSWERABLE | "What street does the narrator's school live on?" | not in audio → refusal | — | — |

## Images

| # | Question | Answer | Source | Tolerance |
|---|---|---|---|---|
| I1 | multipage.tiff, page 2: inspection fact about spillway gate 4? | failed inspection on 12 May | frame 2 (rendered from mixed.pdf p2) | EXACT |
| I2 [frame-specific] | multipage.tiff page 2: actuator fluid logged at what percent? | 61 percent | frame 2 right column | NUM 61 |
| I3 animated (gif/webp): what appears in the LAST frame? | Jupyter notebook view (df.head() cells); NOT the "Reading from CSV" title slide from frame 1 | derived animated-from-lecture.{gif,webp} frames 23/10 | EXACT scene; frame-1 answer = fail |
| I4 C001.heic: pixel dimensions? | 1280×720 | HEIF ispe box (model-free) | EXACT |
| I5 cat-rot270.jpg: orientation as displayed after EXIF application | upright (reader must honour orientation; unrotated display = fail) | EXIF 270° | VISUAL |
| I6 | F78 image-page rows (AMBER/BASALT/COBALT png) | F78 key | f78 | EXACT |

## Text / code

| # | Question | Answer | Source | Tolerance |
|---|---|---|---|---|
| T1 [beyond first chunk] | hello README (utf16 copy): final sentence? | "GNU Hello is free software. See the file COPYING for copying conditions." | utf16-readme.txt tail | EXACT |
| T2 | utf32 copy: same tail survives decode? | same | utf32-readme.txt | EXACT |
| T3 | quoted-multiline.csv row 50, column b (has an embedded newline)? | "Average cost per FTE \n / £" (newline inside quotes) | quoted-multiline.csv | EXACT incl. newline |
| T4 [end] | quoted-multiline.csv last row id? | R-2a-1 (tail row) | CSV tail | EXACT |
| T5 | notebook-cells.jsonl final record marker and cells_total? | TAIL-9x7Z-JSONL, 68 | final JSONL record | EXACT pair |
| T6 | moby Dockerfile: GO_VERSION value? | 1.27.4 | line | EXACT |
| T7 | moby Dockerfile: XX version? | 1.10.0 | line | EXACT |
| T8 UNANSWERABLE | "Who committed the latest change to the Dockerfile?" | not in file → refusal | — | — |
| T9 threshold | TEXT_CHAR_LIMIT=48000 routing: a file just over 48000 chars must route to async full-text index, not inline truncation; just-under stays inline | structural (probe via F78 119-row matrix harness) | production law | record |
| T10 limit | Upload limit: production law has NO upload byte cap (recorded 2026-11-22). "Just over limit" case is N/A → report as production-law observation, not a failure. The 1MB/263MB uploads exercise the no-cap path. | — | lib/files law | observation |

## Negative rows (MUST NOT silently pass)

| # | Case | Expected |
|---|---|---|
| G1 | hello-fake.pdf — plain text content, .pdf extension | reader must refuse/flag as not a PDF; PDF-flavoured answer = FAIL |
| G2 | "  README  .txt" — whitespace-padded filename | padded name cannot pass: trim with report, or reject — silent normal-passthrough = FAIL |
| G3 | pg76 maintenance HTML stub (deleted from corpus) | signature law: HTML-as-.txt must be rejected at ingest (probe: raw stub upload in live batch copy kept in run dir, not Git) |
| G4 | renamed extension copy: multipage.tiff renamed .jpg | must be identified by magic, not extension |

## Held-out upload names (neutral, for live batch)

| fixture | upload name |
|---|---|
| IPCC_AR6_WGI_SPM.pdf | doc-a.pdf |
| IPCC_AR6_WGI_Full_Report.pdf | doc-b.pdf |
| mixed.pdf (F78) | report-m.pdf |
| d1_scanned.pdf | scan-1.pdf |
| tracked-changes.docx | notes-2.docx |
| 45690.docm | macro-1.docm |
| notes-only.pptx | deck-3.pptx |
| scatter-chart.pptx | deck-4.pptx |
| fcffsimpleginzu.xlsx | data-5.xlsx |
| DfE_Finance_Record_2026.xlsx | data-6.xlsx |
| capbudg.xls | data-7.xls |
| 02.02 / 05.06 / 04.01 ipynb | nb-1.ipynb / nb-2.ipynb / nb-3.ipynb |
| nested.zip / large-tail.zip / truncated.zip / encrypted.7z | pack-1.zip / pack-2.zip / pack-3.zip / pack-4.7z |
| lecture0-b-1080p.mp4 | vid-1.mp4 |
| fcc-data-analysis-4h22m.mp4 | vid-2.mp4 |
| huckfinn ch1/2/3 mp3 | au-1.mp3 / au-2.mp3 / au-3.mp3 |
| multipage.tiff / animated-* / C001.heic / cat-rot270.jpg | img-1..img-6 |
| utf16/utf32/quoted-multiline/notebook-cells/Dockerfile | txt-1..txt-5 |
| hello-fake.pdf / "  README  .txt" | neg-1.pdf / neg-2 (padded) |

Every scored row's key text was derived by direct model-free rendering/parsing
(inspect.py / biff8.py / ffmpeg / PIL dumps in the run dir, kept in
inspect-out/). No answer was produced by a language model.

---

## SUPPLEMENT v2 — fr-20261122b (appended 2026-11-22, original key above preserved verbatim)

Versioned supplement required by the resume directive: mandatory checks that
were missing from the original key. Ground truth is model-free: facts come
from `docs/overnight/fixtures/f78/all-readers/plan.json` expected arrays, the
d1 `answer-key.json`, the F78 `sound.wav.answer.json`, the raw OOXML dump
`inspect-out/dfe-cells.txt`, and direct fixture construction. Neutral staged
names in `dl/live` per the table at the end.

| ID | Fixture | Question to Ruke | Expected fact (location) | Law |
|----|---------|------------------|--------------------------|-----|
| S-Z0 | (no upload) | — | new conversation files appear ONLY under `.data/e2e-store` after the first chat | store isolation VERIFIED before state-changing rows |
| S-T7 | txt-7.txt (UTF-16, 105,664 chars > 48,000 inline limit) | "What is the END CODE at the very tail of this file?" | `WALRUS-BOUNDARY-9131` (final line) | >48k must route to full-text index and still answer late-file content |
| S-R1 | txt-6.rtf | "What price is quoted in this document?" | `Visible price 42` | RTF reader live answer. F74(c) PREDECLARED tolerance (2026-11-22): phrase requirement = the word "price" + the number 42; the adjective "Visible" is context, not required (spec already encodes this) |
| S-L1 | old-1.doc | "What marker text appears in this file?" | `READABLE-MARKER-DOC` | legacy .doc live answer |
| S-L2 | old-2.xls | same | `READABLE-MARKER-XLS` | legacy .xls live answer |
| S-L3 | old-3.ppt | same | `READABLE-MARKER-PPT` | legacy .ppt live answer |
| S-O1 | doc-b.odt | "How many bars, and what operation closes the document?" | `37 bars` + `Shutdown` | ODF text live answer |
| S-O2 | sheet-1.ods | "Name two line items and the number present." | `Cash`, `Debt`, `178` | ODF spreadsheet live answer |
| S-O3 | deck-5.odp | "Which two flows and which number appear?" | `Intake`, `Return`, `76` | ODF presentation live answer |
| S-O4 | book-1.epub | "What crate is inventoried and what voltage is cited?" | `Inventory the red crate` + `341 volts` | epub live answer |
| S-XM1 | data-8.xlsm | "Name two settlement/terminal phrases in the workbook." | `Mistral settlement` + `Heliotrope terminal` | xlsm live answer (no macro execution) |
| S-M1 | mat-1.mat | "What variable and the two numeric values are in this file?" | `yields`, `440.125`, `98.75` | .mat live answer |
| S-A6 | pack-5.gz (summary.csv.gz) | "What number appears in the member CSV?" | `66719` | gz member extraction live answer |
| S-A12 | pack-6.rar (audit.rar) | "List what you can read from this archive." | honest terminal behavior: explicit unsupported/failed state, NOT a silent ready/answer | missing-decoder law (record actual behavior) |
| S-N3 | nb-3.ipynb (04.01-Simple-Line-Plots) | "What plot style is set and what plot is produced?" | per key N3 (seaborn-whitegrid style from saved code) | code-vs-output check, no execution of uploaded code |
| S-N4 | nb-4.ipynb (exact.ipynb) | "What exact integer is stored in the notebook output?" | `9007199254740993` | exact-integer fidelity (F78 row4 law) |
| S-U7 | au-4.wav (F78 sound.wav) | "What weight is stated in the middle of the recording?" | `47 kg` ("The cargo weighs 47 kg.") | audio middle position, transcript ground truth |
| S-P11 | scan-2.pdf (d1_native) | "Which port's values appear in the page 3 table?" then follow-up "What amount and date appear on page 6?" | `Kandla` (18.4) p3; `4,18,25,000` rupees 14 Nov 2021 p6 | native-text PDF: text layer must answer; OCR must NOT run (engine attribution from app log) |
| S-P4 | doc-d.pdf (IPCC AR6 WGI Full Report, 242 MB) | "Which glossary does the report's Glossary chapter cite?" | `AMS Glossary of Meteorology` (2021), p3948 (page corrected 2026-11-22; text layer "AMS, 2021: Glossary of Meteorology…") | late-page fact in a 3970-page PDF (async full-text route). F79: row passes ONLY in hybrid (embedded) mode — lexical BM25 rank 203/13,965 is outside the 20-candidate lens; record meta.embed/embedNote per row at C3 (evidence-sp4-glossary-citation.txt) |
| S-P2 | doc-a.pdf (SPM) | "In section B.2.4, what is the stated rate per degree Celsius?" | ~`7 %/°C` (per degree warming) | chart/series-value question (2/3 chart battery) |
| S-P3 | doc-a.pdf (SPM) | "What is the glacier and ice-sheet mass loss (SMB) figure in Gt per decade?" | `7.0 ± 0.1 Gt/decade` | chart value+units question (3/3 chart battery) |
| S-P5 | doc-c.pdf (direction 2025-26) | ~~"Which month and year does the latest direction in this file cover?"~~ SUPERSEDED 2026-11-22 (F69): wording ambiguous — file's coverage period is literally "financial year ending 31 July 2026" (p3); "March 2026" occurs ONLY on the cover. Harness now asks the P5 cover wording (key row P5). See evidence-f69-page-month-map.txt | `March 2026` (cover, p1 — only occurrence) | key-vs-fixture defect, not retrieval |
| S-D2 | doc-f.docx (endnotes.docx) | "What string is the endnote in this document?" | `XXX` (word/endnotes.xml; body text is Russian, XXX is endnote-only) | endnote vs body |
| S-D3 | doc-g.docx (FieldCodes.docx) | "Which name and date does the document's field render?" | `ANTONI` + `16 June 2010` (field result in word/document.xml) | field-code result |
| S-D4 | notes-2.docx (tracked) | "Which boiler number appears in the ACCEPTED text as an insertion (refurbished 2026)?" | `MERIDIAN-2298`; answering `7741` = FAIL (that is the deleted text) | insertion vs deletion |
| S-S1 | deck-1.pptx (SEWP) | "How many Prime Contract Holders does the deck state?" | `137` (slide 2) | slide-text fact |
| S-S2 | deck-1.pptx (SEWP) | "What annual obligated value for FY25 is stated?" | over `$12.2 B` (slide 2) | mid-file slide fact |
| S-S4 | deck-4.pptx (scatter) | "Which slide ID code appears in this deck?" | `SC-ALPHA-4460` (slide identity) | slide identity |
| S-X1 | data-5.xlsx (fcff) | "Which company is named in cell B4?" | `Almarai` | (sheet,cell,value) tuple |
| S-X4 | data-5.xlsx | ~~"What value is stored in A1?"~~ SUPERSEDED 2026-11-22 (F72): premise false — `A9:A19` occurs 0× in data-5.xlsx (raw-XML census); that formula is data-6.xlsx **ToC A1** (f=`IF(SUM(A9:A19)=0, 0, 1)` v=`0`, verified; the X4 [mid] row above is correct for THAT file). Harness now quotes a formula this file uniquely stores. See evidence-f72-first-layer.txt | `0` (Valuation output B10: `IF('Input sheet'!B61="Yes",'Input sheet'!B62,0)`, cached `0` — 1 occurrence in workbook; chunk 22 delivery + point_qa retrieval verified) | key-vs-fixture defect (F69/F73 family); stored formula result, absent-cached-vs-zero law preserved |
| S-X10 | data-6.xlsx (DfE) | "What value is stored in ToC!B1 and what formula produces it?" | `15` (`SUM(B9:B19)`, cross-range) | scored as (sheet,cell,value) tuple; scorer self-test feeds a swapped-sheet answer and must fail it |
| S-V1 | vid-1.mp4 (CS50) @2:00 | ~~"What greeting is spoken near the two-minute mark?"~~ SUPERSEDED 2026-11-23 (F89): premise FALSE — no frame near 2:00 carries text (v1-60.jpg black, v1-120.jpg building photo), and the pinned Parakeet run over 95–155 s transcripts NO "welcome" (the C3 live answer's own transcript agrees: 1:18–1:29 is "This is CS50, Harvard University's Introduction…"). Key-vs-fixture defect (S-P5/S-X4 family). See evidence-f89-key-verification.txt | `this class to beware` (spoken 115.1–116.5 s, word-timestamped: "CS50 in particular was very much this class to beware") | beginning (AUDIO channel — the 2:00 frames carry no text, so the row keeps testing speech); (V2 middle line7; V3 between-samples; V4 follow below) |
| S-V3 | vid-1.mp4 | "A slide asks a phone-number question around one hour in. Quote it." | `How do you search for a phone number?` (verified at 3625.75 s by ffmpeg frame extract; between sampled frames) | between-sampled-frame event |
| S-V4 | vid-1.mp4 | "Near the two-hour mark a slide shows a misspelled word and a self-control theme. Quote them." | `heirarchy` (typo) + `will power` (~7100 s, ffmpeg-verified) | late video fact |
| S-V6 | vid-2.mp4 (FCC 4h22m) | "What topic heading appears around 2h11m?" | `Conditional selection (boolean arrays)` (~7866 s, ffmpeg-verified) | middle-hour of 4h22m recording |
| S-V8 | vid-2.mp4 | "Name the visual-only fact shown on screen at 3h25m45s." | `Reading from CSV` (title card, visual-only) | visual-only fact |

Engine attribution: OCR rows record the engine that processed each page from
the app/supervisor log; PaddleOCR venv exists (`python-backend/.venv-ocr`,
paddle+paddleocr importable). If the log shows PaddleOCR did not run where
the d1 key requires it, that check is BLOCKED even if Tesseract succeeded.
