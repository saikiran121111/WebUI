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
