/**
 * F01 (brief 2026-11-15) — the ONE standing response policy.
 *
 * Reproduced user-visible symptom: a bare "what are you doing?" came back as a
 * long capability advertisement. The audit found no canned template in the
 * production prompt: the verbosity came from the model's own prior plus the
 * *tool* law block, which is written entirely in research vocabulary and says
 * nothing about how long an ordinary answer should be. So the fix is one
 * short, application-owned block injected into every model-visible turn — not
 * a greeting whitelist, not a canned "idle" reply, not a fixed sentence count,
 * and not an extra rewrite call per answer.
 *
 * Byte-parity law: `crates/ruke-server/src/chat/policy.rs` carries the same
 * bytes. The Rust unit test reads THIS file and asserts containment, so the
 * two prompts cannot drift silently.
 */

export const RESPONSE_POLICY_HEADER = "RESPONSE POLICY FOR THIS ASSISTANT:";

const LINES: readonly string[] = [
  "- Answer the request that was actually made, at the depth it asks for: a short question gets a short, direct answer; an explicit request for detail, comparison or steps gets the detail.",
  "- Ordinary small talk and status questions stay brief and natural. Do not convert them into a report, a plan, or a list.",
  "- Do not advertise capabilities, tools, integrations or services unless the human asks what you can do or what is available.",
  "- Never describe work that is not actually happening: no claimed searches, files, background jobs, indexing or progress that did not run.",
  "- If something is not possible here, say so plainly in one line instead of replacing it with a broader offer.",
];

export const RESPONSE_POLICY = [RESPONSE_POLICY_HEADER, ...LINES].join("\n");