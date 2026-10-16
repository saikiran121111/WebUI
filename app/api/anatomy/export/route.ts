import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { anatomySpecSchema } from "../../../../lib/anatomy/anatomySchema";
import { buildAnatomyFigure } from "../../../../lib/anatomy/anatomyBuilder";
import { pageHtml } from "../../../../lib/anatomy/kit/iso-kit";

/**
 * Server-side Anatomy exports. The request carries the same fence JSON the
 * client validated; it is re-validated here (never trust the wire), built by
 * the same deterministic builder, and returned as a file:
 *  - html: standalone page (plate + embedded liveSpec + inlined live engine)
 *  - tsx:  self-contained React component for reuse in another WebUI app
 * The live engine is read from disk and stripped of its `export` keyword —
 * the same inlining pattern the upstream kit uses — so the page needs no bundler.
 */
const exportRequestSchema = z.object({
  spec: anatomySpecSchema,
  theme: z.enum(["dark", "light"]).default("dark"),
  kind: z.enum(["html", "tsx"]),
}).strict();

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }

  const parsed = exportRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Anatomy spec did not validate.", issues: parsed.error.issues.slice(0, 8) }, { status: 400 });
  }
  const { spec, theme, kind } = parsed.data;

  let figure;
  try {
    figure = buildAnatomyFigure(spec);
  } catch {
    return NextResponse.json({ error: "Anatomy spec could not be drawn." }, { status: 422 });
  }

  if (kind === "tsx") {
    const tsx = buildTsxComponent(figure.plate, figure.liveSpec, theme);
    return fileResponse(tsx, "text/plain; charset=utf-8", `${figure.filename}.tsx`);
  }

  const engineSource = await readLiveEngine();
  if (!engineSource) return NextResponse.json({ error: "Live engine unavailable." }, { status: 500 });

  const specJson = JSON.stringify(figure.liveSpec).replace(/</g, "\\u003c");
  const pageBody = `<div data-anatomy-root>${figure.plate}</div><script type="application/json" id="anatomy-spec">${specJson}</script>`;
  const script =
    `${engineSource}\n\n` +
    `const spec = JSON.parse(document.getElementById("anatomy-spec").textContent);\n` +
    `mountAnatomyLive(document.querySelector("[data-anatomy-root]"), spec);\n`;

  const html = pageHtml({ title: spec.title, theme, body: pageBody, script, width: spec.width });
  return fileResponse(html, "text/html; charset=utf-8", `${figure.filename}.html`);
}

async function readLiveEngine(): Promise<string | null> {
  try {
    const enginePath = path.join(process.cwd(), "lib", "anatomy", "liveEngine.mjs");
    const raw = await fs.readFile(enginePath, "utf8");
    return raw.replace(/^export /gm, ""); // inline-kit pattern: drop ESM keywords only at line start
  } catch {
    return null;
  }
}

function buildTsxComponent(plate: string, liveSpec: unknown, theme: "dark" | "light"): string {
  return `"use client";
// Anatomy illustration — standalone component exported by the WebUI Anatomy system.
// Depends on @/lib/anatomy/liveEngine.mjs and @/lib/anatomy/kit/iso.css existing in the host app.
import { useEffect, useRef } from "react";
import { mountAnatomyLive } from "@/lib/anatomy/liveEngine.mjs";
import "@/lib/anatomy/kit/iso.css";

const PLATE_HTML = ${JSON.stringify(plate)};
const LIVE_SPEC = ${JSON.stringify(liveSpec)};

export default function AnatomyFigure() {
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handle = mountAnatomyLive(rootRef.current!, LIVE_SPEC);
    return () => handle.destroy();
  }, []);
  return (
    <div className="iso anatomy-block" data-theme="${theme}" ref={rootRef}>
      <div dangerouslySetInnerHTML={{ __html: PLATE_HTML }} />
    </div>
  );
}
`;
}

function fileResponse(text: string, contentType: string, filename: string) {
  return new NextResponse(text, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
