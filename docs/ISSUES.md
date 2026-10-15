# ISSUES

## Confirmed and fixed
- Most languages rendered colorless: grammars embed others (cpp→regexp, vue→vue-directives,
  typst→tex…) and deps were never loaded; the first failure (cpp) left unresolved imports
  that made every later `loadLanguage` throw with an accumulated missing-list (python
  passed in isolation but failed in the 139-key run). Fixed: recursive `loadGrammarTree`
  + highlighter reset on any load failure. Do not rely on `embeddedLangsLazy` — those are
  deliberately not auto-loaded.
- Re-keying a grammar to its registry key (postgresql→sql, protobuf→proto, lean4→lean)
  must strip the new key from the old grammar's `aliases`, or Shiki throws
  "Circular alias X -> X" and the bad alias leaks into later loads (coq/docker failed
  with lean4/protobuf's errors).
- Mid-stream highlighting never painted: the `seq === highlightSeq` guard discarded every
  in-flight result while chunks kept arriving (seq advanced every 200ms; highlighting took
  longer). Fixed with monotonic `appliedSeq` — paint unless older than what already painted.
- Tree collapse left a 15.6px gap: Chrome floors a bare `0fr` track at the content's min
  contribution; `min-height:0` on the item does not lift the track's auto minimum. Use
  `minmax(0, 1fr)` → `minmax(0, 0fr)`.
- Model said "I can't hear the spoken narration" on uploaded videos. Root cause: the
  `video` case in `lib/server/extract/index.ts` never touched the audio track (only
  `videoFrames()`), and the `video` branch of `attachmentParts()` in `lib/chat/client.ts`
  ignored `transcript`. Fixed: videos get Whisper-transcribed audio when they have an
  audio stream, and the transcript rides into the prompt beside the frames. Proven by
  `__tests__/video-narration.test.ts` (narrated mp4 → transcript contains "zephyr").
  Note: narration is capped at `MAX_AUDIO_SECONDS` (180 s) like audio files.
- Scroll jitter during generation (view bounced top/bottom, "Jump to latest" appeared).
  Root cause: a smooth `scrollIntoView` per streamed chunk cancelled the previous animation
  and lagged growing content past the 120px threshold, flipping `hasScrolledUp` and
  oscillating. Fixed with an rAF-coalesced instant `scrollTop` pin + wheel-up disengage in
  `app/page.tsx`. Proven by `scripts/scroll-verify/check.mjs` (old FAIL / fixed PASS).
- Model said "I don't see any image attached" → attachments never reached the prompt.
  Fixed by the extract route + `attachmentParts()` in `lib/chat/client.ts`. Verified by
  106 headed model turns.
- `Unsupported file type: fixture-dockerfile / fixture-makefile` — **fixture naming bug**,
  not a classifier bug. Fixtures are now `fixture.Dockerfile` / `fixture.Makefile`.
  Do not "fix" `classifyFile` for this; `NAME_CATEGORY` already handles bare names.
- Hand-written tar header was invalid (checksum summed with the field zeroed, and a 9-byte
  field overwrote the typeflag at byte 156). Fixed: space-fill 148..156 before summing,
  write `padStart(6,"0") + "\0 "`.
- Nested archives lost their members → `flattenMembers()` in `lib/server/extract/archives.ts`.
  Bare `.bz2`/`.xz` streams store no filenames → `nameBareStream()` recovers the inner name
  from the uploaded file name.

## Dead ends — do not retry
- Playwright `route.fulfill` delivers the whole SSE body in one chunk — the message flips
  to "complete" before async highlighting can paint. Mid-stream tests need a real paced
  http server + `route.continue({ url })`.
- `getComputedStyle().gridTemplateRows` always reports used px — asserting `"0fr"` can
  never match; assert `"0px"`.
- `7za a -tbz2` → "Unsupported archive type" (7za reads bz2, cannot write it). Use `bzip2`.
- `drawtext` with `fontfile=` before `textfile=` → "Both text and text file provided".
- `System.Speech...SetWavOutputFile` → method not found. Use COM `SAPI.SpFileStream` +
  `SAPI.SpVoice`; do not set `Format.Type`, do not call `.Dispose()`.
- `scale=min(1280,iw):-2` unescaped → "No such filter: 'iw):-2'". The comma needs `\,`.
- ICO via png codec → "PNG in ico requires pixel format to be rgba"; `-update 1` produced a
  4-byte file. Use `-vf scale=256:256,format=rgba`.
- `execSync("pdftotext …")` depended on PATH. Use `unpdf`.
- `require("7zip-bin")` under ESM → use `await import("7zip-bin")` + `.default?.path7za`.
- Relative `node_modules/ffmpeg-static/ffmpeg.exe` paths break when the shell cwd drifts —
  always absolute.
- Playwright `fill()` on the controlled hero textarea reports success but React state never
  syncs → Enter early-returns and the DOM value reverts. Use `pressSequentially` instead.
- `[aria-label="Send message"]` exists only on the unused `HeroComposer`; `ChatInput`'s send
  button is `[data-testid="send-button"]`.

## Untestable by construction
- `.rar` (no writer exists), `.heic`/`.heif` (bundled ffmpeg has no HEIF encoder or demuxer).
  The app still routes them; the failure surfaces on the attachment chip.

## Environment notes
- The dev server dies with the shell that started it — restart `npm run dev` and wait for
  `Ready` before running the suite, or every Layer 2 test fails with `ERR_CONNECTION_REFUSED`.
- Next dev server hot-reloads route/server modules; no restart needed for `lib/**` edits.
- Playwright `--headed` works because no project pins `headless` in `playwright.config.ts`.
