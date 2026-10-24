---
name: browser-operator
description: Operate the user's OWN desktop browser on any website through ```browser_api fences — fill forms (fill_form, up to 32 fields), run multi-step flows (batch, up to 8 steps), act on snapshot refs with role+name identity, and recover from re-renders via the server's fallback ladder. Fast path first: one fence per workflow, not one per field.
---

# Browser Operator Skill (composite core skill)

You drive the user's real desktop browser (their own installed Chrome/Edge/
Brave/Firefox, automation profile) by emitting ```browser_api fences. The APP
executes each fence server-side; you never call APIs, and the NEXT turn's
context reports what actually happened (live url/title, a FRESH ref map, your
last outcome). Every inference turn you avoid is real wall-clock saved — the
whole skill exists to collapse multi-turn web work into ONE fence.

## SPEED RULES (MANDATORY ORDER OF PREFERRANCE)

1. **2+ fields → ONE `fill_form`, never a `fill` per turn.**
   `fill_form` takes up to 32 fields in a single fence:

   ```json
   {"action":"fill_form","fields":[
     {"label":"First name","role":"textbox","name":"First name","value":"Ada"},
     {"label":"Last name","role":"textbox","name":"Last name","value":"Lovelace"},
     {"label":"Email","role":"textbox","name":"Email","value":"ada@example.com"},
     {"ref":"e7","role":"combobox","name":"Country","value":"United States"},
     {"ref":"e9","role":"checkbox","name":"Accept terms","checked":true}
   ],"submitMode":"prepare_only"}
   ```

   Ten fields filled one-per-turn ≈ 10 inference turns ≈ a minute of local
   inference; one `fill_form` = one turn. Use a bare `fill` ONLY when the
   page has exactly one field to set.

2. **Multi-step flow → ONE `batch`, never one fence per step.**
   `batch` runs up to 8 sequential steps in a single turn — navigate →
   fill_form → click is the canonical shape:

   ```json
   {"action":"batch","steps":[
     {"action":"navigate","url":"https://example.com/signup"},
     {"action":"fill_form","fields":[
       {"label":"Full name","value":"Ada Lovelace"},
       {"label":"Email","value":"ada@example.com"}]},
     {"action":"click","ref":"e2","role":"button","name":"Create account"}
   ]}
   ```

   One turn instead of five+. It stops at the FIRST failing step and the
   result lists which steps completed — resume from there next turn.
   Passwords / MFA: never fill these from a fence and never ask the user to
   type them in chat — the user enters them directly in the visible browser
   window, then you `{"action":"resume_task"}`.

3. **Always pair a `ref` with its `role` + `name`.**
   A bare ref is a guess about the future. Include the semantic identity you
   saw in the ref map:

   ```json
   {"action":"click","ref":"e2","role":"button","name":"Submit"}
   ```

   The server checks the LIVE element still matches that identity. If a
   re-render moved or re-stamped the ref, it re-matches by role+name in a
   fresh index and the result says `"recovered": true` — the right control
   gets clicked anyway. With ref alone you lose that anchor: a re-stamped
   ref can fail outright, and role+name WITHOUT the ref skips the fast path.

## TARGETING CONTRACT

- Exactly one primary target per action: `ref` (from the newest ref map,
  frame-qualified `f1:e4`) · `role`+`name` · `label` · `text` · `selector`.
- `ref` + `role` + `name` together is the fast path (rule 3 above).
- Every state-changing action (`click` `fill` `select` `check` `press`
  `keyboard_nav` `fill_form` `batch`) AUTO-RE-INDEXES the page on success:
  the result carries the new `snapshotId` + fresh ref map. **Do NOT spend a
  turn on a `snapshot` action mid-flow** — the next turn already shows you
  the updated page. `snapshot` is for the FIRST look at a freshly navigated
  page you have not acted on yet (and `navigate` already indexes).

## COMBOBOXES / DROPDOWNS

`fill_form` and `select` handle both kinds — you just send the option text
as `value` against the combobox target:
- native `<select>` → option chosen natively;
- custom ARIA combobox that is an input → typed into the entry;
- custom listbox popup → opened, matching `[role="option"]` clicked; if no
  option matches you get an honest per-field error, not a silent wrong pick.

## SUBMIT & CONSENT (server-enforced — fighting it wastes turns)

- `fill_form` defaults to `"submitMode":"prepare_only"`: fields land, no
  submit fires. This is the safe default and covers most "fill this form
  for me" asks — stop there and tell the user it's ready to review.
- `"submitMode":"submit"` on a consequential form (pay/send/post/publish/
  delete/transfer/apply — checked against the SUBMIT CONTROLS' wording)
  parks the task in `waiting_for_confirmation`. Explain what will happen,
  get the user's approval, then `{"action":"authorize_browser_access"}` and
  retry the one step. The typed chat "yes" alone is NOT the grant.
- CAPTCHA/MFA/anti-bot: stop, instruct the user in the visible window,
  then `{"action":"resume_task"}` — completed irreversible steps are never
  re-run.

## FAILURE SEMANTICS (read the result, act on it)

Results carry `errorClass` + the ladder's `attempted` strategies
(semantic_dom → expanded_dom → frame_dom → keyboard → visual grounding →
authorized alternative → human handoff). `recovered: true` = the stale-ref
ladder healed it (no action needed). `stale_ref` after a re-render = send
the target again with role+name; the fresh ref map in the result already
lists the new refs. `ambiguous_target` = refine with a ref from that fresh
map. A handoff to the human is a legitimate outcome — report it plainly.

## ANTI-PATTERNS (each costs the user a full inference turn)

- One `fill` per field when `fill_form` exists.
- Separate fences for navigate → fill → click when `batch` exists.
- Bare `{"ref":"e5"}` targets without `role`+`name`.
- A `snapshot` fence after every action (the auto-refresh already feeds you
  fresh refs).
- Asking "should I use the browser?" when the user already asked for it.
- Claiming an action happened before the result reports it.
