/**
 * Site permissions (Browser Use, Phase 13) — the human's editor for the
 * Rust authority engine's persisted rules (`fetchBrowserPolicy` /
 * `setBrowserPolicy` / `clearBrowserPolicy` → engine policy_get /
 * policy_set). Rules are host × facet → deny | always_ask | never_ask;
 * the global "*" row (shown as "all sites (global)") is what gates the
 * Phase-13 history and clear-data asks. The model never writes here —
 * authority is strictly the human's surface (Phase-9 law).
 *
 * Split out of BrowserPanel.tsx per CLAUDE.md §5.2 (component size).
 */
"use client";
import { useCallback, useEffect, useState } from "react";
import {
  clearBrowserPolicy,
  fetchBrowserPolicy,
  setBrowserPolicy,
  type BrowserDecision,
  type BrowserFacet,
  type BrowserPolicyData,
} from "../../lib/browser-client/browserClient";

const FACETS: { facet: BrowserFacet; label: string }[] = [
  { facet: "access", label: "Visit site" },
  { facet: "uploads", label: "Upload files" },
  { facet: "downloads", label: "Download files" },
  { facet: "full_cdp_access", label: "Advanced page access" },
  { facet: "history", label: "History & browsing data" },
];

const DECISION_LABELS: Record<BrowserDecision, string> = {
  deny: "Block",
  always_ask: "Ask",
  never_ask: "Allow",
};

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export default function PolicySettings({ currentHost }: { currentHost: string | null }) {
  const [policy, setPolicy] = useState<BrowserPolicyData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetchBrowserPolicy().then(
      (p) => { if (live) { setPolicy(p); setError(null); } },
      (err) => { if (live) setError(errText(err)); },
    );
    return () => { live = false; };
  }, []);

  // Every mutation replaces the whole rule set with the engine's
  // answer — never a local optimistic edit (the engine owns authority).
  const apply = useCallback((fn: () => Promise<BrowserPolicyData>) => {
    setError(null);
    fn().then(
      (p) => setPolicy(p),
      (err) => setError(errText(err)),
    );
  }, []);

  const rules = policy?.rules ?? {};
  const hosts = Object.keys(rules).sort((a, b) =>
    a === "*" ? -1 : b === "*" ? 1 : a.localeCompare(b),
  );

  return (
    <div className="bp-policy" role="region" aria-label="Site permissions" data-testid="policy-settings">
      <div className="bp-policy-title">
        Site permissions
        {currentHost && !rules[currentHost] && (
          <button
            className="bp-btn"
            data-testid={`policy-add-current-${currentHost}`}
            onClick={() => apply(() => setBrowserPolicy(currentHost, "access", "always_ask"))}
          >
            Add rule for {currentHost}
          </button>
        )}
      </div>
      {error && <p className="bp-card-text">{error}</p>}
      {!error && policy && hosts.length === 0 && (
        <p className="bp-card-text">No saved rules — RUKE asks before every gated action.</p>
      )}
      {hosts.map((host) => (
        <div className="bp-policy-host" key={host} data-testid={`policy-host-${host}`}>
          <div className="bp-policy-host-head">
            <span className="bp-policy-host-name">
              {host === "*" ? "all sites (global)" : host}
            </span>
            <button
              className="bp-btn"
              data-testid={`policy-forget-${host}`}
              onClick={() => apply(() => clearBrowserPolicy(host))}
            >
              Forget
            </button>
          </div>
          {FACETS.filter((f) => rules[host]?.[f.facet]).map(({ facet, label }) => (
            <div className="bp-policy-row" key={facet}>
              <label htmlFor={`policy-select-${host}-${facet}`}>{label}</label>
              <select
                id={`policy-select-${host}-${facet}`}
                className="bp-policy-select"
                data-testid={`policy-select-${host}-${facet}`}
                value={rules[host]?.[facet] ?? "always_ask"}
                onChange={(ev) =>
                  apply(() => setBrowserPolicy(host, facet, ev.target.value as BrowserDecision))
                }
              >
                {(Object.keys(DECISION_LABELS) as BrowserDecision[]).map((d) => (
                  <option key={d} value={d}>
                    {DECISION_LABELS[d]}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
