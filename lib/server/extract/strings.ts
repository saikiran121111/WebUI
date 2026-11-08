/**
 * Recover printable text from binary files (legacy .doc/.xls/.ppt, .mat).
 * Scans single-byte runs and UTF-16 runs.
 *
 * I10: the UTF-16 pass used to require a zero HIGH byte, so only ASCII
 * survived — a legacy Word file written in Telugu/Chinese/Hindi came back
 * looking empty. Real BMP characters are accepted now; surrogates and C1
 * controls still break a run (they signal binary noise).
 *
 * Every recovered run is a *guess* from a byte scan — callers should label
 * results from this module as lossy recovery.
 */
const MIN_RUN = 5;

function isPrintableUnit(cp: number): boolean {
  if (cp === 9 || cp === 10 || (cp >= 32 && cp < 127)) return true;
  if (cp >= 0xa0 && cp <= 0xd7ff) return true; // Latin-1 supplement → CJK → private-use-adjacent; BMP scripts
  if (cp >= 0xe000 && cp <= 0xfffd) return true; // includes private use; tolerate (legacy docs love ligature glyphs)
  return false; // C1 controls, surrogates, noncharacters break the run
}

export function extractStrings(buf: Buffer, minLen = MIN_RUN): string {
  const runs: string[] = [];
  const seen = new Set<string>();
  const push = (s: string) => {
    const t = s.trim();
    if (t.length >= minLen && !seen.has(t)) { seen.add(t); runs.push(t); }
  };

  // Single-byte runs.
  let cur = "";
  for (const b of buf) {
    if ((b >= 32 && b < 127) || b === 9) cur += String.fromCharCode(b);
    else { push(cur); cur = ""; }
  }
  push(cur);

  // UTF-16 runs at either byte parity (OLE streams are aligned but text blocks
  // are not guaranteed to be). High-byte==0 is no longer required.
  for (const parity of [0, 1]) {
    let u = "";
    for (let i = parity; i + 1 < buf.length; i += 2) {
      const cp = buf.readUInt16LE(i);
      if (isPrintableUnit(cp)) u += String.fromCharCode(cp);
      else { push(u); u = ""; }
    }
    push(u);
  }

  return runs.join("\n");
}
