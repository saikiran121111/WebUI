import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file") as File | null;
    if (!file) return NextResponse.json({ error: "No file" }, { status: 400 });

    const bytes = Buffer.from(await file.arrayBuffer());
    const { execSync } = await import("child_process");

    // pdftotext writes to a temp path; we capture stdout with - option.
    const result = execSync("pdftotext - -layout --quiet", {
      input: bytes,
      encoding: "utf-8",
      timeout: 30000,
    });

    return NextResponse.json({ text: result, pages: (result.match(/\f/g)?.length ?? 0) + 1 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "PDF extraction failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
