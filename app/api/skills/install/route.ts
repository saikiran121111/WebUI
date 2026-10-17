import { NextRequest, NextResponse } from "next/server";
import { installSkill } from "../../../../lib/skills/registry";
import type { InstallRequestBody } from "../../../../lib/skills/types";

/**
 * POST /api/skills/install — downloads a REAL skill via `npx -y skills add`
 * (never fabricates one), then moves it into ./skills/ and creates its
 * scenario file. Body: { repoOrCommand, skillName?, autoUse?, whenToUse?, triggerKeywords? }.
 */
export async function POST(req: NextRequest) {
  let body: InstallRequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body?.repoOrCommand !== "string" || !body.repoOrCommand.trim()) {
    return NextResponse.json({ error: "repoOrCommand is required" }, { status: 400 });
  }
  // Two-tier rule: this service installs into ./skills/ ONLY. The core hidden
  // tier (./.cskills/) is developer-terminal only (npm run cskill:add) and can
  // never be installed into, overwritten or deleted from the browser.
  if (body.repoOrCommand.includes(".cskills")) {
    return NextResponse.json(
      { error: "The core skill tier (./.cskills/) is developer-only and cannot be modified from the browser" },
      { status: 400 },
    );
  }

  try {
    const result = await installSkill(body);
    return NextResponse.json({
      ok: true,
      installedSkillNames: result.installedSkillNames,
      commandOutput: result.commandOutput.slice(-4000),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Skill install failed";
    const isClientError = /empty|must be|No repository|Unsafe|Unsupported/i.test(message);
    return NextResponse.json({ error: message }, { status: isClientError ? 400 : 500 });
  }
}
