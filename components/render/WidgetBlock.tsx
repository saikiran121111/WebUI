"use client";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Minus, TrendingDown, TrendingUp } from "lucide-react";
import CodeBlock from "./CodeBlock";
import {
  parseJsonFence, widgetSpecSchema,
  type WidgetSpec, type WidgetField, type KpiCard,
} from "../../lib/render/schemas";
import MarkdownRenderer from "../MarkdownRenderer";

interface WidgetBlockProps {
  source: string;
  streaming?: boolean;
  onSend?: (text: string) => void;
}

/**
 * Interactive generative UI from ```widget fences. The spec is validated
 * against a closed zod union — unknown shapes fall back to source, and the
 * model can never inject markup or behavior. Form state survives streaming
 * re-renders because the last valid spec (and its values) are kept in refs.
 */
export default memo(function WidgetBlock({ source, streaming = false, onSend }: WidgetBlockProps) {
  const parsed = useMemo(() => parseJsonFence(source, widgetSpecSchema), [source]);
  // Keep the last good spec so partial JSON mid-stream doesn't unmount the widget.
  const lastGoodRef = useRef<WidgetSpec | null>(null);
  if (parsed.ok) lastGoodRef.current = parsed.value;

  if (!parsed.ok) {
    const held = lastGoodRef.current;
    if (streaming && held) return <WidgetBody spec={held} onSend={onSend} />;
    if (streaming) return null;
    return (
      <div className="widget-block" data-testid="widget-error">
        <div className="diagram-error-note">Widget spec did not validate — showing the source instead.</div>
        <CodeBlock code={source} lang="json" />
      </div>
    );
  }
  return <WidgetBody spec={parsed.value} onSend={onSend} />;
});

function WidgetBody({ spec, onSend }: { spec: WidgetSpec; onSend?: (text: string) => void }) {
  if (spec.kind === "form") return <FormWidget spec={spec} onSend={onSend} />;
  if (spec.kind === "tabs") return <TabsWidget spec={spec} />;
  if (spec.kind === "kpi") return <KpiWidget spec={spec} onSend={onSend} />;
  return <AccordionWidget spec={spec} />;
}

type FieldValue = string | number | boolean;

function initialValues(fields: WidgetField[]): Record<string, FieldValue> {
  const values: Record<string, FieldValue> = {};
  for (const f of fields) {
    if (f.default !== undefined) values[f.name] = f.default;
    else if (f.type === "checkbox") values[f.name] = false;
    else if (f.type === "number" || f.type === "slider") values[f.name] = f.min ?? 0;
    else values[f.name] = "";
  }
  return values;
}

function validateField(field: WidgetField, value: FieldValue): string | null {
  const empty = value === "" || value === false && field.type === "checkbox" && field.required;
  if (field.required && (value === "" || value === null || value === undefined)) {
    return `${field.label} is required`;
  }
  if (empty && !field.required) return null;
  if (field.type === "number" || field.type === "slider") {
    const num = Number(value);
    if (!Number.isFinite(num)) return `${field.label} must be a number`;
    if (field.min !== undefined && num < field.min) return `${field.label} must be at least ${field.min}`;
    if (field.max !== undefined && num > field.max) return `${field.label} must be at most ${field.max}`;
  }
  if (field.type === "text" || field.type === "textarea" || field.type === "email") {
    const text = String(value);
    if (field.minLength !== undefined && text.length < field.minLength) {
      return `${field.label} needs at least ${field.minLength} characters`;
    }
    if (field.maxLength !== undefined && text.length > field.maxLength) {
      return `${field.label} must be under ${field.maxLength} characters`;
    }
    if (field.type === "email" && text && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
      return `${field.label} must be a valid email`;
    }
  }
  return null;
}

function FormWidget({ spec, onSend }: {
  spec: Extract<WidgetSpec, { kind: "form" }>;
  onSend?: (text: string) => void;
}) {
  const [values, setValues] = useState<Record<string, FieldValue>>(() => initialValues(spec.fields));
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [submitted, setSubmitted] = useState<string | null>(null);
  const mountedKey = useRef(spec.fields.map(f => f.name).join(","));

  // If the spec's fields change identity (a genuinely new form), reset state.
  useEffect(() => {
    const key = spec.fields.map(f => f.name).join(",");
    if (key !== mountedKey.current) {
      mountedKey.current = key;
      setValues(initialValues(spec.fields));
      setErrors({});
      setSubmitted(null);
    }
  }, [spec.fields]);

  const setValue = (name: string, value: FieldValue) => {
    setValues(v => ({ ...v, [name]: value }));
    setErrors(e => (e[name] ? { ...e, [name]: null } : e));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const nextErrors: Record<string, string | null> = {};
    let valid = true;
    for (const field of spec.fields) {
      const err = validateField(field, values[field.name]);
      nextErrors[field.name] = err;
      if (err) valid = false;
    }
    setErrors(nextErrors);
    if (!valid) return;
    const lines = spec.fields.map(f => {
      const raw = values[f.name];
      const shown = f.type === "checkbox" ? (raw ? "yes" : "no") : String(raw);
      return `${f.label}: ${shown}`;
    });
    const summary = `${spec.title ?? "Form submission"}\n${lines.join("\n")}`;
    setSubmitted(summary);
    onSend?.(summary);
  };

  return (
    <form className="widget-block widget-form" onSubmit={handleSubmit} data-testid="widget-form" noValidate>
      {spec.title && <div className="widget-title">{spec.title}</div>}
      {spec.description && <div className="widget-desc">{spec.description}</div>}
      {spec.fields.map(field => (
        <FieldControl key={field.name} field={field} value={values[field.name]}
          error={errors[field.name] ?? null} onChange={v => setValue(field.name, v)} />
      ))}
      <div className="widget-form-actions">
        <button type="submit" className="widget-submit" disabled={!onSend}>
          {spec.submitLabel ?? "Submit"}
        </button>
        {submitted && <span className="widget-sent-note" aria-live="polite">Sent</span>}
      </div>
    </form>
  );
}

function FieldControl({ field, value, error, onChange }: {
  field: WidgetField;
  value: FieldValue | undefined;
  error: string | null;
  onChange: (v: FieldValue) => void;
}) {
  const id = `widget-field-${field.name}`;
  const describedBy = error ? `${id}-error` : undefined;
  const invalid = !!error;

  return (
    <div className={"widget-field" + (invalid ? " has-error" : "")}>
      {field.type !== "checkbox" && (
        <label htmlFor={id} className="widget-label">
          {field.label}
          {field.required && <span className="widget-required" aria-hidden="true"> *</span>}
        </label>
      )}

      {field.type === "textarea" && (
        <textarea id={id} rows={4} value={String(value ?? "")} placeholder={field.placeholder}
          aria-invalid={invalid} aria-describedby={describedBy}
          onChange={e => onChange(e.target.value)} />
      )}
      {(field.type === "text" || field.type === "email" || field.type === "date" || field.type === "time") && (
        <input id={id} type={field.type} value={String(value ?? "")} placeholder={field.placeholder}
          aria-invalid={invalid} aria-describedby={describedBy}
          onChange={e => onChange(e.target.value)} />
      )}
      {field.type === "number" && (
        <input id={id} type="number" value={String(value ?? "")} min={field.min} max={field.max} step={field.step}
          aria-invalid={invalid} aria-describedby={describedBy}
          onChange={e => onChange(e.target.value === "" ? "" : Number(e.target.value))} />
      )}
      {field.type === "slider" && (
        <div className="widget-slider-row">
          <input id={id} type="range" value={Number(value ?? field.min ?? 0)}
            min={field.min ?? 0} max={field.max ?? 100} step={field.step ?? 1}
            aria-describedby={describedBy}
            onChange={e => onChange(Number(e.target.value))} />
          <span className="widget-slider-value">{String(value ?? field.min ?? 0)}</span>
        </div>
      )}
      {field.type === "select" && (
        <select id={id} value={String(value ?? "")} aria-invalid={invalid} aria-describedby={describedBy}
          onChange={e => onChange(e.target.value)}>
          <option value="">{field.placeholder ?? "Choose…"}</option>
          {(field.options ?? []).map(opt => <option key={opt} value={opt}>{opt}</option>)}
        </select>
      )}
      {field.type === "radio" && (
        <div role="radiogroup" aria-labelledby={id} className="widget-radio-group" id={id}>
          {(field.options ?? []).map(opt => (
            <label key={opt} className="widget-radio">
              <input type="radio" name={field.name} value={opt} checked={value === opt}
                onChange={() => onChange(opt)} />
              {opt}
            </label>
          ))}
        </div>
      )}
      {field.type === "checkbox" && (
        <label className="widget-checkbox">
          <input id={id} type="checkbox" checked={!!value} aria-describedby={describedBy}
            onChange={e => onChange(e.target.checked)} />
          {field.label}
          {field.required && <span className="widget-required" aria-hidden="true"> *</span>}
        </label>
      )}

      {error && <div id={`${id}-error`} className="widget-field-error" role="alert">{error}</div>}
    </div>
  );
}

function TabsWidget({ spec }: { spec: Extract<WidgetSpec, { kind: "tabs" }> }) {
  const [active, setActive] = useState(0);
  return (
    <div className="widget-block widget-tabs" data-testid="widget-tabs">
      <div role="tablist" className="widget-tablist">
        {spec.items.map((item, i) => (
          <button key={item.label} role="tab" type="button"
            id={`widget-tab-${i}`} aria-selected={i === active} aria-controls={`widget-tabpanel-${i}`}
            tabIndex={i === active ? 0 : -1}
            className={"widget-tab" + (i === active ? " is-active" : "")}
            onClick={() => setActive(i)}
            onKeyDown={e => {
              if (e.key === "ArrowRight") setActive(a => (a + 1) % spec.items.length);
              else if (e.key === "ArrowLeft") setActive(a => (a - 1 + spec.items.length) % spec.items.length);
              else return;
              e.preventDefault();
            }}>
            {item.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`widget-tabpanel-${active}`} aria-labelledby={`widget-tab-${active}`}
        className="widget-tabpanel" tabIndex={0}>
        <MarkdownRenderer content={spec.items[active].content} allowInteractive={false} />
      </div>
    </div>
  );
}

function AccordionWidget({ spec }: { spec: Extract<WidgetSpec, { kind: "accordion" }> }) {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <div className="widget-block widget-accordion" data-testid="widget-accordion">
      {spec.items.map((item, i) => {
        const isOpen = open === i;
        return (
          <div key={item.label} className={"widget-accordion-item" + (isOpen ? " is-open" : "")}>
            <button type="button" className="widget-accordion-trigger"
              id={`widget-acc-trigger-${i}`} aria-expanded={isOpen} aria-controls={`widget-acc-panel-${i}`}
              onClick={() => setOpen(isOpen ? null : i)}>
              <span>{item.label}</span>
              <ChevronDown className={"w-4 h-4 widget-accordion-chevron" + (isOpen ? " is-open" : "")} aria-hidden="true" />
            </button>
            {isOpen && (
              <div role="region" id={`widget-acc-panel-${i}`} aria-labelledby={`widget-acc-trigger-${i}`}
                className="widget-accordion-panel">
                <MarkdownRenderer content={item.content} allowInteractive={false} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ── KPI value cards + live formula calculators ───────────────────────── */

const KPI_TREND_META = {
  up: { icon: TrendingUp, className: "kpi-trend-up" },
  down: { icon: TrendingDown, className: "kpi-trend-down" },
  neutral: { icon: Minus, className: "kpi-trend-neutral" },
} as const;

/** Bound-slider math: multiply = factor, add = amount, percent = % change. */
function applyKpiOperation(base: number, operation: KpiCard["operation"], amount: number): number {
  if (operation === "add") return base + amount;
  if (operation === "percent") return base * (1 + amount / 100);
  return base * amount;
}

function formatKpiNumber(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function KpiWidget({ spec, onSend }: {
  spec: Extract<WidgetSpec, { kind: "kpi" }>;
  onSend?: (text: string) => void;
}) {
  const sliders = spec.sliders ?? [];
  const [sliderValues, setSliderValues] = useState<Record<string, number>>(
    () => Object.fromEntries(sliders.map(s => [s.id, s.defaultValue])),
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Slider moves recompute every bound card value + sparkline point in one
  // memo pass — the whole grid is small, so each input event stays 60fps.
  const computed = useMemo(() => {
    const sliderById = new Map(sliders.map(s => [s.id, s]));
    return spec.cards.map(card => {
      const slider = card.bindSlider ? sliderById.get(card.bindSlider) : undefined;
      const amount = slider ? sliderValues[slider.id] ?? slider.defaultValue : 0;
      const raw = slider ? applyKpiOperation(card.value, card.operation, amount) : card.value;
      const display = Number.isFinite(raw) ? raw : card.value;
      const sparkline = slider && card.sparkline
        ? card.sparkline.map(p => {
            const scaled = applyKpiOperation(p, card.operation, amount);
            return Number.isFinite(scaled) ? scaled : p;
          })
        : card.sparkline;
      return { card, display, sparkline };
    });
  }, [spec.cards, sliders, sliderValues]);

  const selected = computed.find(c => c.card.id === selectedId) ?? null;

  return (
    <div className="widget-block kpi-block" data-testid="kpi-block">
      {spec.title && <div className="widget-title">{spec.title}</div>}
      {spec.insight && <div className="widget-desc">{spec.insight}</div>}
      {sliders.length > 0 && (
        <div className="kpi-sliders">
          {sliders.map(s => (
            <div key={s.id} className="widget-slider-row">
              <label className="widget-label" htmlFor={`kpi-slider-${s.id}`}>{s.label}</label>
              <input id={`kpi-slider-${s.id}`} data-testid={`kpi-slider-${s.id}`} type="range"
                min={s.min} max={s.max} step={s.step ?? 1} value={sliderValues[s.id] ?? s.defaultValue}
                onChange={e => setSliderValues(v => ({ ...v, [s.id]: Number(e.target.value) }))} />
              <span className="widget-slider-value">
                {formatKpiNumber(sliderValues[s.id] ?? s.defaultValue)}{s.unit ? ` ${s.unit}` : ""}
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="kpi-grid">
        {computed.map(({ card, display, sparkline }) => {
          const trend = card.trend ? KPI_TREND_META[card.trend] : null;
          const TrendIcon = trend?.icon;
          return (
            <button key={card.id} type="button" data-testid={`kpi-card-${card.id}`}
              className={"kpi-card" + (selectedId === card.id ? " is-selected" : "")}
              aria-pressed={selectedId === card.id}
              onClick={() => setSelectedId(prev => (prev === card.id ? null : card.id))}>
              <span className="kpi-card-label">{card.label}</span>
              <span className="kpi-card-value" data-testid={`kpi-value-${card.id}`}>
                {card.prefix ?? ""}{formatKpiNumber(display)}{card.unit ?? ""}
              </span>
              {card.delta && trend && (
                <span className={"kpi-trend " + trend.className}>
                  {TrendIcon && <TrendIcon aria-hidden="true" />}
                  {card.delta}
                </span>
              )}
              {sparkline && sparkline.length >= 2 && <KpiSparkline points={sparkline} />}
            </button>
          );
        })}
      </div>
      {selected && (
        <div className="kpi-callout" data-testid="kpi-callout">
          <span className="kpi-callout-formula">{selected.card.formula ?? selected.card.label}</span>
          {selected.card.detail && <span className="kpi-callout-detail">{selected.card.detail}</span>}
          {onSend && (
            <button type="button" className="viz-ask-btn" data-testid="kpi-ask-btn"
              onClick={() => onSend(
                `About this metric — ${selected.card.label}: ${selected.card.formula ?? selected.card.label}` +
                ` (currently ${formatKpiNumber(selected.display)}${selected.card.unit ?? ""}). What does it tell us?`,
              )}>
              Ask AI about this metric
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function KpiSparkline({ points }: { points: number[] }) {
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const stepX = 100 / (points.length - 1);
  const path = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${(i * stepX).toFixed(2)} ${(28 - ((p - min) / range) * 26).toFixed(2)}`)
    .join(" ");
  return (
    <svg className="kpi-spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
      <path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
