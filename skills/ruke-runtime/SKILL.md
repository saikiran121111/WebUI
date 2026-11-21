---
name: ruke-runtime
description: Trace Ruke requests across the Next.js UI, Rust Axum server, Python ML workers and shared Strata model. Use for architecture, feature changes and performance work.
---

Start at the live caller. scripts/dev-supervisor.mjs sets RUKE_RUST_BACKEND for Next. Check that switch, ruke-server/src/lib.rs (under rust-backend/crates/) and the retained app/api route before choosing an owner. Scope Rust tests to the affected crate. Use docs/overnight/DECISION-OWNERSHIP.md for ownership questions and verify against current code.

- Chat and progress. Trace hooks/useChat.ts through lib/chat, lib/stream and lib/progress to ruke-server/src/chat. Preserve event ordering, content/reasoning separation, cancellation and bytes pinned by rust-backend/fixtures. Check transport and actual visible completion.
- Web search and browser use. Rust chat orchestrates tool calls. Retrieval lives in lib/web-search behind lib/server/web-tools-rpc.ts. Browser execution lives in ruke-browser (Chromium/CDP). Check tool permissions, source isolation and bounded retries. Keep model choices separate from deterministic authorization.
- Attachments. Trace lib/server/extract and lib/server/attachindex plus ruke-attach, then ruke-server ML jobs into python-backend/ruke_ml. The Python 3.12 supervisor starts lightweight. Heavy OCR, speech and video jobs report capability, evidence, resource refusal and cancellation. Check transcript timestamps against the requested media segment.
- Strata. Read lib/server/coordination/llm-lease.ts, ruke-core/src/admission.rs and ruke_ml/handoff.py together when changing shared capacity. Test ownership, stale state, bounded memory, restoration and a subsequent chat turn. Use offline fixtures during development.
- Conversation state. Follow lib/persistence through app/api/conversations, disk and merge helpers. Verify save errors reach the UI and stale saves preserve protected titles. Check reload, concurrent saves and per-conversation research state.
- Documents. For resume generation follow app/api/documents/resume, lib/documents/resumeHtml.ts and components/render/ResumeBlock.tsx. For HTML preview check HtmlArtifactBlock.tsx and lib/render/htmlSrcDoc.ts. Preserve iframe isolation and verify reopen/export. Honor feature deferrals in the active brief.
- Performance. Measure the affected resource on the normal path, e.g. first visible stream content, render cadence, worker peak memory or model restore time. Compare identical inputs and check output fidelity before accepting a speedup.
