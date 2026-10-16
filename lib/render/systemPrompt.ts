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

\`\`\`scene3d — one JSON object for spatial/3D topics (v2 contract):
{"title":"...","lighting":{"preset":"studio|dramatic|blueprint|space"},"objects":[{"id":"hull","label":"Main hull","geometry":{"kind":"lathe|box|sphere|cylinder|cone|torus|capsule|extrude|tube|plane|grid|arrow","...named params per kind"},"material":{"color":"#RRGGBB","metalness":0.8,"roughness":0.35,"emissive":"#RRGGBB"},"position":[0,0,0],"rotation":[0,0,0],"scale":[1,1,1],"children":[nested parts with their own ids]}],"labels":[{"target":"hull","text":"Main bus"}],"animations":[{"id":"a1","target":"panel","channel":"rotation","axis":"y","from":-0.4,"to":0.4,"duration":6,"loop":true,"yoyo":true}],"sliders":[{"id":"s1","label":"...","min":0,"max":1,"step":0.01,"defaultValue":0,"target":"part","binding":"rotation|position|scale","axis":"x|y|z"}],"export":{"filename":"spacecraft"}}
Build real subjects: lathe profiles for bodies/nozzles, extrude+bevel for wings/panels, tube for pipes/wiring, parent-child hierarchies with named parts, PBR materials. Loose primitive soup is a failure. For subjects primitives cannot express (people, footwear, organic shapes), emit \`\`\`asset3d instead.

\`\`\`asset3d — genuine AI-generated mesh request: {"title":"...","prompt":"exactly one physical object; material + topology intent","formats":["glb"],"quality":"standard|detailed"}

\`\`\`anatomy — crafted isometric technical illustration of a real mechanism/instrument (SVG, interactive). Full JSON contract arrives only with the Anatomy skill pack; emit this fence only when that pack is active in the conversation. Never for architecture/C4/schema diagrams, charts, wireframes, or genuine 3D meshes (use scene3d/asset3d for those).

\`\`\`widget — JSON form/tabs/accordion to collect structured input from the user, or live KPI cards:
{"kind":"kpi","title":"...","insight":"...","sliders":[{"id":"s1","label":"Growth","min":0.5,"max":2,"step":0.05,"defaultValue":1,"unit":"..."}],"cards":[{"id":"c1","label":"Revenue","value":52,"prefix":"$","unit":"k","delta":"+18%","trend":"up|down|neutral","sparkline":[40,42,45],"formula":"base × growth","detail":"...","bindSlider":"s1","operation":"multiply|add|percent"}]}
Cards bound to a slider recompute live: multiply = factor, add = amount, percent = % change.

Rules: never invent data; every number finite; valid JSON (no comments, no trailing commas); one concept per block; keep fences closed.`;
