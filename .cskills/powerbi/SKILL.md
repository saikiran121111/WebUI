---
name: powerbi
description: Build Power BI deliverables from raw data — a real .pbip/.pbit package (TMDL semantic model with DAX measures + PBIR report definition) AND a 60fps interactive in-chat dashboard preview with KPI count-up cards, cross-filtering charts, slicers and drill-down. Extends xlsx + d3-js-visualization + motherduck-duckdb-sql.
---

# Power BI Engine Skill (composite core skill)

You are turning raw data (CSV pasted by the user, an attached file, or a
generated sample dataset) into TWO synchronized outputs in one turn:

1. A **downloadable Power BI package** — the WebUI engine builds a valid
   `.pbip` project (`<Name>.pbip` entry, `SemanticModel/definition/` TMDL
   tables/columns/relationships/DAX measures, `Report/definition/` PBIR
   `report.json` + `pages.json` + per-visual JSON, dark executive theme) and a
   `.pbit` template, zipped for download.
2. A **live interactive preview** rendered by the WebUI's Power BI viewer:
   animated KPI count-up cards with sparklines, cross-filtering bar/area/
   donut/waterfall charts, slicers, date-range filter, drill-down table —
   all at 60fps.

## Output contract (MANDATORY)

One short intro sentence (what you found in the data), then exactly ONE fenced
block with language `powerbi` containing ONE JSON object:

```powerbi
{
  "filename": "Q4_Sales_Analysis",
  "dataset": {
    "columns": [
      {"name": "Date", "type": "date"},
      {"name": "Region", "type": "string"},
      {"name": "Product", "type": "string"},
      {"name": "Revenue", "type": "number"},
      {"name": "Cost", "type": "number"}
    ],
    "rows": [["2024-01-05", "North", "Widget", 12500.5, 7400], ...]
  },
  "measures": [
    {"name": "Total Revenue", "dax": "SUM(Sales[Revenue])"},
    {"name": "Margin %", "dax": "DIVIDE([Total Revenue] - SUM(Sales[Cost]), [Total Revenue])"},
    {"name": "YoY Growth %", "dax": "DIVIDE([Total Revenue] - CALCULATE([Total Revenue], DATEADD(Sales[Date], -1, YEAR)), CALCULATE([Total Revenue], DATEADD(Sales[Date], -1, YEAR)))"}
  ],
  "visuals": [
    {"type": "kpi", "title": "Total Revenue", "measure": "Total Revenue", "format": "currency"},
    {"type": "bar", "title": "Revenue by Region", "dimension": "Region", "measure": "Total Revenue"},
    {"type": "area", "title": "Revenue Trend", "dimension": "Date", "measure": "Total Revenue"},
    {"type": "donut", "title": "Mix by Product", "dimension": "Product", "measure": "Total Revenue"},
    {"type": "waterfall", "title": "Revenue Bridge", "dimension": "Region", "measure": "Total Revenue"},
    {"type": "table", "title": "Detail", "columns": ["Date", "Region", "Product", "Revenue"]}
  ],
  "slicers": [{"field": "Region", "type": "list"}, {"field": "Date", "type": "date-range"}],
  "theme": "dark"
}
```

## Data rules (NON-NEGOTIABLE)

- NEVER invent numbers. Every row must come from the user's data. If no data
  was supplied, ask for it (or say you will generate a clearly-labeled sample
  and mark `"synthetic": true`).
- Sanitize: null/blank numeric cells → `0`, blank text → `"N/A"`. Dates as
  `YYYY-MM-DD` strings. The engine re-validates and re-sanitizes server-side.
- Keep the FULL row set in the fence (the preview aggregates client-side);
  above ~400 rows, pre-aggregate to monthly×dimension and say so.

## DAX measures (semantic model)

- Always emit at least: `Total Revenue`-style base measure (`SUM(...)`),
  `Margin %` (`DIVIDE`, never raw `/`), and a time-intelligence measure
  (`YoY Growth %` via `CALCULATE` + `DATEADD`) when a date column exists.
- Table name in DAX = `"Sales"` (the engine names the fact table `Sales`).
- The engine writes these into TMDL `measure "Total Revenue" = SUM(Sales[Revenue])`
  with `folded = false`, and relationships as `relationship` blocks when a
  dimension key column is detected.

## Preview UX (rendered by the WebUI viewer — you just declare it)

- KPI cards animate a count-up on mount (rAF tween) + inline sparkline.
- Clicking a bar/donut segment/slicer cross-filters every other visual
  (single-pass recompute, transform/opacity transitions only, 60fps).
- Drill-down table: sortable, paginated, row hover `#141414`.
- Dark executive theme: page `#000000`, cards `#0D0D0D`/`#141414`, border
  `#262626`, text `#FFFFFF`/`#A1A1AA`, positive `#22C55E`, highlight `#38E8FF`.

## Download flow

The viewer's action bar shows `POWER BI • <filename>.pbip.zip` with a Download
button; the engine POSTs the fence JSON to `/api/documents/powerbi` and returns
the zip (contains `<Name>.pbip/…` TMDL+PBIR tree AND `<Name>.pbit`). Conversational
edits ("add a Margin by month visual") re-emit the WHOLE corrected fence — the
preview regenerates in place.
