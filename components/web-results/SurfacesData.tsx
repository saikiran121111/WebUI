"use client";
/**
 * SurfacesData.tsx — data & learning surfaces: table / chart / timeline
 * wrappers over the §5 primitives, plus the §68 learning kit
 * (flashcards, quiz, schema-driven simulation) and the §39 sandboxed
 * AppResult. §38/§39 law: the simulation never evaluates retrieved code
 * — outputs are a schema-declared weighted sum the LOCAL component
 * computes; AppResult sections re-dispatch ONLY through known local
 * renderers, never raw retrieved HTML.
 */
import { memo, useMemo, useState } from "react";
import type { RichResult } from "../../lib/web-search/rich-results";
import { RichResultFrame } from "./RichResultFrame";
import {
  InteractiveChart, InteractiveTable, ResultEmpty, ResultTimeline,
} from "./ResultPrimitives";
import { itemsOf, num, obj, str, strList } from "./resultHelpers";

/* ── table / chart / timeline kind wrappers ───────────────────────────── */
export const TableResult = memo(function TableResult({ surface }: { surface: RichResult }) {
  return <RichResultFrame surface={surface} supportsFullscreen><InteractiveTable payload={surface.payload as Record<string, unknown>} /></RichResultFrame>;
});

export const ChartResult = memo(function ChartResult({ surface }: { surface: RichResult }) {
  return <RichResultFrame surface={surface} supportsFullscreen><InteractiveChart payload={surface.payload as Record<string, unknown>} /></RichResultFrame>;
});

export const TimelineResult = memo(function TimelineResult({ surface }: { surface: RichResult }) {
  return <RichResultFrame surface={surface}><ResultTimeline payload={surface.payload as Record<string, unknown>} /></RichResultFrame>;
});

/* ── §68 flashcards: flip is local state; content is payload-only ─────── */
export const FlashcardDeck = memo(function FlashcardDeck({ surface }: { surface: RichResult }) {
  const cards = itemsOf(surface.payload as Record<string, unknown>, "cards").slice(0, 100);
  const [i, setI] = useState(0);
  const [flipped, setFlipped] = useState(false);
  if (!cards.length) {
    return <RichResultFrame surface={surface}><ResultEmpty text="No cards." /></RichResultFrame>;
  }
  const card = cards[Math.min(i, cards.length - 1)];
  return (
    <RichResultFrame surface={surface}>
      <button type="button" className="wr-flashcard" data-testid="flashcard"
        aria-label={`Card ${i + 1} of ${cards.length}. Activate to ${flipped ? "show question" : "show answer"}.`}
        aria-pressed={flipped}
        onClick={() => setFlipped((f) => !f)}>
        <span className="wr-card-title">{(flipped ? str(card.back, 600) : str(card.front, 300)) ?? "—"}</span>
        <span className="wr-card-note">{flipped ? "Answer" : "Question"} — click to flip</span>
      </button>
      <div className="wr-action-row">
        <button type="button" className="wr-action" aria-label="Previous card" disabled={i === 0}
          onClick={() => { setI((v) => Math.max(0, v - 1)); setFlipped(false); }}>Prev</button>
        <span className="wr-card-note">{i + 1} / {cards.length}</span>
        <button type="button" className="wr-action" aria-label="Next card" disabled={i >= cards.length - 1}
          onClick={() => { setI((v) => Math.min(cards.length - 1, v + 1)); setFlipped(false); }}>Next</button>
      </div>
    </RichResultFrame>
  );
});

/* ── §68 quiz: options + correctIndex come from the schema; checking is
 *  LOCAL (no network), scoring never mutates the payload ───────────────── */
export const QuizResult = memo(function QuizResult({ surface }: { surface: RichResult }) {
  const questions = itemsOf(surface.payload as Record<string, unknown>, "questions").slice(0, 20);
  const [picked, setPicked] = useState<Record<number, number>>({});
  const [checked, setChecked] = useState<Record<number, boolean>>({});
  if (!questions.length) {
    return <RichResultFrame surface={surface}><ResultEmpty text="No questions." /></RichResultFrame>;
  }
  return (
    <RichResultFrame surface={surface}>
      <div className="wr-list">
        {questions.map((q, qi) => {
          const options = strList(q.options, 10);
          const correct = num(q.correctIndex);
          const sel = picked[qi];
          const done = checked[qi];
          return (
            <div key={qi} role="group" aria-label={`Question ${qi + 1}`}>
              <div className="wr-card-title">{str(q.prompt, 400) ?? `Question ${qi + 1}`}</div>
              <div role="radiogroup" aria-label={`Choices for question ${qi + 1}`} style={{ display: "grid", gap: 4, marginTop: 4 }}>
                {options.map((opt, oi) => {
                  const isCorrect = done && correct === oi;
                  const isWrong = done && sel === oi && correct !== oi;
                  return (
                    <button key={oi} type="button" role="radio" aria-checked={sel === oi} disabled={done}
                      className={`wr-quiz-option${isCorrect ? " wr-quiz-option--correct" : ""}${isWrong ? " wr-quiz-option--wrong" : ""}`}
                      onClick={() => setPicked((s) => ({ ...s, [qi]: oi }))}>
                      {opt}
                    </button>
                  );
                })}
              </div>
              {!done
                ? <div className="wr-action-row"><button type="button" className="wr-action" disabled={sel === undefined}
                    aria-label={`Check answer for question ${qi + 1}`} onClick={() => setChecked((s) => ({ ...s, [qi]: true }))}>Check</button></div>
                : <div className="wr-card-note" aria-live="polite">
                    {correct === sel ? "Correct." : correct !== undefined ? `Answer: ${options[correct] ?? "—"}` : "Answer key not in payload."}
                    {str(q.explanation, 400) ? ` ${str(q.explanation, 400)}` : ""}
                  </div>}
            </div>
          );
        })}
      </div>
    </RichResultFrame>
  );
});

/* ── §68 simulation: sliders drive a DECLARED linear combination. No
 *  eval, no Function(), no retrieved formulas run — the weights are data. ─ */
export const SimulationResult = memo(function SimulationResult({ surface }: { surface: RichResult }) {
  const p = surface.payload as Record<string, unknown>;
  const vars = itemsOf(p, "variables").slice(0, 12);
  const outputs = itemsOf(p, "outputs").slice(0, 6);
  const [vals, setVals] = useState<Record<string, number>>(() => {
    const init: Record<string, number> = {};
    for (const v of vars) {
      const id = str(v.id, 40);
      const d = num(v.default);
      if (id && d !== undefined) init[id] = d;
    }
    return init;
  });
  const computed = useMemo(() => outputs.map((o) => {
    const coefs = obj(o.coefficients) ?? {};
    let sum = num(o.base) ?? 0;
    let used = false;
    for (const [k, wRaw] of Object.entries(coefs)) {
      const w = num(wRaw);
      const x = vals[k] ?? num(vars.find((v) => str(v.id, 40) === k)?.default);
      if (w !== undefined && x !== undefined) { sum += w * x; used = true; }
    }
    return { label: str(o.label, 80) ?? "Output", value: used ? sum : undefined };
  }), [outputs, vals, vars]);

  if (!vars.length || !outputs.length) {
    return <RichResultFrame surface={surface}><ResultEmpty text="Simulation needs declared inputs and outputs." /></RichResultFrame>;
  }
  return (
    <RichResultFrame surface={surface}>
      {vars.map((v, i) => {
        const id = str(v.id, 40) ?? `v${i}`;
        const min = num(v.min) ?? 0;
        const max = num(v.max) ?? 100;
        const cur = vals[id] ?? num(v.default) ?? min;
        return (
          <label key={i} className="wr-card-line" style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4 }}>
            <span style={{ minWidth: 90 }}>{str(v.label, 60) ?? id}</span>
            <input type="range" min={min} max={max} step="any" value={Math.min(max, Math.max(min, cur))}
              aria-label={str(v.label, 60) ?? id}
              onChange={(e) => setVals((s) => ({ ...s, [id]: Number(e.target.value) }))} />
            <span className="wr-card-note" style={{ minWidth: 48, textAlign: "right" }}>{Number(cur.toFixed(2))}</span>
          </label>
        );
      })}
      <div className="wr-metrics" style={{ marginTop: 8 }}>
        {computed.map((o, i) => (
          <div key={i} className="wr-metric" data-testid="simulation-output">
            <span className="wr-metric-value">{o.value !== undefined ? Number(o.value.toFixed(3)) : "—"}</span>
            <span className="wr-metric-label">{o.label}</span>
          </div>
        ))}
      </div>
    </RichResultFrame>
  );
});

/* ── §39 AppResult: a declared section list re-dispatched through the
 *  SAME local primitives. There is no HTML section, no script section,
 *  and no iframe section — anything unknown is dropped. ────────────────── */
export const AppResult = memo(function AppResult({ surface }: { surface: RichResult }) {
  const p = surface.payload as Record<string, unknown>;
  const sections = itemsOf(p, "sections").slice(0, 20);
  if (!sections.length) {
    return <RichResultFrame surface={surface}><ResultEmpty text="Nothing to show." /></RichResultFrame>;
  }
  return (
    <RichResultFrame surface={surface}>
      {sections.map((s, i) => {
        const kind = str(s.kind, 24);
        const sp = obj(s.payload) ?? {};
        switch (kind) {
          case "heading": return <div key={i} className="wr-card-title">{str(sp.text, 160) ?? ""}</div>;
          case "text": return <p key={i} className="wr-card-line" style={{ margin: "4px 0" }}>{str(sp.text, 2000) ?? ""}</p>;
          case "list": return (
            <div key={i} className="wr-list">
              {strList(sp.items, 20).map((t, j) => <div key={j} className="wr-card-line">{t}</div>)}
            </div>
          );
          case "table": return <InteractiveTable key={i} payload={sp} />;
          case "chart": return <InteractiveChart key={i} payload={sp} />;
          case "timeline": return <ResultTimeline key={i} payload={sp} />;
          default: return null; // unknown section: dropped, never rendered raw
        }
      })}
    </RichResultFrame>
  );
});
