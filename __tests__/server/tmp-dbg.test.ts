import { describe, expect, it } from "vitest";
import { measureContentCoverage, mergeOfficeText, stripReaderArtifacts, type CapabilityDoc } from "../../lib/server/extract/document-capability";
const base = { kind: "xlsx", engine: "ruke-ml xlsx reader", unitsTotal: 1, unitsSucceeded: [1], unitsEmpty: [], unitsFailed: [], unitsNeedingOcr: [], ocrUnits: [], complete: true, note: "", units: [], rendered: [], ocr: { ran: false, attempted: 0, recognized: 0, language: "", summary: "", reason: "engine not executable here", needsLanguage: false }, meta: {} } as unknown as CapabilityDoc;
describe("dbg", () => {
  it("prints", () => {
    const tsText = ["A1=(shared string #99 missing)\tA2=only string\tA3=#REF!","B1=[formula continuation; expression not stored in this cell]"].join("\n");
    const capText = ["### cells this reader could NOT read: A1: shared-string index 99 out of range (sheet Torn); A3: stored error type value (sheet Torn) - reported by reference and reason; they are NOT blank and NOT zero","A2=only string"].join("\n");
    console.log("STRIP", JSON.stringify(stripReaderArtifacts(tsText)));
    const c = measureContentCoverage(tsText, capText);
    console.log("COVERAGE", JSON.stringify(c));
    const m = mergeOfficeText(tsText, { ...base, rendered: [{ unit: 1, text: capText, provenance: "text-layer", engine: "ruke-ml xlsx reader", blocks: 1, truncated: false }] });
    console.log("NOTE", m.coverageNote);
    expect(true).toBe(true);
  });
});
