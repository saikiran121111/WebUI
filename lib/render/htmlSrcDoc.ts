/**
 * Sandbox + src-doc construction for the interactive HTML artifact viewer
 * (2026-11-06 audit, finding 6).
 *
 * A ```html fence body is MODEL output, so its preview iframe is treated as
 * untrusted content. It used to run `sandbox="allow-scripts allow-same-origin"`,
 * and a `srcdoc` document inherits its parent's origin — that pair granted the
 * artifact the APP's own origin, so model HTML could read `parent.document`,
 * the app's cookies and storage, and call the app's API routes as the user.
 * Dropping `allow-same-origin` puts the frame in an opaque origin: scripts
 * still run (interactivity is the whole point of the viewer) but the parent
 * DOM, the app's storage and same-origin API reads are unreachable, and the
 * frame's requests are cross-site so SameSite cookies are not attached.
 *
 * Two features used to depend on the same-origin grant, so both moved INSIDE
 * the frame instead of being dropped:
 *   - the light-background luma probe (the parent read
 *     `frame.contentDocument`, which now throws SecurityError) rides the resize
 *     message as `luma`;
 *   - artifacts that remember state with localStorage/sessionStorage get a
 *     per-viewer in-memory shim, so isolation does not break them — and their
 *     state can no longer be written into, or read out of, the app's origin.
 *
 * The parent never touches the frame's document again; the only channel is the
 * postMessage below, whose `event.source` is checked against the frame's own
 * window in the component.
 */

/**
 * The sandbox attribute for the artifact iframe. `allow-scripts` is required
 * for the viewer's whole purpose; `allow-same-origin` must NEVER come back
 * (finding 6). `allow-top-navigation`, `allow-popups` and `allow-forms` stay
 * off: the artifact cannot move the chat page, open windows or submit forms
 * as the user.
 */
export const HTML_ARTIFACT_SANDBOX = "allow-scripts";

/** Message contract posted by the injected frame script to the chat page. */
export interface HtmlViewerResizeMessage {
  type: "HTML_VIEWER_RESIZE";
  width: number;
  height: number;
  /** Body background luma 0..1, measured INSIDE the frame; null if unmeasurable. */
  luma: number | null;
}

/**
 * Light-background artifacts get the invert+hue-rotate filter. The threshold
 * matches the probe the viewer has used since the feature shipped
 * (Rec.709 luma of the body background over 0.5).
 */
export const INVERT_LUMA_THRESHOLD = 0.5;

export function shouldInvert(luma: unknown): boolean {
  return typeof luma === "number" && isFinite(luma) && luma > INVERT_LUMA_THRESHOLD;
}

/**
 * In-memory storage shim, injected into <head> BEFORE the artifact's own
 * scripts. Under an opaque origin the `window.localStorage` getter throws
 * SecurityError, which would break artifacts that persist their own state
 * (splitters, todo lists, sliders). The shim keeps those artifacts working and
 * keeps their state inside the viewer's lifetime — nothing is written to the
 * app origin. Injected only when the native accessor is unavailable or throws,
 * so a non-sandboxed document still gets the real storage.
 */
export const STORAGE_SHIM_SCRIPT =
  "<script>(function(){var make=function(){var m={};var api={getItem:function(k){k=String(k);" +
  "return Object.prototype.hasOwnProperty.call(m,k)?m[k]:null},setItem:function(k,v){m[String(k)]=String(v)}," +
  "removeItem:function(k){delete m[String(k)]},clear:function(){m={}}," +
  "key:function(i){var ks=Object.keys(m);return i>=0&&i<ks.length?ks[i]:null}};" +
  "Object.defineProperty(api,\"length\",{get:function(){return Object.keys(m).length}});return api};" +
  "var names=[\"localStorage\",\"sessionStorage\"];for(var i=0;i<names.length;i++){var n=names[i];var native=false;" +
  "try{native=!!window[n]}catch(e){native=false}if(native)continue;" +
  "try{Object.defineProperty(window,n,{value:make(),configurable:true})}catch(e){}}})();</script>";

/**
 * Runs INSIDE the sandboxed iframe: reports content size AND the body
 * background luma to the parent. Same script the viewer has always injected
 * (ResizeObserver + load/resize listeners), extended with the `luma` field so
 * the invert decision no longer needs cross-document access.
 */
export const RESIZE_SCRIPT =
  "<script>(function(){var post=function(){try{var d=document.documentElement;var b=document.body;" +
  "var luma=null;try{var s=getComputedStyle(b||d).backgroundColor;" +
  "var m=/rgba?\\((\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)/.exec(s);" +
  "if(m)luma=(0.2126*Number(m[1])+0.7152*Number(m[2])+0.0722*Number(m[3]))/255}catch(e){}" +
  "parent.postMessage({type:'HTML_VIEWER_RESIZE'," +
  "width:Math.max(d.scrollWidth,b?b.scrollWidth:0)," +
  "height:Math.max(d.scrollHeight,b?b.scrollHeight:0),luma:luma},'*')}catch(e){}};" +
  "if(window.ResizeObserver){new ResizeObserver(post).observe(document.documentElement);}" +
  "window.addEventListener('load',post);window.addEventListener('resize',post);setTimeout(post,50);post();})();</script>";

/**
 * Inserts `snippet` so it runs BEFORE the document's own code: the start of
 * <head> (the end would sit behind a model document's head scripts, and an
 * artifact that touches localStorage up there would still see SecurityError),
 * else a synthesized <head> right after <html>, else at the very front.
 * Function replacers keep `$&`/`$1` in model HTML literal.
 */
function injectIntoHead(doc: string, snippet: string): string {
  if (/<head[^>]*>/i.test(doc)) return doc.replace(/<head[^>]*>/i, (open) => open + snippet);
  if (/<html[^>]*>/i.test(doc)) return doc.replace(/<html[^>]*>/i, (open) => open + "<head>" + snippet + "</head>");
  return snippet + doc;
}

/**
 * Wraps a fragment in the viewer's dark defaults and injects the two frame
 * scripts. Full documents are kept verbatim apart from the injections — the
 * Download HTML / Export PDF paths send the fence body untouched, so the
 * artifact's paper output is never affected by what the preview injects.
 */
export function buildSrcDoc(source: string): string {
  const isFullDoc = /<html[\s>]/i.test(source);
  const doc = isFullDoc
    ? source
    : '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<style>html,body{margin:0;background:#000000;color:#FFFFFF;font-family:system-ui,sans-serif}</style></head><body>' +
      source + "</body></html>";
  const withShim = injectIntoHead(doc, STORAGE_SHIM_SCRIPT);
  return /<\/body>/i.test(withShim)
    ? withShim.replace(/<\/body>/i, () => RESIZE_SCRIPT + "</body>")
    : withShim + RESIZE_SCRIPT;
}
