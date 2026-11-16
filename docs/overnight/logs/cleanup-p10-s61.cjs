const fs = require("fs");
const base = "D:/Projects/WebUI/";
const targets = [
  "scratch-s37","scratch-s40","scratch-s43","scratch-s46","scratch-s48",
  "scratch-s53","scratch-s55","scratch-s57","scratch-s59",
  "test-data-s48","tmp-devcheck-data",
];
for (const t of targets) {
  const p = base + t;
  if (!fs.existsSync(p)) { console.log("absent:", t); continue; }
  const real = fs.realpathSync(p);
  if (!real.toLowerCase().startsWith("d:\\projects\\webui\\")) throw new Error("refusing to remove outside workspace: " + real);
  fs.rmSync(p, { recursive: true, force: true });
  console.log("removed:", t, "still exists:", fs.existsSync(p));
}
const kept = ["scratch-s49","target-ci","WebUI"];
for (const k of kept) console.log("kept:", k, fs.existsSync(base + k));
