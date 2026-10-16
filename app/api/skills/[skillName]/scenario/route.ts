import { NextRequest, NextResponse } from "next/server";
import { isSafeSkillName, projectRoot, updateScenario } from "../../../../../lib/skills/registry";

const ALLOWED_FIELDS = ["enabled", "autoUse", "whenToUse", "triggerKeywords"];

/** PATCH /api/skills/:skillName/scenario — update routing config only. */
export async function PATCH(
  req: NextRequest,
  { params }: { params: { skillName: string } },
) {
  const skillName = params.skillName;
  if (!isSafeSkillName(skillName)) {
    return NextResponse.json({ error: "Invalid skill name" }, { status: 400 });
  }

  let patch: Record<string, unknown>;
  try {
    patch = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const keys = Object.keys(patch ?? {});
  if (keys.length === 0 || keys.some((key) => !ALLOWED_FIELDS.includes(key))) {
    return NextResponse.json(
      { error: "Allowed fields: " + ALLOWED_FIELDS.join(", ") },
      { status: 400 },
    );
  }

  const updated = await updateScenario(projectRoot(), skillName, patch);
  if (!updated) return NextResponse.json({ error: "Skill scenario not found" }, { status: 404 });
  return NextResponse.json({ skill: updated });
}
