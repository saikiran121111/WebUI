/**
 * PptxGenJS shape-id defect (reproduced on the pinned 4.0.1): graphic frames
 * (addTable / addChart) take their cNvPr id from a PER-TYPE counter, not the
 * slide's shape counter — "Text 0" id=2 beside "Table 0" id=2 on one slide.
 * Duplicate <p:cNvPr id> values are invalid OOXML: PowerPoint opens a repair
 * prompt, and the @office-kit/pptx validatePresentation gate in pptxEngine
 * throws, so the Download button renders an alert instead of a file.
 *
 * Renumber every <p:cNvPr id> in each slide part by document order (root
 * group = 1, shapes from 2), which is exactly PptxGenJS's own clean-slide
 * convention — a deck without collisions renumbers to identical bytes and
 * the buffer is returned untouched. Safe here because this runs BEFORE the
 * office-kit motion pass (all p:timing spTgt references are written after,
 * against the new ids) and PptxGenJS slides carry no timing of their own;
 * morph pairing rides on the stable objectName values, not numeric ids.
 */
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";

const SLIDE_PART = /^ppt\/slides\/slide\d+\.xml$/;

/** Returns a package whose slide shape ids are unique per slide. */
export function ensureUniqueShapeIds(raw: Buffer): Buffer {
  const zip = unzipSync(raw);
  let dirty = false;
  for (const name of Object.keys(zip)) {
    if (!SLIDE_PART.test(name)) continue;
    const xml = strFromU8(zip[name]);
    let counter = 0;
    const patched = xml.replace(/<p:cNvPr id="\d+"/g, () => `<p:cNvPr id="${++counter}"`);
    if (patched !== xml) {
      zip[name] = strToU8(patched);
      dirty = true;
    }
  }
  if (!dirty) return raw;
  return Buffer.from(zipSync(zip));
}
