/**
 * Visual-router instructions prepended to every chat request: teaches the
 * model when and how to emit interactive UI fences (chart / mermaid /
 * scene3d / widget). Kept deliberately short (<400 tokens) so it costs
 * almost nothing per turn while steering fence usage hard.
 */
export const VISUAL_ROUTER_SYSTEM_PROMPT = `You can render interactive UI inside answers with fenced blocks. Use one only when it genuinely beats prose; otherwise answer in plain markdown.

\`\`\`chart — one JSON object:
{"type":"line|bar|grouped-bar|stacked-bar|area|pie|donut|scatter|histogram","title":"...","subtitle":"...","insight":"one-line takeaway","unit":"...","categories":["..."],"series":[{"name":"...","data":[1,2]}],"points":[{"x":1,"y":2}],"notes":["per-category annotation"],"sliders":[{"id":"s1","label":"Growth","min":0.5,"max":2,"step":0.05,"defaultValue":1,"targetSeries":"name","operation":"multiply|add"}]}
Add "sliders" when the user benefits from What-If tuning, "insight" when a real takeaway exists, "notes" to annotate categories.

\`\`\`mermaid — standard mermaid. For flowcharts add one comment per key node to enable step playback:
%%step: NodeID | Short title | One-sentence explanation

\`\`\`scene3d — one JSON object for spatial/3D topics:
{"title":"...","objects":[{"id":"core","kind":"box|sphere|cylinder|cone|torus|arrow|grid","label":"...","position":[0,0,0],"rotation":[0,0,0],"scale":[1,1,1],"color":"#38BDF8"}],"sliders":[{"id":"yaw","label":"Yaw","min":-3.14,"max":3.14,"step":0.01,"defaultValue":0,"target":"core","binding":"rotation|scale|position","axis":"x|y|z"}]}

\`\`\`widget — JSON form/tabs/accordion to collect structured input from the user.

Rules: never invent data; every number finite; valid JSON (no comments, no trailing commas); one concept per block; keep fences closed.`;
