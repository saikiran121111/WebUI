/**
 * I08 — notebook extraction contract (lib/server/extract/notebook.ts).
 *
 * The old reader ignored every v4 output MIME bundle, silently sliced
 * outputs at 2 000 chars, and crashed the whole file on one null cell.
 * These cases lock: outputs of every kind rendered (binary blobs LABELLED,
 * never dumped), truncation announced, malformed cells skipped without
 * killing the notebook, and v3 / non-JSON files producing honest diagnostics.
 * Nothing here ever EXECUTES notebook code — outputs are read exactly as
 * the file recorded them.
 */
import { describe, expect, it } from "vitest";
import { notebookText } from "../../lib/server/extract/notebook";

const nb = (o: unknown) => JSON.stringify(o);

describe("notebookText — I08 v4 output rendering", () => {
  const full = notebookText(nb({
    nbformat: 4,
    nbformat_minor: 5,
    cells: [
      { cell_type: "markdown", source: "# Title\nbody" },
      {
        cell_type: "code",
        execution_count: 7,
        source: ["print(", "'hi')"],
        outputs: [
          { output_type: "stream", name: "stdout", text: "hi\n" },
          { output_type: "stream", name: "stderr", text: "warn!\n" },
          {
            output_type: "error",
            ename: "ValueError",
            evalue: "bad value",
            traceback: ["Traceback...", "ValueError: bad value"],
          },
          {
            output_type: "execute_result",
            execution_count: 7,
            data: {
              "text/plain": "42",
              "image/png": "AAAA",
              "application/json": { "a": 1 },
              "text/html": "<table><script>EVIL()</script><tr><td>Revenue</td></tr></table>",
              "image/svg+xml": "<svg><circle/></svg>",
            },
          },
          {
            output_type: "display_data",
            data: { "application/vnd.plotly.v1+json": { "x": [1] } },
          },
        ],
      },
      { cell_type: "code", source: "", outputs: [] },
    ],
  }));

  it("cell headers carry kind + execution count; source joins across list chunks", () => {
    expect(full).toContain("### [markdown]");
    expect(full).toContain("# Title");
    expect(full).toContain("### [code] #In[7]");
    expect(full).toContain("print('hi')");
    expect(full).toContain("(empty cell)");
  });

  it("stream outputs label stdout/stderr and error outputs carry ename/value/traceback", () => {
    expect(full).toContain("--- output (stdout) ---\nhi");
    expect(full).toContain("--- output (stderr) ---\nwarn!");
    expect(full).toContain("--- output (error: ValueError: bad value) ---");
    expect(full).toContain("ValueError: bad value");
  });

  it("text/plain renders; base64 images are LABELLED with size, never dumped as text", () => {
    expect(full).toContain("42");
    expect(full).toContain("[image/png output: 4 chars of base64 — binary, not readable as text]");
    expect(full).not.toContain("\nAAAA\n");
  });

  it("HTML outputs are stripped to text and SAID to have been HTML (script bodies removed)", () => {
    expect(full).toContain("[HTML output — markup removed]");
    expect(full).toContain("Revenue");
    expect(full).not.toContain("EVIL()");
  });

  it("JSON passes through; SVG gets a labeled placeholder; unrecognized MIME is skipped openly", () => {
    expect(full).toContain("[JSON output]");
    expect(full).toContain('[JSON output]\n{"a":1}');
    expect(full).toContain("[SVG image output");
    expect(full).toContain("[application/vnd.plotly.v1+json output skipped — no text rendering for this MIME]");
  });

  it("oversized outputs truncate ANNOUNCED, never silently at 2000", () => {
    const big = "z".repeat(25_000);
    const t = notebookText(nb({
      nbformat: 4,
      cells: [{ cell_type: "code", source: "x", outputs: [{ output_type: "stream", name: "stdout", text: big }] }],
    }));
    expect(t).toContain("z".repeat(20_000));
    expect(t).toContain("…output truncated at 20000 chars of 25000 — the notebook stored more…");
  });
});

describe("notebookText — I08 honest failure modes", () => {
  it("invalid JSON is a diagnostic, not a crash", () => {
    expect(notebookText("{ broken json"))
      .toBe("[Notebook not readable: the file is not valid JSON. It may be truncated or corrupted.]");
  });

  it("valid JSON that is not an object says so", () => {
    expect(notebookText("5"))
      .toBe("[Notebook not readable: expected a JSON object, found something else.]");
  });

  it("null cells are counted and skipped — one bad cell must not sink the file", () => {
    const t = notebookText(nb({
      nbformat: 4,
      cells: [null, 42, { cell_type: "code", source: "still reads me", outputs: [] }],
    }));
    expect(t).toContain("[2 malformed cell(s) skipped]");
    expect(t).toContain("still reads me");
  });

  it("v3 notebooks declare the layout they were converted from", () => {
    const t = notebookText(nb({ nbformat: 3, worksheets: [{ cells: [] }] }));
    expect(t).toContain("[notebook format v3 — pre-v4 layout, converted best-effort]");
  });

  it("an empty cells array says there are no cells instead of returning '' silently", () => {
    expect(notebookText(nb({ nbformat: 4, cells: [] })))
      .toContain("[No cells found in this notebook]");
  });
});

describe("notebookText — F78 numbers keep the literal the file wrote", () => {
  // Built as RAW JSON TEXT: JSON.stringify in a test would round the number
  // BEFORE the reader ever sees it, hiding the very defect under test.
  const RAW = '{"nbformat":4,"cells":[{"cell_type":"code","execution_count":9,'
    + '"source":"metrics()","outputs":[{"output_type":"display_data",'
    + '"data":{"application/json":{"fold":7,"recall":0.639,"exact_id":9007199254740993},'
    + '"text/plain":"Fold metrics"}}]}]}';

  it("2^53+1 in a JSON output survives exactly; round-tripping values are untouched", () => {
    const t = notebookText(RAW);
    expect(t).toContain('"exact_id":9007199254740993');
    expect(t).not.toContain("9007199254740992");
    expect(t).toContain('"fold":7');
    expect(t).toContain('"recall":0.639');
  });

  it("protects every literal the double cannot carry, and leaks no placeholder", () => {
    const t = notebookText('{"nbformat":4,"cells":[{"cell_type":"code","execution_count":9007199254740993,'
      + '"source":"x = 12345678901234567890","outputs":[{"output_type":"execute_result",'
      + '"data":{"application/json":{"a":1e3,"b":1e400,"c":-0}}}]}]}');
    expect(t).toContain("#In[9007199254740993]");           // bare insertion (template)
    expect(t).toContain("x = 12345678901234567890");        // code source: string content
    expect(t).toContain('"a":1e3');                          // exponent token preserved
    expect(t).toContain('"b":1e400');                        // not Infinity, not dropped
    expect(t).toContain('"c":-0');
    expect(t).not.toContain("");                           // placeholders restored, never leaked
  });

  it("the F78 fixture delivers the plan facts through the production reader", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const fixture = path.join(process.cwd(), "docs", "overnight", "fixtures", "f78",
      "all-readers", "native", "exact.ipynb");
    if (!fs.existsSync(fixture)) throw new Error(`F78 fixture missing: ${fixture}`);
    const { extractFileFromPath } = await import("../../lib/server/extract");
    const r = await extractFileFromPath("exact.ipynb", fixture);
    expect(r.category).toBe("notebook");
    expect(r.text).toContain("9007199254740993"); // native-plan.json expected fact
    expect(r.text).toContain("0.639");
    expect(r.text).not.toContain("9007199254740992");
  });

  it("review-docs/results.ipynb answers its key through the production reader", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const fixture = path.join(process.cwd(), "docs", "overnight", "fixtures", "f78",
      "review-docs", "results.ipynb");
    if (!fs.existsSync(fixture)) throw new Error(`F78 fixture missing: ${fixture}`);
    const { extractFileFromPath } = await import("../../lib/server/extract");
    const r = await extractFileFromPath("results.ipynb", fixture);
    expect(r.category).toBe("notebook");
    // Source score and stored stdout are BOTH kept, unreconciled (0.81 vs 0.72).
    expect(r.text).toContain("score = 0.81");
    expect(r.text).toContain("--- output (stdout) ---\n0.72");
    // Structured output facts; execution counts visible for the "ran earliest" question.
    expect(r.text).toContain('"fold":7');
    expect(r.text).toContain('"recall":0.639');
    expect(r.text).toContain("#In[9]");
    expect(r.text).toContain("#In[3]");
    // The plot payload is base64, LABELLED and never decoded: the key says the
    // marker inside the image is not readable — the reader must not invent it.
    expect(r.text).toContain("[image/png output: 4116 chars of base64");
    // The exception and its key arrive verbatim.
    expect(r.text).toContain("KeyError: amber_partition");
  });

  it("a notebook that never executes anything stays a read: code is shown, not run", () => {
    // The reader's law: outputs are exactly what the file recorded. A cell whose
    // stored stdout DISAGREES with its source (results.ipynb: 0.81 vs 0.72)
    // must show both, unreconciled - proof nothing ran.
    const t = notebookText('{"nbformat":4,"cells":[{"cell_type":"code","execution_count":9,'
      + '"source":"score = 0.81\\nprint(score)","outputs":[{"output_type":"stream",'
      + '"name":"stdout","text":["0.72\\n"]}]}]}');
    expect(t).toContain("score = 0.81");
    expect(t).toContain("0.72");
  });
});
