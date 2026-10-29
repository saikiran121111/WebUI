//! OWNER: W4 — DEAD-MODULE PROOF, not a port (fixtures/README.md discovery #3).
//!
//! `lib/web-search/vision-prepass.ts` exports `runVisionEntityPrepass` which
//! has ZERO call sites in the shipped TS app: the "Vision-to-Search entity
//! pre-pass" advertised in the comment at `app/api/chat/route.ts` (and in
//! query-planner docs) NEVER RUNS. Image parts still feed
//! `SearchGateContext.hasImageAttachment`/`imageDataUrls` (arming the
//! Stage-0 image-intent bypass) but no vision LLM call is ever made and
//! `entityHints` are always `undefined` into `planQueries`.
//!
//! The parity behavior is therefore: DO NOT CALL any vision pre-pass. That
//! is pinned by the frozen golden corpus (`__tests__/rust-golden/web.test.ts`
//! header + fixture `01-search-success-progress.json` notes: "Vision pre-pass
//! NEVER RUNS") and re-verified for this port pass by a repo-wide grep of
//! `runVisionEntityPrepass` (definition site only). Nothing to port; the TS
//! source stays where it is (Part 8 deletes no TS). If the feature is ever
//! wired up live, its Rust twin lands here at that time.
