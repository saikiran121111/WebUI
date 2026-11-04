import { NextRequest, NextResponse } from "next/server";
import { deleteSkill, isSafeSkillName, projectRoot } from "../../../../lib/skills/registry";
import { rustEnabled, rustProxy } from "../../../../lib/server/rustProxy";

/** DELETE /api/skills/:skillName — removes the skill folder AND its scenario. */
export async function DELETE(
  req: NextRequest,
  { params }: { params: { skillName: string } },
) {
  if (rustEnabled()) return rustProxy(req, `/api/ruke/skills/${encodeURIComponent(params.skillName)}`);
  const skillName = params.skillName;
  if (!isSafeSkillName(skillName)) {
    return NextResponse.json({ error: "Invalid skill name" }, { status: 400 });
  }
  const removed = await deleteSkill(projectRoot(), skillName);
  if (!removed) return NextResponse.json({ error: "Skill not found" }, { status: 404 });
  return NextResponse.json({ ok: true, deleted: skillName });
}
