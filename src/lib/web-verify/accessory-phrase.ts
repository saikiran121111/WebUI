/**
 * Accessory PHRASES — the multi-word shapes only an accessory LISTING uses.
 *
 * `entity.ts` ACCESSORY_MARKERS is a single-word list whose job is to BIND an
 * entity to a page, and it deliberately fires on "case", "cover", "screen",
 * "glass", "lens", "battery". Those words also sit inside genuine product names
 * ("6.7 inch Curved Screen", "Gorilla Glass Victus", "Case-Slip design"), so
 * using that list to DECIDE whether a page is an accessory discards real,
 * in-stock listings: a phone whose own name mentions its screen loses its price
 * and stock facts, and the answer is left with nothing verified to say.
 *
 * This is the stricter predicate for that DECISION. It lives in `web-verify`
 * because both adjudicators need it — the fact ledger (may these facts be bound
 * to the entity at all?) and the entity validator (is this page the entity?).
 */
export const ACCESSORY_PHRASES = [
  "back cover", "backcase", "back case", "flip cover", "cover for", "case for",
  "case with", "case cover", "protective case", "protective cover", "silicone cover",
  "soft case", "hard case", "leather case", "phone case", "mobile case", "phone cover",
  "screen protector", "screen protection", "tempered glass", "glass guard", "screen guard",
  "camera lens protector", "lens cover", "skin for", "vinyl skin", "charger",
  "charging cable", "charger cable", "usb cable", "data cable", "adapter", "power bank",
  "powerbank", "earphone", "earphones", "earbuds", "handfree", "holder", "stand for",
  "tripod", "selfie stick", "stylus", "pen for", "screen replacement", "display assembly",
  "battery for", "extended warranty", "annual maintenance",
];

const ESCAPE = (m: string) => m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const PHRASE_RES: RegExp[] = ACCESSORY_PHRASES.map(
  (p) => new RegExp(`(?<![a-z])${ESCAPE(p)}(?![a-z])`, "i"),
);

/** Normalize once: URL slugs carry the same words behind `/-/_` separators. */
function normalize(text: string): string {
  return (text + " " + text.replace(/[\/_\-+%]+/g, " ")).toLowerCase();
}

/**
 * Which accessory phrase the text NAMES AS ITS SUBJECT, or null. Callers pass
 * only subject-bearing strings — a page title, a structured product name, a URL
 * slug. The live deals rail (2026-10-21) is the reason: a real phone page lists
 * "Back Cover" tiles inside its own body text, so a body-wide scan would stamp
 * every product page as an accessory.
 */
export function accessoryPhraseIn(...texts: (string | undefined)[]): string | null {
  const norm = normalize(texts.filter(Boolean).join(" "));
  for (let i = 0; i < PHRASE_RES.length; i++) {
    if (PHRASE_RES[i].test(norm)) return ACCESSORY_PHRASES[i];
  }
  return null;
}

/** Is this text (a name, a slug, a prose window) about an accessory? */
export function hasAccessoryPhrase(text: string | undefined): boolean {
  if (!text) return false;
  const norm = normalize(text);
  return PHRASE_RES.some((re) => re.test(norm));
}
