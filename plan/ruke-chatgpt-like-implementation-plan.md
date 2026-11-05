# Ruke implementation plan: reliable ChatGPT-like chat and browser experience

- **Status:** Proposed implementation plan. Publishing this document does not implement the features or establish benchmark results.
- **Repository / branch:** `saikiran121111/WebUI` / `develop`.
- **Published:** 6 November 2026, Asia/Kolkata.
- **Publication baseline:** `dcfb2c56cb2d0e54c893f402b74837ef01d9ebd3`.
- **Priority:** Interactive browser reliability and efficiency first; then worthwhile presentation, document, ingestion and chat UI improvements. Built-in 3D and CAD are removed from the target.
- **Web-search scope:** Preserve the current TypeScript web-search implementation and its latest evidence work. Do not migrate to SearXNG, restore Rust retrieval, replace search engines or restart the search architecture under this plan.

This document consolidates the conversation's final decisions and the source-backed recommendation into one repository-owned implementation brief. Its execution requirements and latest decisions supersede earlier exploratory suggestions in the conversation. The detailed 45-area review and primary-source references follow the implementation phases.

**Latest scope decision — 6 November 2026:** Retire built-in 3D creation, AI asset generation, 3D viewing/editing and CAD/BIM features from the core product. The inspected CAD implementation is a floor-plan/preview system; no AutoCAD-level architecture-design capability has been demonstrated, so it does not pass the user's retention condition. Defer Blender to a future external MCP integration. This revision updates the implementation plan only; feature removal in application code is pending. Retained browser tasks may still inspect graphical/3D websites—this decision concerns Ruke's own modeling studios.

## 1. Product outcome and constraints

Build a familiar, responsive chat UI in which the model understands the conversation, has working tools, can operate a real browser when needed, produces useful editable artifacts and reports what actually happened. “ChatGPT-like” describes the intended user experience and demonstrated workflows. It is not a promise to reproduce OpenAI's private implementation or obtain identical intelligence from a smaller local model.

### Required baseline

- Support maintained versions of Windows, macOS and Linux using native packages and correct process/filesystem behavior. Cover Intel/AMD and Apple Silicon builds where dependencies support them.
- Target ordinary laptops with **16 GB total RAM, an i5-class CPU or comparable Apple Silicon, and no dedicated graphics card**. Supported integrated graphics may be used for browser/WebGL previews.
- Keep the selected core stack local or self-hosted, with no required subscription, paid model endpoint, trial expiry or vendor request quota. Pin software/model versions and retain licenses. Hardware, power, storage and standard open-source obligations remain.
- **Exclude TRELLIS and other GPU-dependent 3D generators.** Exclude Meshy or another paid asset API as a requirement of the target implementation.
- Avoid website/company-specific routing patches. Domain resolution, page interaction and research-related browser behavior must work from the actual user request, current state and available evidence.
- Keep one controlling main model. Do not add a mandatory YES/NO search classifier, secondary local model, prompt-rewriting worker or separate agent framework merely to route every input.
- Preserve retained APIs, stored conversations, titles, attachments, settings, user/core skill separation, browser panel and existing artifacts during incremental changes. Retire only the explicitly scoped 3D/CAD features.
- Start optional Office/OCR workers on demand. Do not bundle or keep a CAD engine, Blender, 3D generation model or additional browser agent resident during normal chat.

### Intended chat behavior

- Ordinary conversation should remain ordinary conversation; internal date/time context should not become an unsolicited greeting or a repeated timestamp.
- The current date/time remains available for relevant temporal questions and freshness reasoning.
- The model chooses useful observations and tools. Provide capabilities and clear tool errors; do not restrict legitimate tasks with invented website lists or mandatory site-selection questions.
- User-entered website scope must survive clarification, navigation, redirects and follow-up turns. A location such as Hyderabad is not a website.
- Preserve the existing distinction between ordinary web research and interactive browser operation. Do not open an interactive browser as a substitute for normal crawling/searching by default.
- On a login-dependent task, offer the real browser handoff, let the human sign in, accept their resume/confirmation action in chat or the panel, and then **verify the resulting page state**. A “logged in” answer alone is not proof.
- Keep reasoning behavior aligned with the user's preference. Never expose secrets, raw internal routing contracts or infrastructure jargon as normal product UI.
- Preserve truthful provenance and current search evidence/citations. Treat the search scenarios from the conversation as regression requirements, not authorization to redesign web search in this change set.

### Library choices at a glance

Evaluation means testing the local open-source software for compatibility and performance on the target hardware. Select releases and model assets that permit ongoing local use with no subscription, expiry or vendor usage quota.

| Area | Existing implementation | Proposed library change |
|---|---|---|
| Interactive browser | Playwright is installed; interactive actions use a custom Rust/CDP implementation | Reuse actual Playwright + Chromium for the reference driver. Keep Rust chat/session ownership. Benchmark agent-browser only as an alternative. |
| Browser vision and speed | Screenshot bytes are omitted for the model; actions commonly take several rounds | Update Ruke's image transport and add checked action batches using existing browser operations. No mandatory new model or package. |
| PowerPoint | PptxGenJS plus chart images | Keep PptxGenJS and use native editable chart objects where appropriate. |
| Excel | ExcelJS plus a limited custom formula evaluator | Keep ExcelJS and evaluate local LibreOffice Calc for broader recalculation. |
| Word and PDF output | docx and Playwright/Chromium printing | Keep the existing libraries and improve output validation. |
| Scanned/complex input | unpdf and basic Office text extraction | Evaluate the MIT-licensed local Docling pipeline for OCR, layout and tables. Start it on demand and retain the lightweight path for ordinary files. |
| Charts | Separate hand-written chart renderers | Evaluate the Apache-2.0 licensed ECharts library locally as a shared renderer. |
| ZIP files | Custom code plus an installed fflate dependency | Reuse fflate on compatible paths and retire redundant code. |
| Audio/video uploads | Whisper through Transformers.js and FFmpeg | Keep them. Benchmark whisper.cpp only if a measured CPU problem justifies it. |
| Built-in 3D and CAD | Three.js studio, Meshy provider and custom floor-plan viewer | Retire the built-in features. No replacement 3D/CAD dependency is selected. |
| Blender | No selected external connection in this plan | Future local MCP integration with separately installed Blender. |
| UI, model transport, attachment search | Existing Ruke code and local storage | assistant-ui, AI SDK and SQLite FTS5/sqlite-vec remain selective options, not default additions. |
| Testing | Vitest and Playwright | Keep both; add local model/task comparisons as needed. |
| Web search | Current TypeScript search and evidence pipeline | Preserve it unchanged. |

## 2. Implementation sequence

Every phase is a separate reviewable checkpoint. Record changes, actual checks and remaining gaps. Re-read current source before implementing: the source links in the appendix are pinned evidence, not a guarantee that later develop commits still have the same code.

### Phase 0 — establish the baseline and protect current work

- [ ] Read current AGENTS.md and CLAUDE.md, check the shared Playwright lock and inspect the worktree before changing source.
- [ ] Record the exact starting commit, existing scripts and representative feature behavior. Preserve unrelated work and newer web-search evidence changes.
- [ ] Map browser entry points, model tool schemas, command execution, sessions/ownership, panel streaming, authentication handoff and cleanup.
- [ ] Establish task-success, latency, token and memory measurements. Separate browser work from model inference and network waits.
- [ ] Keep this as planning until the user starts the implementation; this documentation publication does not authorize claiming phases complete.

### Phase 1 — browser observation correctness and portability

- [ ] Fix the requested-screenshot path end to end: image-producing commands, tool descriptions, serialization, provider-supported multimodal messages and tests. The current image-omission function and screenshot-summary contract are identified in the appendix.
- [ ] Let the main model request images whenever visual information helps. Do not force screenshots for every action or prohibit them when text appears sufficient.
- [ ] Preserve screenshot dimensions, clipping offsets, viewport scale, tab identity and freshness so visual coordinates refer to the actual page.
- [ ] Preserve compact DOM/accessibility tools. Include relevant text, labels, values, errors, selected/disabled state and useful surrounding context; clickable-only snapshots are insufficient for many questions.
- [ ] Provide targeted reads, search within observations and pagination/full-view access. Return explicit truncation metadata and a way to retrieve omitted content.
- [ ] Verify tab/frame identity before acting; detect stale references and return recoverable errors rather than silently clicking a different node.
- [ ] Replace incomplete browser-path discovery with the maintained browser package's executable resolver or an equally verified portable method. Preserve explicit overrides.
- [ ] Prove installation/discovery, launch, shutdown, screenshots and file operations on Windows, macOS and Linux.

### Phase 2 — reuse a maintained browser implementation

**Reference implementation for local evaluation: actual Playwright + Chromium.** Ruke's interactive Rust pw.rs is a custom Playwright-style CDP port; the installed Playwright dependency is not proof that this interactive path already uses the upstream driver.

- [ ] Put a small maintained-driver adapter behind the existing browser contract. Reuse the existing Node runtime as a long-lived worker where appropriate; keep the rest of the Rust backend.
- [ ] Prefer the real Playwright locator/action/wait implementation over extending a growing hand-written emulation of it.
- [ ] Keep Ruke's panel, authenticated RPC/WebSocket boundary, session ownership, human takeover, user login and cancellation behavior.
- [ ] Have one browser lifecycle owner. Avoid two independently launched browsers or competing action loops for the same page.
- [ ] Use separate appropriate contexts/profiles for unrelated conversations; serialize actions within one controlled page.
- [ ] Use Microsoft Playwright MCP as a maintained tool-server option/reference if it fits the application's integration. A direct SDK bridge is also valid; adopting MCP is not required solely to call existing function tools.
- [ ] Benchmark Vercel agent-browser as an alternative after the reference path works. Select by correctness, latency, tokens, memory and maintenance burden rather than a vendor headline.
- [ ] Do not select ego(lite) as a required dependency: the reviewed terms allow future paid access and Linux is still a roadmap item.
- [ ] Keep Lightpanda optional/experimental. It does not provide the full graphical browser baseline and requires WSL on Windows in the reviewed release. No mandatory WSL/container layer for ordinary users.
- [ ] Do not replace useful application ownership, authentication or permission boundaries with raw unrestricted access to a new browser control socket.

### Phase 3 — faster execution without blind automation

- [ ] Add/reuse a multi-field fill or guarded action-batch capability. The main model selects known operations once; the executor performs normal locator operations and returns their results together.
- [ ] Check each target and precondition when used. Stop and return partial progress on failure or an unexpected state that invalidates later steps.
- [ ] Return to the model when the next decision depends on information it has not seen. Do not batch invented future choices across unknown pages.
- [ ] Use normal fill/check/select/click operations, appropriate page events and actionability checks. Keep consequential-action controls.
- [ ] Use state-based waits with deadlines. Avoid routine fixed sleeps, forced clicks or network-idle as a universal readiness signal.
- [ ] Keep the browser/context warm, reuse intentional login state and send relevant sections/diffs instead of full-page payloads after each small action.
- [ ] Keep live human-preview frames separate from model observations; rendering a new preview frame must not trigger a new model request.
- [ ] Preserve stable prompt/tool prefixes where possible and measure cache behavior. Do not add a new classifier call to every step.
- [ ] Bound retries, observation sizes and execution time through configurable resource controls, with honest errors and access to more evidence when needed.
- [ ] Require a readback of the requested outcome; a successful tool call is not sufficient to claim completion.

### Phase 4 — retire built-in 3D/CAD; defer Blender to MCP

- [ ] Remove built-in scene3d, asset3d, threejs and cad capability advertising, renderer selection and controls. A removed feature must not still be promised to the model or user.
- [ ] Trace lib/three3d/, lib/cad/, related components/render/ renderers and app/api/3d/ routes before deletion. Update callers, types, contracts, tests, styles and exports together.
- [ ] Remove the Meshy-specific provider requirement, polling flows and unused configuration from the retired path. Do not introduce another paid API or GPU-only replacement.
- [ ] Remove the live-page generated Three.js execution path along with its retired renderer; keep the separate HTML-artifact isolation fix for retained interactive HTML.
- [ ] Remove 3d_asset/cad_blueprint renderer-routing branches and associated activation metadata where no retained feature uses them. Follow repository skill-management rules; do not rewrite downloaded SKILL.md bodies.
- [ ] Trace imports before removing Three.js or any shared helper. Retained browser, document, chart and 2D illustration features must not break.
- [ ] Preserve saved conversations, existing downloaded/exported assets and user files. Display old retired fences through an honest read-only compatibility message/download card instead of executing their old generated code.
- [ ] Remove built-in CAD/BIM previews and DXF-generation UI from the target. Current floor-plan previews do not establish AutoCAD-level design, constraints, editing or drawing compatibility.
- [ ] Keep ordinary 2D charts, Mermaid diagrams and independent SVG illustrations. Inspect anatomy-kit dependencies; retain only independent 2D functionality.
- [ ] Do not install FreeCAD, JSCAD, Maker.js, LibreCAD, model-viewer, glTF Transform or Blender as part of this retirement phase.
- [ ] For a future Blender feature, research a free local MCP server and its licenses/capabilities before selection. The future connection controls separately installed Blender; it does not recreate an inbuilt 3D studio.
- [ ] Future MCP tools must be discovered from the connected server, exposed only while available, and integrated with the existing main model, session controls and artifact/download cards. No new always-on planner or required paid endpoint.
- [ ] Treat future Blender connectivity as a separate implementation request. A full CAD integration can be reconsidered only against explicit architecture-design requirements and demonstrated capability.

### Phase 5 — presentations, spreadsheets, documents and ingestion

- [ ] Keep PptxGenJS, ExcelJS, docx and Chromium PDF printing. They are already established open-source dependencies.
- [ ] Use PptxGenJS native charts when editable presentation charts are required; retain raster/vector images for designs where that is appropriate.
- [ ] Keep required animation/morph behavior until a replacement proves equivalent. Validate actual slides and compatibility; a valid ZIP is not visual proof.
- [ ] Evaluate an on-demand LibreOffice worker for broader formula calculation, document conversion and visual checks. Preserve formula strings and cached values; test real workbooks.
- [ ] Do not silently introduce a proprietary HyperFormula license. If a GPL-compatible integration is ever selected, record its implications explicitly; LibreOffice is the current free-only calculation candidate.
- [ ] Label image-only spreadsheet charts accurately; do not claim editability merely because the file opens.
- [ ] Consider Apache ECharts to consolidate interactive and document chart drawing while preserving Ruke's schema, theme, sliders and follow-up actions.
- [ ] Evaluate local Docling on demand for scanned PDFs, complex tables and reading order. Retain lightweight extraction for simple files. Use prefetched model assets with compatible licenses and keep remote processing disabled.
- [ ] Consolidate compatible custom ZIP paths onto the installed fflate dependency; preserve decompression limits and 7-Zip fallback where needed.
- [ ] Keep FFmpeg/Whisper attachment processing. Benchmark whisper.cpp only for a demonstrated CPU accuracy/performance/packaging need.
- [ ] Keep web-video caption work under the frozen search boundary. Do not present captions as full audiovisual understanding.
- [ ] Preserve Power BI export only if its actual files remain valid in the target application; an unrelated dashboard package is not a drop-in substitute.

### Phase 6 — coherent chat UI and integration

- [ ] Preserve streaming, stop/cancel, retry, attachments, citations, browser status, recents, protected titles, conversation persistence and follow-up context.
- [ ] Keep stream updates rAF-batched, completed messages memoized and expensive highlighting deferred while a fence is streaming, as required by CLAUDE.md.
- [ ] Lazy-load retained viewers and optional Office/OCR engines. Dispose resources on unmount and ensure retired 3D/CAD animation loops and workers are no longer started.
- [ ] Make progress and failures understandable: distinguish “opening,” “reading,” “waiting for login,” “completed” and “could not verify” without pretending success.
- [ ] Keep keyboard, focus, scrolling, responsive layout and accessible controls working throughout streaming and browser handoff.
- [ ] Preserve meaningful artifact editing/export and clear generation errors. Avoid a renderer router suppressing a valid generated artifact.
- [ ] Consider assistant-ui primitives only for a concrete UI gap; preserve Ruke's specialized renderers and panel.
- [ ] Consider AI SDK integration only if it simplifies a demonstrated transport/tool problem. Check version compatibility and preserve local-provider reasoning, usage, cancellation and streaming contracts.
- [ ] Preserve compaction/raw history, token estimates versus actual usage, title scheduling and the single local inference owner.
- [ ] Keep existing local persistence/retrieval at its current scale. SQLite FTS5/sqlite-vec is a measured consolidation option, not a mandatory new database project.
- [ ] Preserve current skill installation/lazy loading. Do not fabricate or rewrite SKILL.md files, expose hidden core skills or inject irrelevant skills into every turn.
- [ ] Distinguish implemented features from placeholders: audio-file transcription is implemented; the inspected voice buttons were placeholders. A new voice experience is a separate feature, not proof of a completed migration.

### Phase 7 — cleanup, regression and release evidence

- [ ] Remove replaced code only after import/contract tracing and the new path's validation establish it is superseded. Compatibility and dynamically dispatched code are not automatically unused.
- [ ] Avoid duplicate production loops and engines after the selected replacement is established. Retain a bounded, reviewable transition mechanism only as needed.
- [ ] Keep backend/frontend/generated contracts aligned. Preserve error handling, session cleanup, cancellation and settings during deletion.
- [ ] Keep Pino/tracing, Vitest and Playwright tests. Use local Promptfoo evaluations or BrowserGym/AgentLab adapters selectively for comparative task scoring; no paid judge model is required.
- [ ] Run model-driven tests serially under the repository's lock protocol. Finish each run before editing or interpreting its final results.
- [ ] Report the exact source commit, environment, commands, pass/fail counts, exit status, latency/resource measurements and remaining limitations.
- [ ] Do not claim “same as ChatGPT,” a universal internet-access rate or a fixed speedup from implementation alone. Publish the measured workflows and honest failure cases.

## 3. Acceptance criteria for the intended experience

| Area | Required evidence |
|---|---|
| Ordinary chat | Useful direct answers, coherent follow-ups, no unsolicited time announcements, stable streaming/stop/retry and restored history. |
| Browser observation | DOM/text and requested screenshots reach the model correctly; relevant values/errors are retained and omitted content is retrievable. |
| Browser actions | Routine forms, dynamic rerenders, ambiguous labels, nested frames, shadow DOM, popups, visual controls and multi-tab tasks reach verified final states. |
| Login and takeover | Human signs in/resumes in the intended session; the model re-observes and continues; unrelated sessions remain isolated. |
| Failure handling | Action ambiguity, timeouts, navigation failure, blocked pages, cancellation and process crashes produce useful honest outcomes and cleanup. |
| Performance | Compare the same task/model/settings on the old and selected paths; report cold/warm latency distributions, model rounds/tokens and whole-process-tree memory/CPU. No wrong-action increase in return for speed. |
| Consumer hardware | Normal chat/browser remains usable on the 16 GB CPU-only baseline with optional workers accounted for; no compulsory GPU service or persistent memory-heavy stack. |
| Platforms | Native install, discovery, startup, shutdown, files, keyboard modifiers and graphics behavior verified on supported Windows/macOS/Linux builds. |
| 3D/CAD retirement | No inbuilt 3D/CAD controls or model capability promises remain; old conversations/assets are preserved; retained features work without installing a 3D/CAD engine. Blender MCP remains deferred. |
| Office artifacts | PPT charts are editable where promised; formulas/cached values are validated; Word/PDF/presentation output is visually checked in suitable applications. |
| Search preservation | Existing normal research, explicit-site scope, citations, freshness and follow-ups do not regress; no SearXNG migration or default interactive-browser substitution. |
| Maintainability | Reused libraries replace actual duplicated behavior; no orphan workers, dead parallel harnesses, fabricated skills or incidental framework rewrite. |

These are completion gates to demonstrate, not test results already obtained. The final chat UI should be judged by coherent behavior and successful user tasks rather than visual resemblance alone.

## 4. Source-backed feature review and implementation rationale

The following review contains the full recommendation matrix, original code evidence, alternatives, licensing/hardware considerations and detailed validation scenarios. Browser source findings are unchanged by the publication baseline's two web-search commits; the current source must still be rechecked at execution time.


Original source-audit evidence: 6 November 2026 (Asia/Kolkata), commit **c115256155ce21887633bca5965aeeb880bfe6d1**. Publication baseline for this plan: **dcfb2c56cb2d0e54c893f402b74837ef01d9ebd3**. The two intervening commits change web-search evidence handling and associated tests/documentation; they do not change the browser files cited below. Their changes are preserved and are not revalidated by this documentation commit.

The revised scope prioritizes interactive browser use, presentations, documents and chat UI. Built-in 3D and CAD are excluded; Blender is a future external MCP option. Web search stays unchanged. The core target remains local/self-hosted software without a required subscription, trial expiry, vendor quota or paid API. Hardware costs, open-source obligations and future upstream licensing still require attention.

**Hardware baseline: ordinary consumer laptops on Windows, macOS and Linux, with 16 GB total system RAM, an i5-class CPU or comparable Apple Silicon and no dedicated graphics card.** Measure the complete OS/model/browser workload and start retained optional workers only when needed. TRELLIS, built-in 3D engines and CAD runtimes are outside the core target.

This is a source and alternatives audit, not an implemented migration or a runtime comparison. I inventoried 351 source files under the main application/backend directories (including vendored illustration code and inline Rust tests), inspected subsystem entry points and representative implementations, and checked primary upstream repositories/documentation. I did not manually review every line of that inventory, run model-driven browser tests, install these alternatives or establish an application-wide pass rate.

## Decision

Do not replace Ruke wholesale. Its existing dependencies already cover much of what would otherwise need to be built: Playwright/Crawlee, Readability, Three.js, PptxGenJS, ExcelJS, docx, FFmpeg, Whisper through Transformers.js, SQLite, Vitest and Playwright Test. Evidence: [package.json](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/package.json) and [rust-backend/Cargo.toml](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/rust-backend/Cargo.toml).

The highest-value plan is:

1. Repair the browser-to-model screenshot bridge and benchmark a maintained local browser driver behind Ruke’s current interface.
2. Keep the panel, main model, session ownership and application-specific integration; reduce custom browser implementation only after a replacement proves it can preserve the needed functions.
3. Retire the built-in 3D/CAD studios and related runtime promises; preserve user files and independent 2D features. Defer Blender to a future external MCP connection.
4. Improve presentations using features of the PptxGenJS dependency already installed.
5. Replace or consolidate genuinely duplicated infrastructure: ZIP handling, chart drawing, advanced document parsing and spreadsheet calculation.
6. Keep the existing web-search system and leave its provider settings untouched.

“Most reputable” and “best for Ruke” are not interchangeable. There is no evidence that one library is universally best, or that changing a driver alone produces ChatGPT-level task performance.

## Browser use: the most important verified gap

**The current Rust browser chat loop does not pass screenshot pixels to the model through its screenshot-result path.**

[cull_tool_result](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/rust-backend/crates/ruke-server/src/chat/browser_loop.rs#L239) replaces strings under `data` and `image_base64` longer than 256 characters with an image-omitted placeholder. The normal successful-command path calls it at [line 786](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/rust-backend/crates/ruke-server/src/chat/browser_loop.rs#L786). Then [the tool-message append](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/rust-backend/crates/ruke-server/src/chat/browser_loop.rs#L816) serializes the result as text. The test at line 986 explicitly expects large images to be removed.

This is not the same as giving a vision model a compressed image. The human can see a real browser frame while the model receives a statement that the image was omitted. DOM/accessibility tools can still support many tasks, but this path cannot perform genuine visual judgments from the omitted screenshot.

Fix this regardless of the replacement chosen:

- Detect image outputs and send the actual image through the configured provider’s supported multimodal message format, preserving tool-call associations.
- Use bounded resolution and recent images to control context use. Do not paste base64 into ordinary text or silently substitute a caption for an image.
- Keep DOM/accessibility observations for efficient interaction. Use screenshots for visual information such as canvas controls, layout, images or nonsemantic widgets.
- If the configured local model cannot process images, expose that capability limitation clearly and retain its text-based browser actions.
- Verify the model can identify information available only in a screenshot, then act and re-observe the actual result.
- Replace the unit test that enshrines image omission with tests for safe image transport and bounded retention.

[Official OpenAI documentation](https://developers.openai.com/api/docs/guides/tools-computer-use) describes a model/driver loop where observations and actions return to the model and the application retains session/cleanup responsibility. It does not establish that a third-party open-source driver uses ChatGPT’s private implementation. OpenAI API models are not part of this free-only recommendation.

### Browser speed and cross-platform baseline

The target covers supported releases of **Windows, macOS and Linux** on ordinary 16 GB consumer machines. Use native browser/driver packages for each platform and architecture; a Windows-only implementation or compulsory WSL/container layer is not the baseline.

A concrete portability gap exists in the checked Ruke revision: [host.rs:91](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/rust-backend/crates/ruke-browser/src/host.rs#L91) scans Windows/Linux Chromium executable paths and has no macOS application-bundle path. The explicit executable override is separate; its presence does not make automatic discovery portable. Prefer the upstream browser package's executable resolver over maintaining another incomplete path list, and test installation/discovery, startup, cleanup, file operations and screenshots on all three operating systems.

Use a compact DOM/accessibility observation and direct element actions for routine reading, navigation and form entry. Use real screenshots and a vision-capable model when the task depends on appearance, canvas controls or visual recovery. The human preview stream and the model's visual observations are separate: showing live frames to the user does not require a model call for each frame.

Reduce model round trips by allowing bounded batches of actions whose targets and outcomes are already sufficiently known. For example, fill several known fields in one tool execution, then return values/status together. Stop a batch on an unexpected page change, ambiguous target or failed precondition; re-observe before choosing dependent actions. Keep consequential-action controls and verify outcomes. Do not trade correctness for blind scripts.

Keep the browser/session warm, return targeted page sections or useful diffs, use state-based waits, and avoid repeated full-page captures or fixed sleeps. Preserve stable model prompt prefixes and do not add another planner model solely to decide every small browser step. Measure model inference, observation size, driver action/wait time and retries separately.

Ruke already exposes DOM and locator tools in [tools.rs](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/rust-backend/crates/ruke-browser/src/tools.rs#L233), and its [browser guidance](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/rust-backend/crates/ruke-server/src/chat/browser_loop.rs#L87) already prefers them. This is an improvement to execution, batching and image transport, not a claim those tools are missing.

The likely “eco lite” reference is **ego(lite)**. Its [official site](https://www.egolite.ai/) describes compact semantic snapshots and composing several operations in JavaScript. Those are useful design ideas, but they are not exclusive to a new browser engine: [Playwright locators](https://playwright.dev/docs/locators) can also be composed into a script. Its published speed claims are vendor measurements, not a Ruke benchmark.

ego(lite) is excluded from the selected free/open-source, three-platform baseline: its [terms](https://www.egolite.ai/terms) allow existing free features to become paid, and its [download page](https://www.egolite.ai/download) lists Linux as a roadmap item. A free download is not evidence of a reusable open-source license.

**Lightpanda is an optional experiment, not the default interactive browser.** Its [upstream README](https://github.com/lightpanda-io/browser) documents native Linux/macOS builds and WSL2 for Windows, no graphical renderer and text-only PNG/PDF output. It is a browser engine, whereas Playwright is an automation library. Replacing Chromium with Lightpanda does not accelerate local-model inference and may lose required browser capabilities. Its AGPL-3.0 source has no required hosted subscription, but compatibility and licensing remain relevant. Benchmark total machine overhead and task correctness before including it.

Use actual Playwright with Chromium as the cross-platform reference implementation. Keep agent-browser as an alternative to benchmark. CLI, MCP and a direct SDK bridge are different integration choices, not evidence of a different or inherently faster browser engine. No guaranteed speed multiplier, instant CPU vision or universal website compatibility is established by this audit.

### Browser driver comparison

| Candidate | What it supplies | Fit for Ruke | Free-only assessment |
|---|---|---|---|
| [Playwright library + Chromium](https://playwright.dev/docs/intro) | Maintained browser actions, semantic locators, actionability waits, contexts, screenshots and tracing. | **Primary reference implementation for local evaluation.** Use the existing Node runtime as a long-lived browser worker behind the Rust contract. | Apache-2.0 Playwright and locally installed browser; no required model API subscription. |
| [Vercel agent-browser](https://github.com/vercel-labs/agent-browser) | Native Rust CLI/daemon, compact element refs, browser actions, sessions and CDP connection options. Its documented streaming API supports live frames and human input. | **Benchmark alternative for the Rust backend and live panel.** Wrap its commands/results rather than copying its implementation. | Apache-2.0 local software; no hosted provider or paid model is required. Run with the existing local model and local browser. |
| [Microsoft Playwright MCP](https://github.com/microsoft/playwright-mcp) | Ready-made model-facing browser tools, accessibility snapshots, screenshots and opt-in coordinate actions. | **Maintained tool-server option/reference.** Standard MCP integration can reduce bespoke tool plumbing, while a direct SDK bridge can avoid adopting another protocol where Ruke already has function tools. Ruke must still supply its panel/session adapter. | Apache-2.0; local browser operation is supported. MCP adds no required paid model. |
| [Stagehand](https://github.com/browserbase/stagehand) | Structured extraction and natural-language browser operations; local browser support. | Useful when a specific action/extraction layer is needed. Additional model calls and an overlapping orchestration layer need measurement. | MIT library. Hosted Browserbase and commercial model examples are optional, not selected dependencies. Not the default pilot. |
| [Browser Use](https://github.com/browser-use/browser-use) | A complete Python browser agent/controller with local execution options. | A larger architectural change: it may duplicate Ruke’s controlling model loop rather than merely replace a driver. | MIT library; its hosted cloud/stealth services are separate products and excluded from this plan. |

The [agent-browser installation documentation](https://agent-browser.dev/installation) documents Windows native support. Its [streaming contract](https://agent-browser.dev/streaming) covers frame delivery and input, while its [snapshot documentation](https://agent-browser.dev/snapshots) describes element-ref lifetimes. These are relevant capabilities to reuse, not measured proof of superiority over Ruke.

Do not choose TypeScript merely because web pages use JavaScript. A maintained Rust browser controller can work well; agent-browser is itself a current example. The relevant questions are action correctness, observations, session behavior, failure handling and maintenance burden.

### The Ruke integration that must survive a driver replacement

[lib/browser-client/browserClient.ts](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/lib/browser-client/browserClient.ts#L1) already exposes a panel-specific RPC and ticketed WebSocket contract. [rust-backend/crates/ruke-browser/src/session.rs](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/rust-backend/crates/ruke-browser/src/session.rs) handles ownership/claims. [rust-backend/crates/ruke-browser/src/auth_handoff.rs](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/rust-backend/crates/ruke-browser/src/auth_handoff.rs) supports human sign-in. [rust-backend/crates/ruke-browser/src/authority.rs](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/rust-backend/crates/ruke-browser/src/authority.rs) owns application permissions.

Keep those product capabilities while changing implementation behind them. Do not expose a replacement’s raw local control socket to arbitrary web pages, silently attach different sessions to the same tab, or replace a requested authenticated page with a public snippet.

The browser loop also has scope and routing decisions before tool execution, a 20-round cap and text result limits. These are separate from the low-level driver. If the harness withholds browser tools or rejects a legitimate destination, changing the CDP implementation will not repair that behavior. Review model-visible failures and actual task outcomes instead of copying another project’s entire prompt.

## Follow-up research: refined browser design

**The original five-row plan is directionally sound, but should be implemented as adaptive capabilities rather than a rigid task classifier.** The model may request text, a richer DOM section or a screenshot whenever that helps. The harness should not decide this using website names or a fixed phrase list.

The refined reference implementation is **actual Playwright + Chromium, compact task-relevant observations, guarded action batches, optional vision and verified outcomes**. This is an engineering recommendation assembled from maintained browser mechanics and published evaluation work; it is not a published guarantee that this exact Ruke implementation is optimal.

### What the research establishes

- [Microsoft Playwright MCP](https://github.com/microsoft/playwright-mcp) uses structured accessibility observations and exposes screenshots/optional vision tools. Its existing `browser_fill_form` tool fills multiple fields, so this reuse does not require inventing a new agent framework.
- [Playwright locators](https://playwright.dev/docs/locators) resolve elements when actions run. [Actionability checks](https://playwright.dev/docs/actionability) wait for the relevant conditions before acting. These are useful browser mechanics independent of an LLM’s quality.
- [Playwright’s waiting guidance](https://playwright.dev/docs/api/class-page#page-wait-for-timeout) discourages fixed sleeps in production; its load-state documentation also discourages treating network-idle as general proof that a task is ready.
- [BrowserGym](https://arxiv.org/abs/2412.05467) provides a reproducible framework for comparing agents across benchmarks with text/DOM/accessibility and visual observations. Its historical model rankings are not current rankings and should not be copied into a 2026 performance claim.
- [VisualWebArena](https://arxiv.org/abs/2401.13649) demonstrates why a text-only observation policy misses genuinely visual tasks. It supports retaining vision, not requiring a screenshot after every form-field operation.

### Revised behavior

| Situation | Implementation | Reliability requirement |
|---|---|---|
| Read or locate something on a page | Return task-relevant visible text plus useful element roles, labels, values and state. | Compact observations must retain answer-bearing content, validation messages and disabled/selected states. Interactive-elements-only output can omit the answer. |
| Fill already-understood fields | Use an existing multi-field tool or a bounded sequence of standard locator operations. | Resolve/check each target when used; stop and return partial progress if a target, precondition or expected state fails. |
| Choose the next page or handle an unfamiliar workflow | Observe, let the main model decide, execute, then observe the relevant result. | Do not batch decisions that depend on information the model has not seen. |
| Interpret images, visual layout or canvas widgets | Deliver a real screenshot through a supported vision input; add coordinates/element context when useful. | Preserve pixel/viewport scaling and screenshot freshness. Permit a larger view when a crop is insufficient. |
| A page changes or an action fails | Return the actual failure with current URL/tab and a targeted fresh observation. | Re-observe before repeating. Avoid blind retries of actions that may already have changed remote state. |
| Continue a conversation | Reuse its browser context/profile where appropriate. | Preserve ownership and intentional sign-in; keep unrelated conversations isolated and serialize actions on the same page. |
| Decide whether the task is done | Read back relevant final state or verify the requested artifact. | A successful click or an LLM saying “done” is not task-success evidence. |

A bounded batch is not a new autonomous agent. The main model chooses the intended operations; the executor carries them out with ordinary browser checks and returns results. For example, three known fields can be filled in one execution, followed by a readback. A subsequent choice based on newly loaded results belongs to the next observation/decision. Keep existing controls around consequential actions.

Use standard locator `fill`, `check`, `selectOption` and `click` operations so page events and actionability behavior remain correct. Avoid exposing unrestricted host-process JavaScript merely to obtain batching: the current upstream MCP explicitly labels its arbitrary run-code tool unsafe. A structured form-fill/batch surface can cover the common fast path without a second model or agent loop.

### Ruke-specific changes established by the checked source

1. **Reuse the real driver instead of extending the Rust Playwright-style port indiscriminately.** [pw.rs](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/rust-backend/crates/ruke-browser/src/pw.rs#L1) is a custom CDP implementation. Its [classify_seg](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/rust-backend/crates/ruke-browser/src/pw.rs#L220) supports a narrower selector surface and rejects other engines. Naming a command `playwright_*` does not mean it uses the upstream Playwright implementation. Evaluate a maintained driver bridge locally and compare its behavior before deleting the port.
2. **Add a multi-field/guarded batch capability.** [tools.rs](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/rust-backend/crates/ruke-browser/src/tools.rs#L450) exposes individual fills. The [browser-loop comment](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/rust-backend/crates/ruke-server/src/chat/browser_loop.rs#L66) describes one-call-per-model-round behavior as common for its local model; the loop can already accept several tool calls, so it should not be described as technically limited to one. Measure the actual round count.
3. **Fix visual output when requested.** [cull_tool_result](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/rust-backend/crates/ruke-server/src/chat/browser_loop.rs#L239) removes images. The [screenshot tool description](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/rust-backend/crates/ruke-browser/src/tools.rs#L239) also promises only a text summary. Update the transport, tool contract and tests together. This is optional vision that works when used, not compulsory vision on every step.
4. **Make large observations navigable.** [tool_content](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/rust-backend/crates/ruke-server/src/chat/browser_loop.rs#L259) truncates serialized results. Add targeted reads/pagination and explicit truncation metadata so the model can retrieve omitted evidence.
5. **Fix macOS discovery and retain the current panel/session capabilities.** The portability gap and ownership requirements are described above. Do not create a second conflicting browser owner while introducing the new worker.

These changes leave normal web search untouched. They do not require migrating the rest of the Rust backend.

### Proof required before calling the implementation better

Compare the existing browser path with the local evaluation build using the same model/settings, equivalent initial state and task set. Include routine forms, React rerenders, duplicate labels, nested frames, shadow DOM, popups, visual-only controls, login/resume, multi-tab work, downloads, validation errors, cancellation and process failure. Use varying labels/content to avoid passing only website-specific scripts.

Run native installation/lifecycle and functional checks on supported Windows, macOS and Linux releases, including Intel/Apple Silicon builds where supported. Evaluate the combined 16 GB consumer-laptop workload; do not spend the whole RAM allowance on the model alone.

Track completed tasks, incorrect actions, recoveries, model calls, input/output tokens, peak memory, CPU load and task latency distributions. Separate browser launch, page/network waits, model prefill/generation and image processing. Keep both cold-start and warm-session results. A browser engine’s page-loading speedup is not an end-to-end agent speedup.

Use BrowserGym/AgentLab selectively as evaluation references or adapters; full benchmark environments do not need to ship with Ruke or run on every end-user laptop. Keep deterministic local fixtures and actual final-state assertions as the inexpensive regression foundation. Do not require paid judge models.

**Verification status:** the browser follow-up was verified against c115256155ce21887633bca5965aeeb880bfe6d1; the publication baseline is recorded at the top of this plan. The existing local code graph was consulted but contains stale paths, so source findings above were verified directly against that commit. This follow-up researched sources and updated the plan; it did not implement the driver, run an agent benchmark or establish cross-platform runtime pass rates.

## Feature-by-feature comparison

The table covers 45 feature areas or integration concerns. “Keep” means an alternative was considered but does not justify a replacement now. “Pilot” means there is a plausible maintenance/quality gain, not a benchmark win already demonstrated.

| Feature | Current code / existing reuse | Best-fit alternative | Recommendation and limits | Priority |
|---|---|---|---|---|
| Browser actions and DOM/accessibility snapshots | [rust-backend/crates/ruke-browser/src/executor.rs](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/rust-backend/crates/ruke-browser/src/executor.rs) plus custom pw.rs, ax.rs and CDP modules. | Actual [Playwright](https://playwright.dev/docs/intro) with Chromium as the reference driver; agent-browser as a comparison candidate. | Use the maintained Playwright implementation behind Ruke’s existing boundary; keep the model loop and panel. Compare agent-browser only after establishing correctness and timing on the reference path. | First |
| Browser screenshots reaching the model | [cull_tool_result](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/rust-backend/crates/ruke-server/src/chat/browser_loop.rs#L239) removes image strings over 256 characters; [tool-result append](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/rust-backend/crates/ruke-server/src/chat/browser_loop.rs#L816) sends a text string. | Fix the multimodal bridge with the chosen driver and a vision-capable model. | Required independently of replacement. Do not send raw base64 as ordinary prose, and do not replace requested screenshots with placeholders. | First |
| Live browser panel and human takeover | [lib/browser-client/browserClient.ts](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/lib/browser-client/browserClient.ts#L1) has RPC, ticketed WebSocket, frames, tab updates and approval/auth cards. | [agent-browser streaming](https://agent-browser.dev/streaming) provides a reusable frame/input transport. | Keep the Ruke UI. Adapt streaming behind its contract; preserve authentication, frame freshness, coordinate mapping and human input. A tool server alone does not replace the panel. | With browser pilot |
| Browser sessions, login and tab ownership | [rust-backend/crates/ruke-browser/src/session.rs](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/rust-backend/crates/ruke-browser/src/session.rs) and [rust-backend/crates/ruke-browser/src/auth_handoff.rs](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/rust-backend/crates/ruke-browser/src/auth_handoff.rs) own the application-specific lifecycle. | Use the selected driver’s persistent profiles/contexts; preserve Ruke ownership and login handoff. | Keep application semantics. Prove cookies persist and separate conversations cannot manipulate each other’s tabs. Avoid deleting this code just because a replacement can click. | With browser pilot |
| Browser planning, routing and completion | [rust-backend/crates/ruke-server/src/chat/browser_loop.rs](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/rust-backend/crates/ruke-server/src/chat/browser_loop.rs#L1) routes operational intent and drives tools; [rust-backend/crates/ruke-server/src/task_scope.rs](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/rust-backend/crates/ruke-server/src/task_scope.rs) supplies scope. | Ruke’s main model with the selected local driver. Browser Use and Stagehand are comparison candidates. | Keep one controlling model loop and the local model endpoint. Driver replacement does not remove routing refusals or repair scope extraction. Avoid adding a second agent/controller without evidence it helps. No hosted Browser Use/Browserbase service is required or selected. | With browser pilot |
| CAD floor plans and simple BIM preview | [lib/cad/cadSchema.ts](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/lib/cad/cadSchema.ts#L4) defines 2D entities, walls/slabs and extruded massing; [lib/cad/cadEngine.ts](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/lib/cad/cadEngine.ts) implements the viewer. | Retire built-in CAD from the current core scope. | The current schema provides floor plans and extruded previews, with no demonstrated AutoCAD-level architecture-design capability. Remove the feature coherently and preserve historical artifacts. | Remove from core |
| 2D geometry, DXF and drafting | [cadToDxf](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/lib/cad/svgToDxf.ts#L26) writes DXF; cad2d/cadBlocks provide drawing primitives. | Retire the CAD-specific built-in drafting/export path. | No new Maker.js or LibreCAD integration is selected. Preserve independent charts/diagrams and existing exported files; reconsider full drafting later against explicit requirements. | Remove from core |
| Parametric JavaScript solid modeling | Current 3D paths use Three.js meshes and custom scene specifications. | No JSCAD addition. | Built-in solid modeling is removed from the target. Future external capabilities must be separately selected and validated. | Excluded |
| Procedural 3D models, materials and rendering | [lib/three3d/sceneBuilder.ts](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/lib/three3d/sceneBuilder.ts) and [lib/three3d/studioEngine.ts](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/lib/three3d/studioEngine.ts) already build on Three.js. | Retire built-in 3D creation and studio controls. | Do not replace them with another embedded engine. Blender is deferred to a separately installed application controlled through a future MCP connection. | Remove from core |
| AI-generated 3D assets | [lib/three3d/providers/index.ts](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/lib/three3d/providers/index.ts#L8) selects only Meshy. No configured key means no AI provider; the comment about local generators is not an implementation. | Remove the inbuilt generation/provider path. | No Meshy subscription, TRELLIS model or local generative replacement is required. Preserve existing user assets and avoid advertising unavailable generation. | Remove from core |
| 3D asset preview | [components/render/ThreeStudioViewer.tsx](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/components/render/ThreeStudioViewer.tsx) has scene editing, picking, transforms and custom studio controls. | Remove the inbuilt 3D viewer/editor. | No model-viewer replacement is selected. Existing saved assets can remain accessible through read-only metadata/download cards. | Remove from core |
| 3D export and asset optimization | [lib/three3d/exporters.ts](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/lib/three3d/exporters.ts#L1) already imports Three.js GLTFExporter and mesh exporters. | Retire exports tied to the built-in studio. | Preserve existing files. No glTF Transform dependency is proposed now; a future external MCP workflow can return artifacts without a new embedded studio. | Remove from core |
| Executable 3D code isolation | [runThreeCode](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/lib/three3d/codeRunner.ts#L37) executes new Function; [components/render/ThreeStudioViewer.tsx](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/components/render/ThreeStudioViewer.tsx#L214) calls it in the live client. | Remove the retired Three.js execution path. | Remove its callers and capability promises. Generated HTML remains a separate retained feature and still needs proper isolation. | Retirement fix |
| Anatomy and technical illustrations | [lib/anatomy/kit/NOTICE.md](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/lib/anatomy/kit/NOTICE.md#L3) records an already-vendored MIT illustration kit. | Retain independent 2D/SVG illustrations only. | The already-vendored kit is not a reason to retain the general 3D pipeline. Inspect shared dependencies and remove any 3D-dependent path without breaking independent diagrams. | Keep 2D only |
| PPT creation | [lib/documents/pptxEngine.ts](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/lib/documents/pptxEngine.ts#L81) already uses PptxGenJS. | [PptxGenJS](https://github.com/gitbrent/PptxGenJS). | Keep it. Replacing it with a Python library would largely repeat an existing capability and add another integration. | Keep |
| Editable PPT charts | [lib/documents/pptxEngine.ts](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/lib/documents/pptxEngine.ts#L101) renders chart PNGs for the deck. | [PptxGenJS addChart](https://gitbrent.github.io/PptxGenJS/docs/api-charts.html). | Use native chart objects where editability matters. Retain images when fidelity is the goal. This improvement needs no new chart-generation dependency. | High value, small scope |
| PPT animation and morph processing | [lib/documents/pptxEngine.ts](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/lib/documents/pptxEngine.ts#L213) invokes scripts/pptx_morph_injector.py after generation. | Keep the focused adapter until a proven library feature covers the same transitions. | No verified drop-in replacement for the current morph behavior was established. Separate slide content generation from optional animation post-processing and test in the target presentation application. | Keep / validate |
| Word documents | [lib/documents/docxEngine.ts](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/lib/documents/docxEngine.ts#L14) already uses the docx library. | Keep docx; use [LibreOffice](https://www.libreoffice.org/) for optional rendering/conversion. | No reason to build another OOXML writer. Rich editing inside the browser would be a separate feature, not a replacement for this generator. | Keep |
| Excel files | [lib/documents/xlsxEngine.ts](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/lib/documents/xlsxEngine.ts#L9) already uses ExcelJS. | Keep ExcelJS for workbook generation. | File serialization is already delegated. Formula calculation and chart editability are separate concerns. | Keep |
| Spreadsheet formula evaluation | [lib/documents/recalc.ts](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/lib/documents/recalc.ts#L16) has a custom parser, evaluator and limited function set. | A local [LibreOffice Calc](https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html) worker. | Strong reuse candidate. Compare formulas, dates, errors and cached cell values. HyperFormula is GPLv3/commercial dual-licensed, so it is not the default for this no-paid-license plan. LibreOffice adds installation/process cost; it is not fully identical to Excel. | High value |
| Excel chart export | [lib/documents/xlsxEngine.ts](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/lib/documents/xlsxEngine.ts#L162) embeds chart PNGs using ExcelJS addImage. | Keep image charts if sufficient; evaluate an engine that creates native spreadsheet charts only if required. | Do not label these editable native charts. Changing to another library with the same limitation will not fix the requirement. | Requirement-dependent |
| PDF and resume generation | [lib/documents/pdfEngine.ts](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/lib/documents/pdfEngine.ts#L29) uses Chromium page.pdf; resume generation shares HTML/print infrastructure. | Keep Playwright/Chromium printing; optional LibreOffice conversion for Office inputs. | Already a mature rendering engine. Improve pagination, fonts and content validation rather than replacing the whole pipeline. | Keep |
| Interactive charts and document chart drawing | [components/render/ChartBlock.tsx](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/components/render/ChartBlock.tsx#L66) implements chart scales/marks; [lib/documents/chartHtml.ts](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/lib/documents/chartHtml.ts#L45) separately draws SVG. | [Apache ECharts](https://github.com/apache/echarts). | A worthwhile consolidation candidate: one adapter can serve interactive charts and server-rendered SVG. Preserve the existing schema, sliders and follow-up actions. No automatic promise of smaller bundles. | High value |
| Power BI projects | [lib/documents/powerbiEngine.ts](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/lib/documents/powerbiEngine.ts#L228) assembles PBIP/TMDL/PBIR content and a companion archive. | Keep the exporter if Power BI compatibility is required. | An open-source dashboard application is a different product and does not make the same files or implement the same DAX engine. Validate generated files in Power BI; do not substitute an unrelated dashboard and call the feature preserved. | Keep / validate |
| HTML artifacts | [components/render/HtmlArtifactBlock.tsx](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/components/render/HtmlArtifactBlock.tsx#L142) combines allow-scripts and allow-same-origin for generated srcDoc. | A genuinely separated preview origin/opaque-origin iframe; Sandpack only for more advanced coding previews. | Concrete isolation issue, independent of framework. Preserve rendering with explicit message passing and suitable content/network controls; test that generated code cannot access the parent application. | Required fix |
| Widgets, forms and KPI cards | [components/render/WidgetBlock.tsx](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/components/render/WidgetBlock.tsx) and [lib/render/schemas.ts](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/lib/render/schemas.ts#L142) define model-generated structured UI. | Keep Ruke components and Zod contracts. | Small product-specific code is reasonable. Generic UI libraries do not understand Ruke’s send/follow-up semantics automatically. | Keep |
| Chat composition, scrolling, retry and attachments UI | [hooks/useChat.ts](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/hooks/useChat.ts) and components/ChatInput.tsx own the user-facing behavior. | [assistant-ui](https://github.com/assistant-ui/assistant-ui). | A useful source of reusable React primitives, not a mandatory redesign. Introduce isolated components only when they fix a measured issue; preserve custom renderers, browser panel and progress/citation events. | Selective / later |
| Model transport, tools and streaming | [lib/chat/client.ts](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/lib/chat/client.ts) and [lib/stream/parser.ts](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/lib/stream/parser.ts) plus the Rust chat path handle custom streaming/tool orchestration. | [Vercel AI SDK](https://ai-sdk.dev/docs/introduction), optional local integration. | Selective reuse, not an immediate rewrite. Preserve reasoning fields, usage, cancellation, single completion framing and local inference scheduling. Use the existing local endpoint. A multi-provider gateway is unnecessary unless that becomes an actual requirement. | Later |
| Model inference | [lib/server/settings.ts](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/lib/server/settings.ts#L15) points to an external OpenAI-compatible endpoint; model stats query that server. | Keep the configured external inference engine. | Ruke is not implementing model inference from scratch here. Replacing its chat UI does not change the underlying model’s ability. | Keep |
| Conversation storage, recents and title protection | [lib/persistence/disk.ts](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/lib/persistence/disk.ts) and [rust-backend/crates/ruke-server/src/persistence.rs](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/rust-backend/crates/ruke-server/src/persistence.rs) manage JSON conversation documents and protected metadata. | Keep current storage at present scale; SQLite is an optional future consolidation. | Do not introduce a new database server just to store local chat history. Any migration must preserve titles, timestamps, deletion and existing files. | Keep |
| Context compaction and token display | [lib/chat/compact.ts](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/lib/chat/compact.ts) preserves raw history while compacting model context; [lib/chat/tokenMeter.ts](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/lib/chat/tokenMeter.ts) distinguishes usage from estimates. | Keep the application policy; use the configured model’s tokenizer when exact counts are needed. | A generic tokenizer for another model can be less accurate. A framework cannot choose the correct compaction policy for Ruke automatically. | Keep |
| Attachment PDFs, scanned pages and rich layouts | [lib/server/extract/pdf.ts](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/lib/server/extract/pdf.ts#L7) extracts PDF text; [lib/server/extract/office.ts](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/lib/server/extract/office.ts#L4) strips Office XML. | [Docling](https://github.com/docling-project/docling). | Strong optional parser for scanned PDFs, tables and reading order. Keep the lightweight fast path for simple files and start the heavier parser on demand. | High value |
| Long-file question answering and retrieval | [lib/server/attachindex/retrieve.ts](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/lib/server/attachindex/retrieve.ts#L94) combines custom BM25 and vector similarity with neighbor packing; JSONL indices are stored locally. | [SQLite FTS5](https://www.sqlite.org/fts5.html) plus [sqlite-vec](https://github.com/asg017/sqlite-vec). | A sensible local-storage pilot if indexing/retrieval is a bottleneck. Keep embeddings, source spans, timestamps and answer synthesis. A database is not an answer-quality fix by itself. | Scale-dependent |
| Embeddings | [lib/server/attachindex/embed.ts](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/lib/server/attachindex/embed.ts#L9) uses a local MiniLM model through Hugging Face Transformers.js. | Keep the existing Transformers.js integration; model choice can be evaluated separately. | Already delegated to an open-source model/runtime. Different embedding models require rebuilding stored vectors. | Keep |
| Audio-file transcription | [lib/server/extract/audio.ts](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/lib/server/extract/audio.ts#L32) uses Whisper through Transformers.js with CPU/GPU paths. | [whisper.cpp](https://github.com/ggml-org/whisper.cpp) is an alternative native runtime. | Already uses Whisper. Switch runtimes only after comparing accuracy, timing, timestamps, memory and shared-GPU contention on this machine. | Keep / benchmark optional |
| Uploaded video understanding | [lib/server/extract/index.ts](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/lib/server/extract/index.ts#L275) combines FFmpeg frames and audio transcription. | Keep FFmpeg and Whisper; improve frame selection and model evidence handling. | Already built on established tools. Neither transcription nor a handful of frames guarantees full video understanding; use appropriate coverage and report missing evidence. | Keep / improve |
| Web video and YouTube captions | [lib/web-search/youtube.ts](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/lib/web-search/youtube.ts) uses youtubei.js and caption fallbacks; media-captions.ts explicitly does not run Whisper on remote videos. | [yt-dlp](https://github.com/yt-dlp/yt-dlp) is an optional media/subtitle adapter. | Deferred because web search is out of scope for changes. yt-dlp is not a video-understanding model or universal access guarantee. Keep clear separation from uploaded-file transcription. | No change now |
| ZIP generation and basic ZIP reading | [lib/three3d/zipWriter.ts](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/lib/three3d/zipWriter.ts#L32) handwrites ZIP headers/CRC; [lib/server/extract/zip.ts](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/lib/server/extract/zip.ts#L13) handreads ZIP structures. | [fflate](https://github.com/101arrowz/fflate), already in package.json and used by powerbiEngine.ts. | Concrete duplication. Consolidate suitable paths onto the installed dependency, preserving output compatibility and decompression limits. Keep 7-Zip fallback for formats/features the library does not cover. | High value, small scope |
| Other archives and uncommon formats | [lib/server/extract/archives.ts](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/lib/server/extract/archives.ts) already uses 7zip-bin/node-unrar-js and system compression helpers. | Keep the existing tools and bounded extraction wrapper. | Do not replace a mature decoder with more hand-written format parsing. Extraction limits and recursive archive policy remain application responsibilities. | Keep |
| Skills installation and lazy loading | [lib/skills/registry.ts](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/lib/skills/registry.ts#L7) uses npx skills; scenario/loading behavior is custom. | [Vercel skills](https://github.com/vercel-labs/skills), already used. | Keep the installer integration. Lazy loading, visible/core skill separation and activation metadata are Ruke features worth preserving. | Keep |
| External tool protocol | The browser supports page-declared WebMCP; the inventoried main dependencies do not show a general MCP client. | [Official MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk). | Add only when connecting external tool servers, including Playwright MCP if selected. Page WebMCP and an MCP client are different integrations; avoid a new custom transport protocol. | With selected integration |
| Title generation and inference scheduling | [lib/server/titles/queue.ts](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/lib/server/titles/queue.ts#L2) prioritizes active chat over queued title inference; Rust has corresponding scheduling support. | Keep the focused queue and shared inference ownership. | A Redis-backed queue would add infrastructure without automatically preserving single-model scheduling. Replace only if durable distributed jobs become a real requirement. | Keep |
| Logging, automated tests and model evaluations | Pino, Rust tracing, Vitest and Playwright are already present; the repository includes extensive fixtures and regression scripts. | Local [Promptfoo](https://github.com/promptfoo/promptfoo) with existing Vitest/Playwright tests. | Keep existing tests. Add repeatable end-to-end scoring against the local model. Do not require paid judge models or a new hosted dashboard. A self-hosted tracing platform can be evaluated later if its infrastructure is justified. | Evaluations high value |
| Voice UI and multi-user accounts | [components/ChatInput.tsx](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/components/ChatInput.tsx#L425) identifies inert voice placeholders; [lib/user.ts](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/lib/user.ts#L1) supplies a display name. | No existing working voice-input or account system was established by these components; [Better Auth](https://github.com/better-auth/better-auth) is a future account option. | These are scope clarifications, not components currently being reinvented. Audio attachment transcription is a separate implemented feature. | Future only |
| Web search | Existing TypeScript search adapters, extraction, research loop, citations and research journal. | No replacement proposed in this revised audit. | Leave the search implementation and provider configuration unchanged as requested. Browser migration must not silently reroute ordinary search through the interactive browser. | Locked out of changes |

## 3D and CAD scope decision

The inspected [CAD schema](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/lib/cad/cadSchema.ts#L4) describes a floor-plan/blueprint representation with extruded previews. This is not evidence of an AutoCAD-level architecture-design application. Under the user's condition, **built-in CAD is removed from the core plan**, alongside built-in 3D generation, scene construction, viewers/editors and associated exports.

This does not claim that full CAD can never be integrated. It means the current system has not demonstrated the required capability, and building another CAD application is outside this implementation. Keep independent 2D charts, diagrams and SVG illustrations.

**Future direction: external Blender over MCP.** No server is selected or installed by this plan. First review an appropriate local open-source server's license, supported operations, cross-platform packaging and resource behavior. Integrate available tools with the existing main model and artifact cards when that separate feature is requested. Do not rebuild a 3D studio or bundle Blender into ordinary chat startup.

Implementation must trace lib/three3d/, lib/cad/, affected renderer fences/modes, API routes, skill activation metadata, configuration, styles, tests and shared imports. Preserve saved conversations, user files and existing artifacts. Remove dependencies only after confirming retained features do not need them.

### Existing generated-code retirement and isolation

1. [lib/three3d/codeRunner.ts](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/lib/three3d/codeRunner.ts#L46) uses `new Function`, called in the live client by [components/render/ThreeStudioViewer.tsx](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/components/render/ThreeStudioViewer.tsx#L214). This does not create a security boundary. [MDN’s Function documentation](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Function/Function) establishes that dynamically constructed functions execute with access to the global scope.
2. [components/render/HtmlArtifactBlock.tsx](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/components/render/HtmlArtifactBlock.tsx#L142) combines `allow-scripts` and `allow-same-origin` on generated `srcDoc`. [MDN’s iframe documentation](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe) specifically warns about that combination for same-origin content.

The first execution path is retired with built-in 3D. The retained generated-HTML feature still requires actual origin/process isolation and narrowly defined messages. These are source-established concerns, not claims that an exploit was executed.

## Presentations, spreadsheets and documents

PPT is an example where replacing the whole dependency would waste more work. Ruke already uses a reputable open-source generator.

[lib/documents/pptxEngine.ts](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/lib/documents/pptxEngine.ts#L101) currently renders charts to PNG. [PptxGenJS already exposes addChart](https://gitbrent.github.io/PptxGenJS/docs/api-charts.html), so native editable charts can be implemented using the existing dependency. Keep special visual designs as images when appropriate. Test the exported file in a presentation application; a successful ZIP build does not prove the slide is correct.

The morph injector is a different capability. A replacement must preserve required transitions; no verified ready-made substitute for that custom behavior was established here. LibreOffice can help with opening/conversion and visual checks, but it cannot establish complete PowerPoint animation fidelity.

[lib/documents/xlsxEngine.ts](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/lib/documents/xlsxEngine.ts#L9) already uses ExcelJS, while [lib/documents/recalc.ts](https://github.com/saikiran121111/WebUI/blob/c115256155ce21887633bca5965aeeb880bfe6d1/lib/documents/recalc.ts#L16) implements formula calculation separately. Use a local LibreOffice calculation/conversion worker when broader calculation support is needed. Preserve formula strings and cached values, and test real reference workbooks. LibreOffice is not identical to Excel.

HyperFormula’s [published license](https://github.com/handsontable/hyperformula/blob/master/LICENSE.txt) offers GPLv3 and proprietary options. It is not the unconditional default for this plan; choosing a GPL-compatible integration remains possible, but a recommendation should not quietly depend on purchasing the proprietary option.

For Word/PDF output, keep the current docx and Chromium printing libraries. Use the MIT-licensed Docling parser on demand behind the existing extraction interface. Run it locally with prefetched model assets and verify each selected model license. [Docling license](https://github.com/docling-project/docling/blob/main/LICENSE), [offline configuration](https://docling-project.github.io/docling/usage/advanced_options/#model-prefetching-and-offline-usage).

## Free-only shortlist and operating cost

These recommendations refer to the open-source/local software, not vendor-hosted products bearing the same names.

| Component | License/source checked | Required subscription or vendor quota in selected local setup? | Machine/operation tradeoff |
|---|---|---|---|
| agent-browser | Apache-2.0 | No | Browser processes still consume RAM/CPU; the local model is separate. |
| Playwright MCP | Apache-2.0 | No | Local Node/browser process plus Ruke integration. |
| PptxGenJS / ExcelJS / docx | Existing open-source dependencies; retain pinned releases and license files | No | Local file generation; visual QA still needed. |
| LibreOffice | [MPL-2.0 distribution with other component licenses](https://www.libreoffice.org/licenses/) | No | Larger local install; start worker only when needed. |
| Apache ECharts | [Apache-2.0](https://github.com/apache/echarts/blob/master/LICENSE) | No | Local rendering and server SVG support. |
| Docling | MIT core with separately licensed model assets | No | On-demand local document processing with prefetched weights. |
| Transformers.js / Whisper integration | Existing runtime/model setup | No paid endpoint required | CPU/GPU and model storage; check exact pinned weights. |
| whisper.cpp | MIT | No | Alternative native runtime; output/performance must be compared. |
| fflate | MIT; already installed | No | No additional service required. |
| SQLite FTS5 / sqlite-vec | Public-domain SQLite / Apache-2.0 or MIT sqlite-vec | No | Local storage and extension integration; sqlite-vec is still pre-v1. |
| assistant-ui / AI SDK | MIT / Apache-2.0 core | No | Optional libraries, not required hosted services; use the local model endpoint. |
| MCP SDK | Check pinned major; current TypeScript v2 is Apache-2.0 | No | Tool-server process management and protocol integration. |
| Promptfoo | MIT local tooling | No | Evaluations use model compute; keep grading local/deterministic. |

Open-source licenses still impose conditions. Keep notices and review the exact distribution model before bundling applications or modifying copyleft components. This audit is not a complete legal review of transitive dependencies.

No fixed RAM or speed improvement is claimed for a proposed migration. Measure the entire process tree, including the local model, browser, retained document/OCR workers and any optional environment overhead. The current plan does not install or launch a CAD/3D engine.

For the consumer-laptop baseline, account for Windows, shared integrated-graphics memory and the local language/vision model before starting optional workers. Run one heavy job at a time, preserve ordinary chat/browser responsiveness, and reduce work or report a resource limit before excessive paging or an out-of-memory failure. A program fitting by itself does not prove the complete Ruke stack fits. This revision did not benchmark a 16 GB/i5-class machine.

## Implementation boundaries and validation order

### Stage 1: browser observations and maintained-driver evaluation

Keep the normal web-search routes and provider code unchanged. Introduce one internal driver boundary for navigation, observations, actions, screenshots, tabs and lifecycle. Implement one pilot driver first; avoid maintaining multiple production stacks indefinitely.

Preserve current user-facing tools where practical, mapping them to the upstream driver. Return structured, actionable failures. Keep session identity server-owned; never trust a caller-supplied session string as authorization. Continue human login inside the actual browser. Never claim a CAPTCHA or authentication wall was solved when it was not.

The model must receive real observations, choose actions and verify outcomes. Standard browser mechanics such as stale-ref checks, session separation and cancellation are useful resources; they should not be replaced by a hardcoded website list.

Before choosing the driver, run both the current implementation and the pilot against the same local tasks and model settings:

| Scenario | Required evidence |
|---|---|
| Link/form task on a normal page | Correct final page state and submitted field values, not just a tool success string. |
| Visual-only control/canvas task | Screenshot reaches the model; action matches actual image coordinates. |
| Dynamic page after navigation | Fresh observations and refs; stale targets fail safely and recover. |
| Duplicate labels and hidden controls | Correct intended element; ambiguous matches are surfaced. |
| Multi-tab task | Correct target tab before each action; foreground changes do not redirect work. |
| Two conversations | No cross-conversation tab/control/state leakage. |
| Human sign-in and resume | Same browser session remains usable after login; completion verified by reading the page. |
| Slow loading and redirect | Bounded waits and correct final URL/state; no fabricated success. |
| Downloads/uploads/file chooser | Explicit capability coverage, correct artifact and preserved application controls. |
| Manual intervention | Human input takes effect; model re-observes changed state before continuing. |
| Stop, disconnect and browser crash | Prompt cancellation, useful failure, no unintended resumed task or orphan process tree. |
| Long page/large DOM | Targeted or paginated reads preserve the needed evidence instead of silently cutting it away. |
| Full live preview | Correct pixel scaling, fresh frames and reconnect behavior; no old-frame backlog. |
| Task completion | A final observation proves the requested outcome; tool-call completion alone is insufficient. |

Record completion rate, wrong actions, recovery rate, latency, tokens and full process-tree resource use. Run model-driven Playwright tests serially under the repository’s existing inference lock. This audit did not run that benchmark.

### Stage 2: retire built-in 3D and CAD coherently

Remove the built-in studio/viewer/generation/drafting paths, their advertised model capabilities and unused dependencies. Trace shared imports and update contracts/tests before deletion. Preserve existing conversation content and artifact files; provide an honest compatibility view for retired fences.

Verify the retained chat, browser, Office, HTML, chart and independent 2D illustration features still work, and that a normal installation no longer requires a 3D/CAD application. Future Blender MCP connectivity is a separate feature and must not be implemented as an automatic replacement during this cleanup.

### Stage 3: document improvements and consolidation

Use PptxGenJS native charts, an on-demand LibreOffice worker where needed, ECharts for chart rendering, fflate for compatible ZIP paths and Docling for richer input parsing. Make each independently reviewable and compare representative old/new outputs.

Keep browser delivery, document formats, model messages and normal search working during each stage. Only remove old code after imports/feature paths and relevant tests show it is truly superseded. TS/Rust compatibility implementations are not automatically dead code.

### Stage 4: only justified supporting changes

Consider SQLite retrieval consolidation, isolated assistant-ui primitives or AI SDK integration only for a demonstrated need. Current AI SDK package metadata requires version compatibility checks (for example current core Node/Zod peers); do not make a major framework migration incidental to a browser fix.

Keep local inference scheduling, user skill laziness, recents, storage and the existing Markdown/math/diagram libraries. A gateway, Redis service or observability platform is not required to make the shortlisted tools work.

## What is established and what remains unproven

Established by source: the screenshot omission path; custom formula evaluator; duplicate custom ZIP code despite an existing dependency; separate handwritten chart renderers; existing Office/Three.js reuse; Meshy-only asset provider; simple floor-plan CAD schema; the two generated-code isolation issues.

Not established here: that an alternative completes more tasks than Ruke on the configured model; a performance/RAM win; complete PowerPoint format fidelity; a measured 16 GB consumer-laptop resource fit; or ChatGPT-level browser success. Those require the targeted integration and comparisons described above.

No application source was modified and no replacement was installed.
