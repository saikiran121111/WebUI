/**
 * Public entry points for the Web Search & Research Engine.
 *
 * Import from here only — the individual module files are implementation
 * detail and their API may change without a breaking-changelog entry.
 */
export {
  runLfmGate,
  rulesBasedPlan,
} from "./lfm-gate";
export {
  metasearch,
  normalizeUrl,
  reciprocalRankFuse,
  type SearchPlan,
} from "./metasearch";
export {
  extractAll,
  extractUrl,
} from "./extractor";
export {
  rerank,
  buildBm25,
  bm25Score,
  chunkMarkdown,
  tokenize,
  type Bm25Index,
  type RerankHit,
} from "./reranker";
export {
  runWebResearch,
  evidenceBlock,
  buildMainModelContext,
  type EvidenceBundle,
  type PipelineProgress,
} from "./pipeline";
export {
  getCachedQuery,
  putCachedQuery,
  getCachedPage,
  putCachedPage,
  queryCacheKey,
  pruneExpired,
  closeCache,
} from "./cache";
export {
  fetchPage,
  fetchUrl,
  isSafeUrl,
  realisticHeaders,
  apiHeaders,
  tlsClient,
  closeTlsClient,
} from "./tls-client";
export {
  SearchDecisionSchema,
  type SearchDecision,
  type RawSearchResult,
  type EvidencePassage,
  type EvidencePacket,
  type LfmDecision,
  type LfmGateContext,
  type RankedResult,
} from "./types";
