/**
 * Adjudicated status of a claim or of a single source.
 *
 * The full web-verify ledger that produced these verdicts was removed on
 * 2026-10-22 — this single union stays so `CitationStatusMap` (the optional
 * per-source verdict surface) keeps parsing for older stored conversations.
 */
export type ClaimStatus = "verified" | "conflict" | "unverified" | "not-applicable";
