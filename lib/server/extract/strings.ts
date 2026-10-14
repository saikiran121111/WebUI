/**
 * Recover printable text from binary files (legacy .doc/.xls/.ppt, .mat).
 * Scans both single-byte ASCII runs and UTF-16LE runs (OLE documents store
 * most of their text as UTF-16).
 */
export function extractStrings(buf: Buffer, minLen = 5): string {
  const runs: string[] = [];

  // Single-byte runs.
  let cur = "";
  for (const b of buf) {
    if ((b >= 32 && b < 127) || b === 9) cur += String.fromCharCode(b);
    else { if (cur.length >= minLen) runs.push(cur.trim()); cur = ""; }
  }
  if (cur.length >= minLen) runs.push(cur.trim());

  // UTF-16LE runs (printable low byte, zero high byte).
  let u = "";
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const lo = buf[i], hi = buf[i + 1];
    if (hi === 0 && ((lo >= 32 && lo < 127) || lo === 9)) u += String.fromCharCode(lo);
    else { if (u.length >= minLen) runs.push(u.trim()); u = ""; }
  }
  if (u.length >= minLen) runs.push(u.trim());

  return runs.join("\n");
}
