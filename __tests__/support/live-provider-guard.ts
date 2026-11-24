/**
 * F48 hermeticity guard: no vitest process may talk to the OPERATOR'S LIVE
 * model server, for either a generation (POST .../completions) or a lifecycle
 * (POST /unload, POST /load) call.
 *
 * WHY THIS EXISTS, AND WHY IT IS A TEST GUARD AND NOT A PRODUCTION BRANCH
 * -----------------------------------------------------------------------
 * The F46/F47 audit read two "connect ECONNREFUSED 127.0.0.1:8080" lines in
 * docs/overnight/logs/f45-gates-1.log and concluded that vitest was issuing
 * completions against the shared capacity-1 endpoint. That conclusion was
 * WRONG, and it mattered: it was being used to justify a production deny-path
 * inside upstream-bridge. Re-checked against the sources of those log lines:
 *
 *  1. "[PARSER] error: TypeError: fetch failed: ECONNREFUSED ..." comes from
 *     __tests__/stream-terminal-ownership.test.ts, the "a transport failure is
 *     an ERROR, never a silent success" case, which stubs fetch to throw that
 *     exact string. Nothing left the process.
 *  2. "WARN (titles): title model call failed  err: connect ECONNREFUSED ..."
 *     is planTitle's own catch logging the message thrown by the INJECTED fake
 *     in __tests__/titles/title-generation.test.ts ("model call throwing (server
 *     down) resolves null and never throws").
 *  3. The second "(titles)" WARN, err "This operation was aborted", is the
 *     already-aborted-signal case, which rejects before fetch (now asserted with
 *     a zero-request spy in that same file).
 *
 * So there was no leak, and no production deny-path shipped - it would have
 * added a branch for a defect nobody has, and could have masked the two
 * transport-failure tests above. What IS true is weaker and still worth fixing:
 * the suite was hermetic only BY ACCIDENT. A test that uses the real transport
 * and relies on the operator endpoint being unreachable, or a future refactor
 * that drops an injected fake, would wake or occupy the very model that hosts
 * the coding session (capacity 1, shared with Codex). The honest fix is an
 * OBSERVING test-harness guard that fails the run when a live call is
 * attempted. The lifecycle half of this was production-hardened in D-067;
 * with F123 the Node ASR stage is gone and the law lives where the unload
 * decision happens now — the Python handoff policy (ruke_ml/handoff.py).
 *
 * This file is only the vitest wiring. The decision itself - which endpoint is
 * the operator's, which paths are protected, what counts as a test double -
 * lives in live-provider-guard-core.ts and is covered by
 * live-provider-guard.test.ts, so the guard's own logic is not trusted blindly.
 *
 * LIMITATIONS, STATED RATHER THAN HIDDEN
 * --------------------------------------
 * - A test file that replaces globalThis.fetch (vi.stubGlobal, vi.spyOn, direct
 *   assignment) AFTER this guard installs is no longer observed by it - the
 *   desired case, because its transport is a fake. Tearing that stub down puts
 *   the wrapper back, since the double captured the wrapper as its original, so
 *   observation resumes for the rest of the file.
 * - If fetch is ALREADY a double before this guard installs (module-scope stub),
 *   the guard cannot tell a canned response from a real socket and declines to
 *   wrap that file, rather than flagging fixtures that merely name port 8080.
 * - Only POST on the operator origin is judged; /health probes are read-only.
 * - The guard observes, it does not block: the live request still goes out, and
 *   the suite then fails. Blocking it instead would change what the code under
 *   test does and could hide a real transport path.
 *
 * Escape hatch for a deliberately live, ATTENDED check: RUKE_ALLOW_LIVE_PROVIDER=1.
 */

import { afterAll, beforeAll } from "vitest";
import { resourceKey } from "../../lib/server/resource-identity";
import {
  looksLikeTestDouble,
  makeObservingFetch,
  operatorEndpointFromDisk,
} from "./live-provider-guard-core";

const endpoint = operatorEndpointFromDisk();
const operatorResource = resourceKey(endpoint.url);

const ALLOW_LIVE = process.env.RUKE_ALLOW_LIVE_PROVIDER === "1";
const violations: string[] = [];
let restoreFetch: (() => void) | undefined;

beforeAll(() => {
  if (ALLOW_LIVE) return;
  const previous = globalThis.fetch;
  if (looksLikeTestDouble(previous)) return;
  globalThis.fetch = makeObservingFetch(previous, operatorResource, endpoint.source, violations);
  restoreFetch = () => {
    globalThis.fetch = previous;
  };
});

afterAll(() => {
  restoreFetch?.();
  restoreFetch = undefined;
  if (violations.length) {
    throw new Error(
      `hermeticity: ${violations.length} request(s) reached the operator's live model ` +
        `server from a test process:\n  - ${violations.join("\n  - ")}\n` +
        "Point the caller at a fake (inject callModel, stub fetch, or set a mock " +
        "LLM_API_URL in process.env), or run the attended live check with " +
        "RUKE_ALLOW_LIVE_PROVIDER=1.",
    );
  }
});