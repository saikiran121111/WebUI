#!/usr/bin/env python
"""PPTX Morph post-processor (PHASE 4). Stdlib-only (zipfile + ElementTree).

Usage: python pptx_morph_injector.py <in.pptx> <out.pptx> <manifest.json>

Manifest:
{
  "slideSize": {"w": EMU, "h": EMU},
  "morphSlides": [2, 3, ...],                       # 1-based; receive <p159:morph option="byObject"/>
  "namedShapes": [{"slide": n, "name": "!!X", "rot": deg, "srcRect": {t,b,l,r}}],
  "spotlights":  [{"slide": n, "name": "!!X", "window": {x,y,w,h}}]  # EMU cutout
}

Operations:
 1. Inject the Morph transition inside mc:AlternateContent (p14 Choice + fade
    Fallback) after cSld/clrMapOvr on each morph slide.
 2. Replace spotlight overlay geometry with a custGeom cutout (outer rect +
    reversed inner subpath -> punched window; morphing the same !!-named shape
    between slides animates the moving spotlight + camera pan).
 3. Apply rot (deg*60000) and srcRect (1000ths of a percent) to named shapes.
 4. Strip empty placeholders (sp with <p:ph> and no text).
 5. Validate every XML part parses; print a JSON summary; exit non-zero on error.
"""
import json
import sys
import xml.etree.ElementTree as ET
import zipfile

NS = {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "mc": "http://schemas.openxmlformats.org/markup-compatibility/2006",
    "p14": "http://schemas.microsoft.com/office/powerpoint/2010/main",
    "p159": "http://schemas.microsoft.com/office/powerpoint/2015/main/image",
}
for prefix, uri in NS.items():
    ET.register_namespace(prefix, uri)

A, P = "{%s}" % NS["a"], "{%s}" % NS["p"]

MORPH_FRAGMENT = (
    '<mc:AlternateContent xmlns:mc="%(mc)s">'
    '<mc:Choice xmlns:p14="%(p14)s" Requires="p14">'
    '<p:transition spd="slow" p14:dur="1800" xmlns:p="%(p)s">'
    '<p159:morph option="byObject" xmlns:p159="%(p159)s"/>'
    "</p:transition></mc:Choice>"
    '<mc:Fallback><p:transition spd="slow" xmlns:p="%(p)s"><p:fade/></p:transition></mc:Fallback>'
    "</mc:AlternateContent>"
) % NS


def slide_part(index):
    return "ppt/slides/slide%d.xml" % index


def find_sp(root, name):
    """Locate a shape by cNvPr name. Handles p:sp, p:pic (addImage) and p:graphicFrame."""
    for tag, nvtag in ((P + "sp", P + "nvSpPr"), (P + "pic", P + "nvPicPr"), (P + "graphicFrame", P + "nvGraphicFramePr")):
        for el in root.iter(tag):
            nv = el.find(nvtag)
            if nv is None:
                continue
            cnv = nv.find(P + "cNvPr")
            if cnv is not None and cnv.get("name") == name:
                return el
    return None


def shape_names(root):
    names = []
    for tag, nvtag in ((P + "sp", P + "nvSpPr"), (P + "pic", P + "nvPicPr"), (P + "graphicFrame", P + "nvGraphicFramePr")):
        for el in root.iter(tag):
            nv = el.find(nvtag)
            cnv = nv.find(P + "cNvPr") if nv is not None else None
            if cnv is not None:
                names.append(cnv.get("name"))
    return names


def parent_map(root):
    return {c: p for p in root.iter() for c in p}


def inject_morph(root):
    children = list(root)
    anchor = root.find(P + "clrMapOvr")
    if anchor is None:
        anchor = root.find(P + "cSld")
    if anchor is None:
        return False
    root.insert(children.index(anchor) + 1, ET.fromstring(MORPH_FRAGMENT))
    return True


def cutout_geometry(sp, size, win):
    """Outer rect (clockwise) + inner window rect (counter-clockwise) -> hole."""
    sp_pr = sp.find(P + "spPr")
    if sp_pr is None:
        return False
    geom_idx = 0
    for i, child in enumerate(list(sp_pr)):
        if child.tag in (A + "prstGeom", A + "custGeom"):
            sp_pr.remove(child)
        elif child.tag == A + "xfrm":
            geom_idx = i + 1
    x, y, w, h = win["x"], win["y"], win["w"], win["h"]
    sw, sh = size["w"], size["h"]

    def pt(px, py):
        return '<a:pt x="%d" y="%d"/>' % (px, py)

    segs = []
    segs.append("<a:moveTo>" + pt(0, 0) + "</a:moveTo>")
    segs.append("<a:lnTo>" + pt(sw, 0) + "</a:lnTo>")
    segs.append("<a:lnTo>" + pt(sw, sh) + "</a:lnTo>")
    segs.append("<a:lnTo>" + pt(0, sh) + "</a:lnTo>")
    segs.append("<a:close/>")
    # reversed inner subpath (counter-clockwise) punches the window
    segs.append("<a:moveTo>" + pt(x, y + h) + "</a:moveTo>")
    segs.append("<a:lnTo>" + pt(x, y) + "</a:lnTo>")
    segs.append("<a:lnTo>" + pt(x + w, y) + "</a:lnTo>")
    segs.append("<a:lnTo>" + pt(x + w, y + h) + "</a:lnTo>")
    segs.append("<a:close/>")
    geom = ET.fromstring(
        '<a:custGeom xmlns:a="%(a)s"><a:gdLst/><a:ahLst/><a:cxnLst/>'
        '<a:rect l="0" t="0" r="0" b="0"/>'
        '<a:pathLst><a:path w="%(w)d" h="%(h)d">%(segs)s</a:path></a:pathLst></a:custGeom>'
        % {"a": NS["a"], "w": sw, "h": sh, "segs": "".join(segs)}
    )
    sp_pr.insert(geom_idx, geom)
    return True


def apply_rot(sp, deg):
    sp_pr = sp.find(P + "spPr")
    if sp_pr is None:
        return False
    xfrm = sp_pr.find(A + "xfrm")
    if xfrm is None:
        return False
    xfrm.set("rot", str(int(round(deg * 60000))))
    return True


def apply_src_rect(sp, rect):
    blip_fill = sp.find(P + "blipFill")
    if blip_fill is None:
        return False
    src = blip_fill.find(A + "srcRect")
    if src is None:
        blip = blip_fill.find(A + "blip")
        src = ET.Element(A + "srcRect")
        blip_fill.insert(list(blip_fill).index(blip) + 1 if blip is not None else 0, src)
    for key in ("t", "b", "l", "r"):
        if rect.get(key) is not None:
            src.set(key, str(int(rect[key])))
    return True


def strip_empty_placeholders(root):
    removed = 0
    parents = parent_map(root)
    for sp in list(root.iter(P + "sp")):
        nv = sp.find(P + "nvSpPr")
        if nv is None:
            continue
        cnv = nv.find(P + "cNvPr")
        if cnv is None or cnv.find(P + "ph") is None:
            continue
        if any((t.text or "").strip() for t in sp.iter(A + "t")):
            continue
        parent = parents.get(sp)
        if parent is not None:
            parent.remove(sp)
            removed += 1
    return removed


def main():
    if len(sys.argv) != 4:
        print(json.dumps({"errors": ["usage: pptx_morph_injector.py in.pptx out.pptx manifest.json"]}))
        return 2
    in_path, out_path, manifest_path = sys.argv[1:4]
    try:
        with open(manifest_path, "r", encoding="utf-8") as fh:
            manifest = json.load(fh)
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"errors": ["manifest: %s" % exc]}))
        return 2

    size = manifest.get("slideSize", {"w": 12192000, "h": 6858000})
    morph_slides = set(manifest.get("morphSlides", []))
    named_shapes = manifest.get("namedShapes", [])
    spotlights = manifest.get("spotlights", [])
    renames = manifest.get("renames", [])

    touched = {}
    errors = []
    stats = {"morphSlides": 0, "namedShapes": 0, "spotlights": 0, "renames": 0, "strippedPlaceholders": 0}

    with zipfile.ZipFile(in_path, "r") as zin:
        names = zin.namelist()
        contents = {n: zin.read(n) for n in names}

    slide_indices = sorted(
        set(morph_slides)
        | {e["slide"] for e in named_shapes}
        | {e["slide"] for e in spotlights}
        | {e["slide"] for e in renames}
    )
    for idx in slide_indices:
        part = slide_part(idx)
        if part not in contents:
            errors.append("missing slide part: %s" % part)
            continue
        try:
            root = ET.fromstring(contents[part].decode("utf-8"))
        except ET.ParseError as exc:
            errors.append("%s: parse error: %s" % (part, exc))
            continue

        if idx in morph_slides and inject_morph(root):
            stats["morphSlides"] += 1

        # pptxgenjs ignores the `name` option — rename its generated cNvPr
        # names ("Text 3", "Image 0", …) to the engine's !!-prefixed names
        # BEFORE spotlight/named-shape lookups run against them.
        for entry in [e for e in renames if e["slide"] == idx]:
            sp = find_sp(root, entry["gen"])
            if sp is None:
                errors.append("%s: rename target not found: %s (have: %s)" % (part, entry["gen"], shape_names(root)))
                continue
            renamed = False
            for cnv in sp.iter(P + "cNvPr"):
                cnv.set("name", entry["name"])
                renamed = True
                break
            if renamed:
                stats["renames"] += 1

        for entry in [e for e in spotlights if e["slide"] == idx]:
            sp = find_sp(root, entry["name"])
            if sp is None:
                errors.append("%s: spotlight shape not found: %s (have: %s)" % (part, entry["name"], shape_names(root)))
                continue
            if cutout_geometry(sp, size, entry["window"]):
                stats["spotlights"] += 1

        for entry in [e for e in named_shapes if e["slide"] == idx]:
            sp = find_sp(root, entry["name"])
            if sp is None:
                errors.append("%s: named shape not found: %s (have: %s)" % (part, entry["name"], shape_names(root)))
                continue
            ok = True
            if entry.get("rot") is not None and not apply_rot(sp, entry["rot"]):
                ok = False
            if entry.get("srcRect") is not None and not apply_src_rect(sp, entry["srcRect"]):
                ok = False
            if ok:
                stats["namedShapes"] += 1

        stats["strippedPlaceholders"] += strip_empty_placeholders(root)
        touched[part] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' + ET.tostring(root, encoding="unicode")

    # validate every XML part of the final package
    final = dict(contents)
    final.update({k: v.encode("utf-8") for k, v in touched.items()})
    for name, data in final.items():
        if name.endswith(".xml") or name.endswith(".rels"):
            try:
                ET.fromstring(data.decode("utf-8"))
            except (ET.ParseError, UnicodeDecodeError) as exc:
                errors.append("invalid XML %s: %s" % (name, exc))

    if errors:
        print(json.dumps({"errors": errors}))
        return 1

    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zout:
        for name in names:
            zout.writestr(name, final[name])

    print(json.dumps({**stats, "errors": []}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
