import { NextRequest, NextResponse } from "next/server";
import {
  defaultScenario,
  listInstalledSkillNames,
  projectRoot,
  readScenario,
  skillDescription,
  startSkillWatcher,
  syncInstalledSkills,
} from "../../../lib/skills/registry";
import { rustEnabled, rustProxy } from "../../../lib/server/rustProxy";
import type { SkillRecord } from "../../../lib/skills/types";

/** GET /api/skills — every installed skill merged with its scenario config. */
export async function GET(req: NextRequest) {
  if (rustEnabled()) return rustProxy(req, "/api/ruke/skills");
  const root = projectRoot();
  startSkillWatcher(root);
  await syncInstalledSkills(root);

  const records: SkillRecord[] = [];
  for (const name of await listInstalledSkillNames(root)) {
    const scenario = (await readScenario(root, name)) ?? defaultScenario(name);
    records.push({
      ...scenario,
      skillName: name,
      installed: true,
      description: await skillDescription(root, name),
    });
  }
  return NextResponse.json({ skills: records });
}
