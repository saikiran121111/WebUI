"use client";
import { useCallback, useEffect, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { Blocks, Download, Loader2, ShieldAlert, Trash2, X, Zap } from "lucide-react";
import { cn } from "../lib/utils";
import type { SkillRecord } from "../lib/skills/types";

interface SkillsModalProps {
  open: boolean;
  onClose: () => void;
}

type SkillsTab = "install" | "installed";

/**
 * Two-tab skills manager: download a REAL skill from a repo (Tab 1) and tune
 * each installed skill's lazy-loading scenario (Tab 2). All state lives here
 * so ChatInput only needs open/close.
 */
export default function SkillsModal({ open, onClose }: SkillsModalProps) {
  const reducedMotion = useReducedMotion();
  const [tab, setTab] = useState<SkillsTab>("install");
  const [skills, setSkills] = useState<SkillRecord[]>([]);

  const [repoOrCommand, setRepoOrCommand] = useState("");
  const [autoUse, setAutoUse] = useState(false);
  const [whenToUse, setWhenToUse] = useState("");

  const [busy, setBusy] = useState(false);
  const [statusLine, setStatusLine] = useState("");
  const [errorLine, setErrorLine] = useState("");
  const [drafts, setDrafts] = useState<Record<string, { autoUse: boolean; whenToUse: string }>>({});

  const refresh = useCallback(() => {
    fetch("/api/skills")
      .then((r) => (r.ok ? r.json() : { skills: [] }))
      .then((data) => {
        const list: SkillRecord[] = Array.isArray(data?.skills) ? data.skills : [];
        setSkills(list);
        setDrafts((prev) => {
          const next = { ...prev };
          for (const s of list) {
            if (!next[s.skillName]) next[s.skillName] = { autoUse: s.autoUse, whenToUse: s.whenToUse };
          }
          return next;
        });
      })
      .catch(() => {});
  }, []);

  useEffect(() => { if (open) refresh(); }, [open, refresh]);

  const handleInstall = useCallback(async () => {
    if (!repoOrCommand.trim() || busy) return;
    setBusy(true);
    setErrorLine("");
    setStatusLine("Running: npx -y skills add " + repoOrCommand.trim() + " …");
    try {
      const res = await fetch("/api/skills/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoOrCommand: repoOrCommand.trim(),
          autoUse,
          whenToUse: whenToUse.trim(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErrorLine(data?.error ?? "Install failed");
        setStatusLine("");
        return;
      }
      setStatusLine("Installed: " + (data.installedSkillNames ?? []).join(", "));
      setRepoOrCommand("");
      setWhenToUse("");
      setAutoUse(false);
      refresh();
    } catch (err: unknown) {
      setErrorLine(err instanceof Error ? err.message : "Install failed");
      setStatusLine("");
    } finally {
      setBusy(false);
    }
  }, [repoOrCommand, autoUse, whenToUse, busy, refresh]);

  const handleSave = useCallback(async (skillName: string) => {
    const draft = drafts[skillName];
    if (!draft) return;
    setBusy(true);
    setErrorLine("");
    try {
      const res = await fetch("/api/skills/" + encodeURIComponent(skillName) + "/scenario", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoUse: draft.autoUse, whenToUse: draft.whenToUse }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setErrorLine(data?.error ?? "Save failed");
        return;
      }
      refresh();
    } finally {
      setBusy(false);
    }
  }, [drafts, refresh]);

  const handleDelete = useCallback(async (skillName: string) => {
    setBusy(true);
    setErrorLine("");
    try {
      const res = await fetch("/api/skills/" + encodeURIComponent(skillName), { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setErrorLine(data?.error ?? "Delete failed");
        return;
      }
      refresh();
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const motionPreset = reducedMotion
    ? { duration: 0 }
    : { duration: 0.18, ease: [0.22, 1, 0.36, 1] as const };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reducedMotion ? 0 : 0.12 }}
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          onClick={onClose}
        >
          <div className="fixed inset-0 bg-black/70 backdrop-blur-sm" />
          <motion.div
            initial={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 8 }}
            animate={reducedMotion ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 8 }}
            transition={motionPreset}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Skills"
            data-testid="skills-modal"
            className="relative w-full max-w-xl max-h-[85vh] flex flex-col rounded-xl
              bg-[#0d0d12] border border-white/[0.1] shadow-2xl shadow-black/60"
          >
            {/* Header + tabs */}
            <div className="flex items-center gap-3 px-4 pt-4 pb-2 border-b border-white/[0.06]">
              <Blocks className="w-4 h-4 text-white/60" />
              <div className="flex gap-1">
                {(["install", "installed"] as SkillsTab[]).map((t) => (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    data-testid={"skills-tab-" + t}
                    className={cn(
                      "px-3 py-1.5 text-xs font-medium rounded-lg transition-colors",
                      tab === t ? "bg-white/[0.08] text-white/90" : "text-white/40 hover:text-white/70",
                    )}
                  >
                    {t === "install" ? "Install Skill" : "Installed Skills"}
                    {t === "installed" && (
                      <span className="ml-1.5 text-[10px] text-white/30 tabular-nums">{skills.length}</span>
                    )}
                  </button>
                ))}
              </div>
              <button
                onClick={onClose}
                className="ml-auto p-1.5 rounded-lg text-white/40 hover:text-white/80 hover:bg-white/[0.06] transition-colors"
                aria-label="Close skills modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              {tab === "install" && (
                <div className="space-y-3">
                  <p className="text-xs text-white/40 leading-relaxed">
                    Downloads a real skill from a repository with{" "}
                    <code className="text-white/60">npx -y skills add</code> and moves it into{" "}
                    <code className="text-white/60">./skills/</code>. Custom skills are never
                    written from scratch.
                  </p>
                  <input
                    value={repoOrCommand}
                    onChange={(e) => setRepoOrCommand(e.target.value)}
                    data-testid="install-repo-input"
                    placeholder="owner/repo  ·  owner/repo --skill name  ·  npx skills add …"
                    className="w-full bg-white/[0.04] border border-white/[0.1] rounded-lg px-3 py-2.5
                      text-sm text-white placeholder-white/30 outline-none
                      focus:border-white/25 transition-colors"
                  />
                  <label className="flex items-center gap-2 text-xs text-white/60 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={autoUse}
                      onChange={(e) => setAutoUse(e.target.checked)}
                      data-testid="install-autouse-toggle"
                      className="accent-indigo-500"
                    />
                    Auto-use this skill from a matching scenario
                  </label>
                  <textarea
                    value={whenToUse}
                    onChange={(e) => setWhenToUse(e.target.value)}
                    data-testid="install-whentouse"
                    rows={2}
                    placeholder="whenToUse — when should this skill fire automatically?"
                    className="w-full bg-white/[0.04] border border-white/[0.1] rounded-lg px-3 py-2.5
                      text-sm text-white placeholder-white/30 outline-none resize-none
                      focus:border-white/25 transition-colors"
                  />
                  <button
                    onClick={handleInstall}
                    disabled={!repoOrCommand.trim() || busy}
                    data-testid="install-button"
                    className={cn(
                      "flex items-center gap-2 px-4 py-2 text-xs font-medium rounded-lg transition-all",
                      repoOrCommand.trim() && !busy
                        ? "bg-white text-black hover:bg-white/90 active:scale-[0.96]"
                        : "bg-white/[0.08] text-white/30 cursor-not-allowed",
                    )}
                  >
                    {busy
                      ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      : <Download className="w-3.5 h-3.5" />}
                    Install
                  </button>

                  {(statusLine || errorLine) && (
                    <div
                      data-testid="install-status"
                      className={cn(
                        "flex items-start gap-2 px-3 py-2 rounded-lg text-xs leading-relaxed",
                        errorLine
                          ? "bg-red-500/[0.06] border border-red-500/15 text-red-400"
                          : "bg-white/[0.03] border border-white/[0.07] text-white/50",
                      )}
                    >
                      {errorLine ? <ShieldAlert className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" /> : null}
                      <span className="whitespace-pre-wrap break-words font-mono text-[11px]">
                        {errorLine || statusLine}
                      </span>
                    </div>
                  )}
                </div>
              )}

              {tab === "installed" && (
                <div className="space-y-3" data-testid="installed-list">
                  {skills.length === 0 && (
                    <p className="text-xs text-white/35">
                      No skills installed yet. Use the Install Skill tab to download one.
                    </p>
                  )}
                  {skills.map((skill) => {
                    const draft = drafts[skill.skillName] ?? { autoUse: skill.autoUse, whenToUse: skill.whenToUse };
                    const dirty = draft.autoUse !== skill.autoUse || draft.whenToUse !== skill.whenToUse;
                    return (
                      <div
                        key={skill.skillName}
                        data-testid={"skill-row-" + skill.skillName}
                        className="px-3 py-3 rounded-xl bg-white/[0.03] border border-white/[0.07] space-y-2"
                      >
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium text-white/85 font-mono">/{skill.skillName}</span>
                          <SkillBadge skill={skill} />
                          {skill.sourceRepo && (
                            <span className="text-[10px] text-white/30 truncate">{skill.sourceRepo}</span>
                          )}
                          <button
                            onClick={() => handleDelete(skill.skillName)}
                            disabled={busy}
                            aria-label={"Delete " + skill.skillName}
                            className="ml-auto p-1.5 rounded-lg text-white/30 hover:text-red-400 hover:bg-red-500/[0.08] transition-colors"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        {skill.description && (
                          <p className="text-[11px] text-white/40 leading-relaxed line-clamp-2">{skill.description}</p>
                        )}
                        {skill.blockedReason && (
                          <p className="text-[11px] text-red-400/80">{skill.blockedReason} — this skill needs an external image/video generation service.</p>
                        )}
                        <label className={cn(
                          "flex items-center gap-2 text-xs cursor-pointer select-none",
                          skill.blockedReason ? "text-white/25" : "text-white/60",
                        )}>
                          <input
                            type="checkbox"
                            checked={draft.autoUse}
                            disabled={!!skill.blockedReason}
                            data-testid={"autouse-toggle-" + skill.skillName}
                            onChange={(e) => setDrafts((prev) => ({
                              ...prev,
                              [skill.skillName]: { ...draft, autoUse: e.target.checked },
                            }))}
                            className="accent-indigo-500"
                          />
                          Auto-use (scenario-based lazy loading)
                        </label>
                        <textarea
                          value={draft.whenToUse}
                          rows={2}
                          disabled={!!skill.blockedReason}
                          data-testid={"whentouse-" + skill.skillName}
                          placeholder="whenToUse — describe when this skill should fire automatically"
                          onChange={(e) => setDrafts((prev) => ({
                            ...prev,
                            [skill.skillName]: { ...draft, whenToUse: e.target.value },
                          }))}
                          className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-2.5 py-2
                            text-xs text-white placeholder-white/25 outline-none resize-none
                            focus:border-white/25 transition-colors disabled:opacity-40"
                        />
                        <button
                          onClick={() => handleSave(skill.skillName)}
                          disabled={!dirty || busy}
                          data-testid={"save-" + skill.skillName}
                          className={cn(
                            "px-3 py-1.5 text-[11px] font-medium rounded-lg transition-all",
                            dirty && !busy
                              ? "bg-white text-black hover:bg-white/90 active:scale-[0.96]"
                              : "bg-white/[0.06] text-white/25 cursor-not-allowed",
                          )}
                        >
                          Save scenario
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="px-4 py-2.5 border-t border-white/[0.06] text-[10px] text-white/25">
              Skills stay invisible (0 tokens) until you type /name or a scenario matches.
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function SkillBadge({ skill }: { skill: SkillRecord }) {
  if (skill.blockedReason) {
    return (
      <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full
        bg-red-500/[0.1] text-red-400/90 border border-red-500/20">
        <ShieldAlert className="w-2.5 h-2.5" /> Blocked
      </span>
    );
  }
  if (skill.autoUse && skill.enabled) {
    return (
      <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full
        bg-amber-500/[0.1] text-amber-400/90 border border-amber-500/20">
        <Zap className="w-2.5 h-2.5" /> Auto-Scenario
      </span>
    );
  }
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-white/[0.06] text-white/45 border border-white/[0.08]">
      Manual (/{skill.skillName})
    </span>
  );
}
