/**
 * F153 OCR/crop graders (2026-11-24 audit, repairs 4 + 5).
 *
 * Repair 4 — "'OCR ran' can pass as 'OCR recovered the label.'" The live spec
 * previously (a) found the durable record by searching SERIALIZED JSON for the
 * source SHA anywhere (a record merely MENTIONING the sha in a detail string,
 * a limitations note, or another file's identity passed as "this file's OCR"),
 * (b) graded recovery by searching SERIALIZED units, so the label appearing in
 * a unit's bbox metadata, detail text, raster dict or provenance field counted
 * as "recognised", and (c) ONE verdict blended "the engine inspected the
 * region" with "the engine read the label", so the 0/1-recognised live run —
 * engine ran, returned nothing, the model answered from pixels — passed P4 by
 * claiming OCR had recovered what it had not.
 *
 * The law here:
 *  - OCR EXECUTION is graded from structured fields only: the record whose
 *    source.sha256 EQUALS the fixture sha (never a substring of the whole
 *    serialization), correlating by job_id/written_at; the adapter from
 *    pipeline.primary_engine / pipeline.engines_used; the region unit's state;
 *    the invocation counts. The durable-record-absent channel is the region
 *    report: probe passes >= 1 AND engine calls >= 1 with the states tally
 *    covering every region — inspected AND engine-evidenced.
 *  - OCR RECOVERY reads the unit's TEXT FIELD (recognized text), for the
 *    region's unit, and requires the FULL printed label (digit included) from
 *    a PRODUCING engine (unit.engine non-empty, state recognised). Metadata
 *    matches fail.
 *  - The two verdicts are reported separately and a recovery FAIL is a
 *    RECORDED FACT, never a reason to fail the visual journey: "vision label
 *    PASS; OCR execution PASS; OCR recovery FAIL." preserves all three facts
 *    and keeps the usable visual usable.
 *
 * Repair 5 — "the final request" was every request pooled. The grader reads
 * the ANSWERING request (the last one the proxy captured — __reset scopes the
 * capture to this turn), correlates it to the turn by this turn's prompt
 * text, and demands the crop hash in the CURRENT-USER content (the last user
 * message), where the uploaded attachment lives. Negative controls (proven in
 * __tests__/f152-ocr-grader.test.ts): a crop present ONLY in history, or ONLY
 * in a different request, FAILS.
 *
 * Pure Node (node:crypto), no fs: the spec reads the files, the grader grades.
 * Negative controls: __tests__/f152-ocr-grader.test.ts.
 */
import crypto from "node:crypto";

const normalize = (s: string) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");

export interface OcrRecordUnit {
  page?: number; state?: string; text?: string; detail?: string;
  engine?: string; lines?: unknown; raster?: unknown; provenance?: string;
}
export interface OcrRecord {
  job_id?: string; written_at?: string;
  source?: { sha256?: string; size_bytes?: number; hash_basis?: string };
  pipeline?: { primary_engine?: string; engines_used?: string[]; fallback_ran?: boolean };
  units?: OcrRecordUnit[];
  coverage?: { requested?: number; read?: number; complete?: boolean };
}
export interface OcrRecordEntry { name: string; body: OcrRecord }

/** Structured selection by source identity: the record's OWN source.sha256
 *  must equal the fixture sha. A record that carries the sha anywhere else
 *  (a detail note, a limitation string, a nested path) describes a DIFFERENT
 *  source and must never be found by this search. */
export function selectRecordsForSource(entries: OcrRecordEntry[], sha: string): OcrRecordEntry[] {
  return entries.filter((e) => e.body?.source?.sha256 === sha);
}

export interface RegionReport {
  recognised: number; total: number; states: string;
  probePasses: number; engineCalls: number;
}

/** "N/M region(s) recognised; states {...}; probe passes P, engine calls E"
 *  (documents/document_jobs.py spine summary, F152 region report). */
export function parseRegionReport(spine: string): RegionReport | null {
  const m = /(\d+)\/(\d+) region\(s\) recognised; states \{([^}]*)\}; probe passes (\d+), engine calls (\d+)/
    .exec(spine ?? "");
  if (!m) return null;
  return {
    recognised: Number(m[1]), total: Number(m[2]), states: m[3],
    probePasses: Number(m[4]), engineCalls: Number(m[5]),
  };
}

export interface ExecutionVerdict {
  ok: boolean;
  channel: "durable-record" | "region-report" | "none";
  adapter: string;
  invocations: number;
  regionState: string;
  correlation: string;
  reasons: string[];
}

/** OCR EXECUTION: did an adapter actually run on this file's region, per the
 *  structured durable record (preferred) or the region report (the durable
 *  channel when the engine ran and returned EMPTY — cascade units persist
 *  only recognised regions, current-code contract). Recovery is NOT graded
 *  here; that is gradeOcrRecovery's job.
 *  regionUnit: the unit id inside the region id "pdf:{unit}:{part}". */
export function gradeOcrExecution(input: {
  records: OcrRecordEntry[]; report: RegionReport | null;
  sourceSha: string; regionUnit: number;
}): ExecutionVerdict {
  const reasons: string[] = [];
  const selected = selectRecordsForSource(input.records, input.sourceSha);
  if (selected.length === 0) {
    const r = input.report;
    if (!r) {
      return {
        ok: false, channel: "none", adapter: "", invocations: 0, regionState: "",
        correlation: `no durable record whose source.sha256 equals ${input.sourceSha.slice(0, 12)} (structured selection, not a serialized-JSON search)`,
        reasons: ["no durable OCR record for this source AND no region report on the persisted spine: the region was never engine-evidenced"],
      };
    }
    const stateSum = [...r.states.matchAll(/: (\d+)/g)].reduce((s, x) => s + Number(x[1]), 0);
    if (r.probePasses < 1) reasons.push(`region report shows ${r.probePasses} probe passes: the region was never inspected`);
    if (r.engineCalls < 1) reasons.push(`the engine never ran (states ${r.states}, engine calls 0): a skipped region is not engine evidence`);
    if (stateSum !== r.total) reasons.push(`states tally ${r.states} does not cover ${r.total} region(s)`);
    if (r.recognised > 0) reasons.push(`report claims ${r.recognised} recognised region(s) with no durable record for the sha: durable persistence is broken`);
    return {
      ok: reasons.length === 0, channel: "region-report",
      adapter: "cascade (report channel: cascade units persist only recognised regions)",
      invocations: r.engineCalls, regionState: r.states,
      correlation: `attachment spine of this run's persisted record: ${r.recognised}/${r.total} recognised`,
      reasons,
    };
  }
  // Multiple durable records for one source: the newest self-describes the run;
  // the correlation (job_id + written_at) is recorded for every candidate.
  const ordered = [...selected].sort((a, b) => String(a.body.written_at ?? "").localeCompare(String(b.body.written_at ?? "")));
  const rec = ordered[ordered.length - 1].body;
  const enginesUsed = (rec.pipeline?.engines_used ?? []).filter((e) => e && e !== "none");
  const unit = (rec.units ?? []).find((u) => u.page === input.regionUnit);
  const unitEngine = String(unit?.engine ?? "").trim();
  // Adapter evidence = engines ACTUALLY used; primary_engine is the policy
  // SELECTION and never stands in for a run.
  const adapter = enginesUsed.length ? enginesUsed.join(",") : (unitEngine && unitEngine !== "none" ? unitEngine : "");
  if (!adapter || adapter === "none") reasons.push("no adapter recorded: pipeline.engines_used empty and no unit engine (primary_engine alone is a selection, not a run)");
  const read = Number(rec.coverage?.read ?? 0);
  if (read < 1) reasons.push(`coverage.read ${read}: the record claims no unit was read`);
  const invocations = Math.max(read, enginesUsed.length);
  if (!unit) reasons.push(`record has no unit for region unit ${input.regionUnit}: the region itself is not evidenced`);
  else if (unit.state === "recognised") {
    if (!unitEngine || unitEngine === "none") reasons.push(`region unit state "${unit.state}" names no producing engine`);
  } else if (unit.state === "empty") {
    // A durable record for an engine-ran-empty region: execution ran, recovery
    // failed by definition — gradeOcrRecovery records that fact.
    if (!unitEngine || unitEngine === "none") reasons.push(`region unit state "empty" names no producing engine: "empty" must be engine-evidenced`);
  } else {
    reasons.push(`region unit state "${unit.state}" is not engine-evidenced (expected recognised|empty)`);
  }
  return {
    ok: reasons.length === 0, channel: "durable-record",
    adapter, invocations, regionState: String(unit?.state ?? ""),
    correlation: `job ${rec.job_id ?? "?"} written ${rec.written_at ?? "?"} (source.sha256 structured match${selected.length > 1 ? `, ${selected.length} candidates` : ""})`,
    reasons,
  };
}

export interface RecoveryVerdict {
  ok: boolean; verdict: "PASS" | "FAIL";
  recoveredText: string; engine: string; reasons: string[];
}

/** OCR RECOVERY: the recognized TEXT of the exact region's unit — read the
 *  text FIELD, never the serialized unit — contains the FULL printed label
 *  (digit included) and names a producing engine. This verdict is a FACT:
 *  the visual journey stands on execution + pixels, not on OCR. */
export function gradeOcrRecovery(input: {
  records: OcrRecordEntry[]; sourceSha: string; regionUnit: number; labelText: string;
}): RecoveryVerdict {
  const reasons: string[] = [];
  const selected = selectRecordsForSource(input.records, input.sourceSha);
  const rec = selected.length
    ? [...selected].sort((a, b) => String(a.body.written_at ?? "").localeCompare(String(b.body.written_at ?? "")))[selected.length - 1].body
    : null;
  const unit = rec ? (rec.units ?? []).find((u) => u.page === input.regionUnit) : undefined;
  const text = String(unit?.text ?? "");
  const engine = String(unit?.engine ?? "").trim();
  const full = normalize(input.labelText);
  if (!rec) {
    reasons.push("no durable OCR record for this source (structured selection): OCR produced no recognized unit to recover from");
  } else if (!unit) {
    reasons.push(`record has no unit for region unit ${input.regionUnit}: OCR recognised nothing for the region`);
  } else {
    if (unit.state !== "recognised") reasons.push(`region unit state "${unit.state}": the engine ran and returned no recognized text for the region`);
    if (!normalize(text).includes(full)) {
      reasons.push(`the unit's recognized text ${JSON.stringify(text.slice(0, 120))} does not contain the full label "${input.labelText}" (metadata mentions are not recognition)`);
    }
    if (!engine || engine === "none") reasons.push("no producing engine on the recognized unit");
  }
  return {
    ok: reasons.length === 0, verdict: reasons.length === 0 ? "PASS" : "FAIL",
    recoveredText: text, engine, reasons,
  };
}

/** The three facts, in the brief's order, preserved together. */
export function combineFacts(visionOk: boolean, executionOk: boolean, recoveryOk: boolean): string {
  const word = (ok: boolean) => (ok ? "PASS" : "FAIL");
  return `vision label ${word(visionOk)}; OCR execution ${word(executionOk)}; OCR recovery ${word(recoveryOk)}.`;
}

export interface CropDeliveryVerdict {
  ok: boolean;
  answeringIndex: number;
  requests: number;
  cropInCurrentUser: boolean;
  historyOnly: boolean;
  otherRequestOnly: boolean;
  cropShasSeen: string[];
  reasons: string[];
}

function pngParts(msg: any): { shas: string[]; text: string } {
  const parts = Array.isArray(msg?.content) ? msg.content : [];
  const shas: string[] = [];
  let text = "";
  for (const p of parts) {
    if (p?.type === "text" && typeof p.text === "string") text += p.text;
    if (p?.type === "text_part" && typeof p.text === "string") text += p.text;
    const url = p?.type === "image_url" ? String(p.image_url?.url ?? "") : "";
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(url);
    if (m) shas.push(crypto.createHash("sha256").update(Buffer.from(m[1], "base64")).digest("hex"));
  }
  if (!Array.isArray(msg?.content) && typeof msg?.content === "string") text += msg.content;
  return { shas, text };
}

/** Repair 5: correlate the crop to the ANSWERING request's CURRENT-USER
 *  content. The answering request is the LAST captured body (__reset scopes
 *  captures to this turn) and is tied to this turn by carrying this turn's
 *  prompt text in its last user message; the uploaded attachment's crop must
 *  ride that same current-user message. A crop found only in older history
 *  (a previous turn's message, an assistant echo) or only in a different
 *  captured request proves NOTHING about this turn's delivery — both fail. */
export function gradeCropDelivery(input: {
  bodies: any[]; cropSha: string; promptText: string;
}): CropDeliveryVerdict {
  const reasons: string[] = [];
  const bodies = input.bodies ?? [];
  const answeringIndex = bodies.length - 1;
  const cropShasSeen: string[] = [];
  const inRequest = (b: any) => {
    const found: string[] = [];
    for (const msg of b?.messages ?? []) found.push(...pngParts(msg).shas);
    return found;
  };
  for (const b of bodies) cropShasSeen.push(...inRequest(b));

  if (bodies.length === 0) {
    return {
      ok: false, answeringIndex: -1, requests: 0, cropInCurrentUser: false,
      historyOnly: false, otherRequestOnly: false, cropShasSeen,
      reasons: ["proxy captured no chat requests: crop proof impossible"],
    };
  }
  const ans = bodies[answeringIndex];
  const users = (ans?.messages ?? []).map((m: any, i: number) => ({ m, i })).filter((x: { m: any; i: number }) => x.m?.role === "user");
  const current = users.length ? users[users.length - 1] : null;
  if (!current) {
    reasons.push("answering request carries no user message: cannot locate the current turn's content");
  } else {
    const cur = pngParts(current.m);
    if (!cur.text.includes(input.promptText)) {
      reasons.push("the answering request's last user message does not carry this turn's prompt text: the request is not correlated to this turn");
    }
    const curHas = cur.shas.includes(input.cropSha);
    const others = (ans?.messages ?? [])
      .filter((_: any, i: number) => i !== current.i)
      .some((m: any) => pngParts(m).shas.includes(input.cropSha));
    const elsewhere = bodies
      .slice(0, answeringIndex)
      .some((b: any) => inRequest(b).includes(input.cropSha));
    if (curHas) {
      // delivered on the current-user content: the proof; history copies of
      // the same crop (multi-turn chats) do not cancel it.
    } else if (others) {
      reasons.push(`crop ${input.cropSha.slice(0, 12)} is ONLY in older history of the answering request, not in the current-user content`);
    } else if (elsewhere) {
      reasons.push(`crop ${input.cropSha.slice(0, 12)} is ONLY in a DIFFERENT captured request, not in the answering request's current-user content`);
    } else {
      reasons.push(`crop ${input.cropSha.slice(0, 12)} reached NO image part of the answering request`);
    }
  }
  const cropInCurrentUser = !reasons.some((r) => r.includes("ONLY") || r.includes("NO image part"));
  return {
    ok: reasons.length === 0, answeringIndex, requests: bodies.length,
    cropInCurrentUser,
    historyOnly: reasons.some((r) => r.includes("older history")),
    otherRequestOnly: reasons.some((r) => r.includes("DIFFERENT")),
    cropShasSeen, reasons,
  };
}
