"use client";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowUpDown, Check, Copy, Maximize2, Minimize2,
  ChevronsLeftRight, ChevronsRightLeft,
} from "lucide-react";
import { copyText } from "../../lib/render/clipboard";

/**
 * Table wrapper used as the react-markdown `table` override: horizontal
 * scroll without page overflow, column resizing (drag the header edge like
 * a spreadsheet), row sorting on left-click of headers, filtering on
 * right-click of headers (dropdown of unique values + custom text term),
 * column collapse for wide tables (5+ columns hide behind an expand
 * toggle), CSV copy of the visible rows, and a fullscreen overlay with a
 * sticky header.
 * Sorting, filtering, column hiding and resizing act on the DOM
 * imperatively — no React state churn on big tables and no re-render of
 * the markdown tree. While the model is still generating, React keeps
 * appending rows and cells to this table, so every piece of imperative
 * state is re-synced after each render (see the resync effect) — otherwise
 * freshly streamed rows render unhidden and unfiltered mid-stream.
 */
const COLLAPSE_AT = 4; // columns beyond this hide behind the expand toggle
const MIN_COL_WIDTH = 56; // px floor for hand-sized columns
const MAX_FILTER_OPTIONS = 200;

type FilterMenuState = { col: number; left: number; top: number };

export default memo(function MarkdownTable({ children }: { children: React.ReactNode }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const sortRef = useRef<{ col: number; dir: 1 | -1 } | null>(null);
  const savedExpandedRef = useRef(false);
  const valueFiltersRef = useRef<Map<number, Set<string>>>(new Map());
  const termFiltersRef = useRef<Map<number, string>>(new Map());
  const suppressSortAfterDragRef = useRef(0);
  const colsHiddenRef = useRef<boolean | null>(null);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const [sortable, setSortable] = useState<boolean | null>(null);
  const [colCount, setColCount] = useState(0);
  const [rowCount, setRowCount] = useState(0);
  const [visibleRows, setVisibleRows] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [filterMenu, setFilterMenu] = useState<FilterMenuState | null>(null);
  const [menuOptions, setMenuOptions] = useState<string[]>([]);
  const [menuChecked, setMenuChecked] = useState<Set<string>>(new Set());
  const [menuSearch, setMenuSearch] = useState("");

  const updateFilterMarks = useCallback(() => {
    const headerRow = wrapRef.current?.querySelector("thead tr");
    if (!headerRow) return;
    Array.from(headerRow.children).forEach((cell, col) => {
      // An empty selection set is a real filter too (it hides every row), so
      // key off has(), not size.
      const active = valueFiltersRef.current.has(col) || !!termFiltersRef.current.get(col);
      cell.classList.toggle("filter-active", active);
    });
  }, []);

  const applyFilter = useCallback(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const headerCols = wrap.querySelector("thead tr")?.children.length ?? 0;
    let visible = 0;
    for (const row of wrap.querySelectorAll<HTMLTableRowElement>("tbody tr")) {
      let show = true;
      for (let col = 0; col < headerCols && show; col++) {
        const text = (row.children[col]?.textContent ?? "").trim();
        const lower = text.toLowerCase();
        const menuTerm = termFiltersRef.current.get(col) ?? "";
        if (menuTerm && !lower.includes(menuTerm)) { show = false; break; }
        const valueSet = valueFiltersRef.current.get(col);
        if (valueSet && !valueSet.has(text)) { show = false; break; }
      }
      row.style.display = show ? "" : "none";
      if (show) visible++;
    }
    setVisibleRows(visible);
    updateFilterMarks();
  }, [updateFilterMarks]);

  // Expanded wide tables overflow the scroller: cells must not wrap, or an
  // off-screen column's long text wraps to several lines and balloons every
  // row's height (the "tall gaps right after expanding" complaint — the
  // row's tallest cell is one you cannot even see). One-line cells give the
  // same compact grid look as hand-sized columns from the first moment;
  // the scroller takes the horizontal scroll instead.
  const syncOverflowClass = useCallback((table: HTMLTableElement) => {
    const scroller = table.parentElement;
    const overflowing = !!scroller && table.getBoundingClientRect().width > scroller.clientWidth + 1;
    table.classList.toggle("cols-nowrap", overflowing);
  }, []);

  const startResize = useCallback((e: PointerEvent, th: HTMLTableCellElement, handle: HTMLSpanElement) => {
    e.preventDefault();
    e.stopPropagation();
    const table = th.closest("table");
    if (!table) return;
    const headerCells = Array.from(th.parentElement?.children ?? []) as HTMLTableCellElement[];
    const visibleCells = headerCells.filter(c => !c.classList.contains("col-hidden"));
    const flexCell = visibleCells[visibleCells.length - 1];
    if (th === flexCell) return; // last visible column's edge is the grid edge (Excel rule)
    const scroller = table.parentElement;
    // Two regimes, same as Excel:
    // - Table fits the scroller: the last visible column keeps no explicit
    //   width — fixed layout hands it whatever the container leaves over, so
    //   the table always fills it (no blank gutter, no runaway growth).
    //   Dragged columns are clamped so that filler never drops below
    //   MIN_COL_WIDTH.
    // - Table overflows the scroller (expanded wide tables): there is no
    //   leftover to hand out, so every visible column — the last one
    //   included — gets a fixed width and the drag grows/shrinks the table
    //   itself; the scroller just scrolls further. Clamping this case to
    //   the viewport used to snap every dragged column straight to the
    //   MIN_COL_WIDTH floor, so dragging left or right did nothing.
    const overflowing = table.getBoundingClientRect().width > (scroller?.clientWidth ?? 0) + 1;
    if (!table.classList.contains("cols-resized")) {
      const widths = visibleCells.map(cell => Math.round(cell.getBoundingClientRect().width));
      table.classList.add("cols-resized");
      visibleCells.forEach((cell, i) => {
        if (cell !== flexCell || overflowing) cell.style.width = `${widths[i]}px`;
      });
    }
    const startX = e.clientX;
    const startW = th.getBoundingClientRect().width;
    handle.classList.add("is-dragging");
    document.body.classList.add("md-col-dragging");
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - startX) > 3) moved = true;
      let w = Math.round(startW + ev.clientX - startX);
      if (!overflowing) {
        const othersW = visibleCells.reduce(
          (sum, c) => sum + (c === th || c === flexCell ? 0 : (parseFloat(c.style.width) || 0)), 0);
        const availW = (scroller?.clientWidth ?? Infinity) - othersW - MIN_COL_WIDTH;
        w = Math.min(availW, w);
      }
      th.style.width = `${Math.max(MIN_COL_WIDTH, w)}px`;
    };
    const onUp = () => {
      handle.classList.remove("is-dragging");
      document.body.classList.remove("md-col-dragging");
      if (moved) suppressSortAfterDragRef.current = Date.now();
      syncOverflowClass(table); // the drag changed the table's own width
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [syncOverflowClass]);

  const resetColWidths = useCallback((table: HTMLTableElement, headerRow: Element) => {
    table.classList.remove("cols-resized");
    table.style.width = "";
    for (const c of headerRow.children) (c as HTMLElement).style.width = "";
  }, []);

  const makeResizeHandle = useCallback((table: HTMLTableElement, cell: HTMLTableCellElement) => {
    const handle = document.createElement("span");
    handle.className = "md-col-resize";
    handle.setAttribute("aria-hidden", "true");
    handle.title = "Drag to resize · double-click to reset";
    handle.addEventListener("pointerdown", (e) => startResize(e as PointerEvent, cell, handle));
    handle.addEventListener("click", (e) => e.stopPropagation());
    handle.addEventListener("dblclick", () => {
      const headerRow = table.querySelector("thead tr");
      if (headerRow) resetColWidths(table, headerRow);
      syncOverflowClass(table); // back to auto layout — re-measure the fit
    });
    return handle;
  }, [startResize, resetColWidths, syncOverflowClass]);

  // Handles live on every visible header except the last one — the last
  // visible column is the flexible filler, so its edge must not be draggable.
  const syncResizeHandles = useCallback((table: HTMLTableElement) => {
    const headerRow = table.querySelector("thead tr");
    if (!headerRow) return;
    const cells = Array.from(headerRow.children) as HTMLTableCellElement[];
    const visible = cells.filter(c => !c.classList.contains("col-hidden"));
    const flex = visible[visible.length - 1];
    for (const cell of cells) {
      const existing = cell.querySelector(".md-col-resize");
      const resizable = visible.includes(cell) && cell !== flex;
      if (resizable && !existing) cell.appendChild(makeResizeHandle(table, cell));
      else if (!resizable && existing) existing.remove();
    }
  }, [makeResizeHandle]);

  const setColsHiddenClasses = useCallback((table: HTMLTableElement, hide: boolean) => {
    for (const row of table.querySelectorAll("tr")) {
      for (let i = COLLAPSE_AT; i < row.children.length; i++) {
        row.children[i].classList.toggle("col-hidden", hide);
      }
    }
  }, []);

  // Runs after every render (no dep array on purpose). While the model is
  // generating, the markdown tree keeps growing: new rows/cells arrive
  // without any of this component's imperative state, so collapse classes,
  // counts, filters and resize handles must be re-applied continuously —
  // a one-shot measure on hover left streamed rows unhidden mid-stream.
  // useLayoutEffect, not useEffect: passive effects run *after paint*, which
  // would flash every streamed row at full width for one frame before the
  // collapse classes land.
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const table = wrap?.querySelector<HTMLTableElement>("table.md-table");
    const headerRow = table?.querySelector("thead tr");
    if (!table || !headerRow) return;
    const cols = headerRow.children.length;
    const rows = table.querySelectorAll("tbody tr").length;
    const sortableNow = rows >= 5;
    if (sortable !== sortableNow) setSortable(sortableNow);
    if (colCount !== cols) setColCount(cols);
    if (rowCount !== rows) setRowCount(rows);
    const hide = cols > COLLAPSE_AT && !expanded;
    if (colsHiddenRef.current !== hide) {
      colsHiddenRef.current = hide;
      // Captured widths of hidden cells are 0 — expanding them back would
      // render 0px-wide columns, so drop manual sizing when the set flips.
      if (table.classList.contains("cols-resized")) resetColWidths(table, headerRow);
    }
    setColsHiddenClasses(table, hide);
    syncResizeHandles(table); // the flexible filler changes with the visible set
    syncOverflowClass(table); // expanded wide tables stop cells wrapping at once
    if (valueFiltersRef.current.size || termFiltersRef.current.size) applyFilter();
    else if (visibleRows !== rows) setVisibleRows(rows);
  });

  const handleHeaderClick = useCallback((e: React.MouseEvent) => {
    if (Date.now() - suppressSortAfterDragRef.current < 300) return; // a drag just ended — not a sort click
    const th = (e.target as Element).closest("th");
    if (!th) return;
    const table = th.closest("table");
    if (!table) return;
    const headers = Array.from(th.parentElement?.children ?? []);
    const col = headers.indexOf(th);
    if (col < 0) return;
    const tbody = table.querySelector("tbody");
    if (!tbody) return;
    const dir: 1 | -1 = sortRef.current?.col === col ? (sortRef.current.dir === 1 ? -1 : 1) : 1;
    sortRef.current = { col, dir };
    const rows = Array.from(tbody.querySelectorAll("tr"));
    rows.sort((a, b) => {
      const av = a.children[col]?.textContent ?? "";
      const bv = b.children[col]?.textContent ?? "";
      const an = parseFloat(av.replace(/,/g, ""));
      const bn = parseFloat(bv.replace(/,/g, ""));
      if (Number.isFinite(an) && Number.isFinite(bn)) return (an - bn) * dir;
      return av.localeCompare(bv) * dir;
    });
    for (const row of rows) tbody.appendChild(row);
    headers.forEach((h, i) => {
      h.classList.toggle("sort-asc", i === col && dir === 1);
      h.classList.toggle("sort-desc", i === col && dir === -1);
    });
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    const th = (e.target as Element).closest("th");
    if (!th) return;
    const col = Array.from(th.parentElement?.children ?? []).indexOf(th);
    if (col < 0) return;
    e.preventDefault();
    const values = new Map<string, true>();
    for (const row of th.closest("table")?.querySelectorAll("tbody tr") ?? []) {
      const value = (row.children[col]?.textContent ?? "").trim();
      if (value) values.set(value, true);
    }
    const options = Array.from(values.keys()).sort((a, b) => {
      const an = parseFloat(a.replace(/,/g, ""));
      const bn = parseFloat(b.replace(/,/g, ""));
      if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
      return a.localeCompare(b);
    }).slice(0, MAX_FILTER_OPTIONS);
    const existingValues = valueFiltersRef.current.get(col);
    const existingTerm = termFiltersRef.current.get(col) ?? "";
    setMenuOptions(options);
    setMenuChecked(existingValues ? new Set(options.filter(o => existingValues.has(o))) : new Set(options));
    setMenuSearch(existingTerm);
    setFilterMenu({
      col,
      left: Math.max(8, Math.min(e.clientX, window.innerWidth - 264)),
      top: Math.max(8, Math.min(e.clientY, window.innerHeight - 336)),
    });
    updateFilterMarks();
  }, [updateFilterMarks]);

  const commitMenuChecked = useCallback((next: Set<string>) => {
    if (!filterMenu) return;
    setMenuChecked(next);
    if (next.size === menuOptions.length) valueFiltersRef.current.delete(filterMenu.col);
    else valueFiltersRef.current.set(filterMenu.col, next);
    applyFilter();
  }, [filterMenu, menuOptions, applyFilter]);

  // The "contains" button toggles: clicking it while its term is the active
  // filter removes the term (Clear no longer doubles as the term reset).
  const applyMenuTextTerm = useCallback(() => {
    if (!filterMenu) return;
    const term = menuSearch.trim().toLowerCase();
    const active = !!term && (termFiltersRef.current.get(filterMenu.col) ?? "") === term;
    if (!term || active) termFiltersRef.current.delete(filterMenu.col);
    else termFiltersRef.current.set(filterMenu.col, term);
    applyFilter();
  }, [filterMenu, menuSearch, applyFilter]);

  useEffect(() => {
    if (!filterMenu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setFilterMenu(null); };
    const onDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setFilterMenu(null);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [filterMenu]);

  const toggleCols = useCallback(() => setExpanded(!expanded), [expanded]);

  // Only flips `expanded` — the resync effect applies the column hiding.
  const toggleFullscreen = useCallback(() => {
    if (!fullscreen) {
      savedExpandedRef.current = expanded;
      if (colCount > COLLAPSE_AT) setExpanded(true);
      setFullscreen(true);
      return;
    }
    if (colCount > COLLAPSE_AT) setExpanded(savedExpandedRef.current);
    setFullscreen(false);
  }, [fullscreen, expanded, colCount]);

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") toggleFullscreen(); };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [fullscreen, toggleFullscreen]);

  const handleCopyCsv = useCallback(async () => {
    const table = wrapRef.current?.querySelector("table");
    if (!table) return;
    const lines: string[] = [];
    for (const row of table.querySelectorAll("tr")) {
      if (row.parentElement?.tagName === "TBODY" && row.style.display === "none") continue;
      const cells = Array.from(row.children).map(cell => csvEscape(cell.textContent ?? ""));
      lines.push(cells.join(","));
    }
    const ok = await copyText(lines.join("\r\n"));
    setCopyStatus(ok ? "copied" : "failed");
    setTimeout(() => setCopyStatus("idle"), 2000);
  }, []);

  const wide = colCount > COLLAPSE_AT;
  const menuTermActive = filterMenu
    ? (termFiltersRef.current.get(filterMenu.col) ?? "") === menuSearch.trim().toLowerCase() && !!menuSearch.trim()
    : false;
  const visibleOptions = menuSearch.trim()
    ? menuOptions.filter(o => o.toLowerCase().includes(menuSearch.trim().toLowerCase()))
    : menuOptions;

  return (
    <div className={`md-table-wrap${fullscreen ? " is-fullscreen" : ""}`} ref={wrapRef}
      data-testid="md-table-wrap">
      <div className="md-table-topbar">
        <span className="md-table-count" data-testid="table-row-count">
          {filterMenu || visibleRows < rowCount ? `${visibleRows} of ${rowCount} rows` : ""}
        </span>
        <div className="md-table-ctls">
          {wide && (
            <button type="button"
              className={`md-table-ctl${expanded ? " is-active" : ""}`}
              onClick={toggleCols}
              aria-label={expanded ? "Collapse extra columns" : `Show ${colCount - COLLAPSE_AT} more columns`}
              title={expanded ? "Collapse columns" : `+${colCount - COLLAPSE_AT} columns`}
              data-testid="table-cols-btn">
              {expanded ? <ChevronsRightLeft className="w-3.5 h-3.5" /> : <ChevronsLeftRight className="w-3.5 h-3.5" />}
              {!expanded && <span className="text-xs">+{colCount - COLLAPSE_AT}</span>}
            </button>
          )}
          <button type="button" className="md-table-ctl" onClick={toggleFullscreen}
            aria-label={fullscreen ? "Exit fullscreen" : "View table fullscreen"}
            title={fullscreen ? "Exit fullscreen (Esc)" : "Fullscreen"}
            data-testid="table-fullscreen-btn">
            {fullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>
      <div className="md-table-scroller">
        <table className="md-table" onClick={sortable ? handleHeaderClick : undefined}
          onContextMenu={handleContextMenu}
          data-sortable={sortable ? "true" : undefined}>
          {children}
        </table>
      </div>
      <div className="md-table-tools">
        <span className="md-table-sort-hint" aria-hidden="true">
          <ArrowUpDown className="w-3 h-3" /> left-click headers to sort · right-click to filter · drag header edges to resize
        </span>
        <button type="button" className="md-table-csv" onClick={handleCopyCsv}
          aria-label="Copy table as CSV" data-testid="table-csv-btn">
          {copyStatus === "copied" ? <Check className="w-3.5 h-3.5 text-emerald-400" />
            : copyStatus === "failed" ? <span className="text-xs">Failed</span>
              : <Copy className="w-3.5 h-3.5" />}
          <span className="text-xs">{copyStatus === "copied" ? "CSV copied" : "CSV"}</span>
        </button>
      </div>
      {filterMenu && (
        <div className="md-table-filter-menu" ref={menuRef}
          style={{ left: filterMenu.left, top: filterMenu.top }}
          data-testid="table-filter-menu">
          <input className="md-table-menu-search" type="search" placeholder="Search or type a value…"
            value={menuSearch} autoFocus data-testid="filter-menu-search"
            onChange={(e) => setMenuSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") applyMenuTextTerm(); }} />
          {menuSearch.trim() && (
            <button type="button"
              className={`md-table-menu-text${menuTermActive ? " is-active" : ""}`}
              onClick={applyMenuTextTerm} data-testid="filter-menu-text">
              contains "{menuSearch.trim()}"
            </button>
          )}
          <div className="md-table-menu-list">
            {visibleOptions.map(option => (
              <label key={option}>
                <input type="checkbox" checked={menuChecked.has(option)}
                  onChange={() => {
                    const next = new Set(menuChecked);
                    if (next.has(option)) next.delete(option);
                    else next.add(option);
                    commitMenuChecked(next);
                  }} />
                <span>{option}</span>
              </label>
            ))}
            {visibleOptions.length === 0 && <div className="md-table-menu-empty">No matching values</div>}
          </div>
          <div className="md-table-menu-foot">
            <button type="button" title="Check every value"
              onClick={() => commitMenuChecked(new Set(menuOptions))}>All</button>
            <button type="button" title="Uncheck every value — then tick just the ones you want"
              onClick={() => commitMenuChecked(new Set())}>Clear</button>
            <span>{menuChecked.size === menuOptions.length ? "all" : `${menuChecked.size}/${menuOptions.length}`} selected</span>
          </div>
        </div>
      )}
    </div>
  );
});

function csvEscape(value: string): string {
  const flat = value.replace(/\r?\n/g, " ").trim();
  if (/[",]/.test(flat)) return `"${flat.replace(/"/g, '""')}"`;
  return flat;
}
