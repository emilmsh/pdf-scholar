# Model update protocol

The AI feature is the one part of the app whose external surface moves on its
own: providers launch, rename and retire models, and change what request
parameters those models accept. The model menu is **curated-only** (Emil,
2026-08-12): a model is offered because someone verified it against our
request parameters, never because the provider happens to list it — offering
fewer models that work beats offering everything. That puts the whole
freshness burden on the curated lists, which is why the scheduled review at
the bottom of this document exists. This document is the checklist for
refreshing the curated data quickly.

## What the runtime already handles (and what it cannot)

| Layer | What it does | What it does NOT cover |
|---|---|---|
| Live catalog (`src/shared/ai-model-catalog.ts`) | Fetches `GET /v1/models` from Anthropic (with capability data), OpenAI (ids only) and each keyed hosted service (ids, plus name + `context_length` where the listing carries them) — cached 24 h in `pdfx-state.json` / `chrome.storage.local`. For curated providers it ONLY flags retirements (⚠ on curated ids the provider no longer lists) and enriches context/vision; it never adds menu entries. For OpenRouter and the compat provider (custom/local endpoints, 5 min TTL when local, keyed to base URL, Ollama-enriched) the live list IS the menu — the endpoint decides. | Getting a NEW model in front of users — that is a curated-list edit, nothing happens on its own anymore; labels/hints; OpenAI capabilities; Azure (manual by design); pricing. |
| Capability-driven request shaping (`anthropicTraits` in `src/shared/ai-chat.ts`) | Uses the fetched capability tree to decide thinking/effort parameters, so a fetched model never depends on the name regexes. | First run/offline (regex fallback applies); behaviors the capability tree does not expose (always-on thinking, off-semantics) — those stay family knowledge in code. |
| Degrade-on-400 retry (`ai-chat.ts`, all three providers) | A request rejected over a parameter we added (thinking, effort, reasoning, web-search variant, fallbacks) is retried once without it. | It degrades silently: users lose thinking tuning / modern search on that model until the code catches up. A safety net, not a solution. |

So: **updating the curated data is now the only way users get new models.**
The runtime layers keep existing selections working while the checklist below
waits for a calm moment — but a launched model (gpt-5.7, say) reaches nobody
until the curated list is edited. That urgency is what the scheduled review
carries.

## When to run this

- The scheduled review (bottom of this document) runs it on a timer — that is
  the primary trigger.
- A provider ships or retires models (news, or a user asks about a model that
  is not in the menu).
- `npm run check:models` flags drift (run it whenever you are doing a release
  pass anyway — it is cheap).
- A chat suddenly answers "without thinking tuning" or search stops using the
  modern tool → the degrade net is firing; find out why.

## Step 1 — run the report

```bash
npm run check:models
```

With `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` set in the environment it diffs the
curated lists and defaults against the live provider lists and prints each
Anthropic model's capability summary (adaptive/budget thinking, effort levels).
Without keys it still runs the static consistency checks. It is a report, not a
gate — every `!` line maps to a row in the table below.

The static half includes a **context-window cross-check**: the Kontekst column
in `docs/agent-notes/modeller-api.md` against `MODEL_CONTEXT_TOKENS` in
`ai-models.ts`. That column is the contract, and it holds the **input**
capacity — not a total that includes the output ceiling. A code value *over*
the documented window is the dangerous direction (the document is attached
whole and the provider rejects it mid-question); a value materially *under* it
silently excerpts documents that would have fit. Both are flagged, because the
second one hid for months: the Anthropic models were documented at 1M and
floored at 200K in code.

## Step 2 — update what the report points at

| Finding | File to touch | What to do |
|---|---|---|
| New model at provider | `src/renderer/src/components/ai-models.ts` (`MODELS`) | Verify it against our parameters FIRST (provider docs at minimum — reasoning/effort semantics, context window; a real question when a key is at hand), then add id + `label`/`short`/`hint`, keep capability order (heaviest first). The menu shows nothing until this edit lands — curated-only is the point, an unverified model in the menu is the bug this policy removed. Also add the model's context window to `MODEL_CONTEXT_TOKENS` in the same file (verified number or leave it to the provider floor, which only ever errs toward excerpting early). Keep the lists SHORT: current generation only — when the new model replaces an old one, remove the old one in the same edit. |
| Curated model retired | same | Remove the entry (users who still have it selected see the ⚠ marker and a tooltip, and the stored selection stays pickable). |
| Default model retired/wrong | `src/shared/defaults.ts` (`DEFAULT_AI_MODELS`) | **Product decision — Emil decides which model is the default.** Never change silently. |
| Capability summary contradicts the heuristics | `src/shared/ai-chat.ts` (`anthropicTraits` fallback, `anthropicWebSearchTool` regex, OpenAI `/gpt-5|o[0-9]/` reasoning gate) | Update the regex fallbacks so first-run/offline behavior matches the API's answer. |
| New model family with new parameter semantics | `src/shared/ai-chat.ts` + `docs/agent-notes/modeller-api.md` | Verify against provider docs, encode the rules, note them (with date) in modeller-api.md. |
| OpenAI filter hides/shows the wrong ids | `src/shared/ai-model-catalog.ts` (`isOpenAiChatModel`) **and** `scripts/check-models.mjs` (same filter — keep in sync) | Adjust both copies. |
| Azure api-version too old for current models | `src/shared/defaults.ts` (`DEFAULT_AZURE_API_VERSION`) | Bump the default; users can also override per-account in settings without an app update. |
| New hint category needed | `src/renderer/src/i18n.ts` (`ai.modelHint*`, nb + en) | Add both languages. |

## Step 3 — verify

1. `npm run typecheck`
2. `npm run test:ai-chat` — the mocked conformance suite catches request-shaping
   regressions (thinking/effort params, quote contract, tool variants) without
   spending a token; update its expectations alongside any rule you changed.
3. One real question per provider you touched (desktop or extension — same
   shared core), with thinking on and off, and one with web search, watching
   for the degrade net in devtools (a retried 400 means a heuristic is still
   wrong).
4. If the **default** model changed: the assistant screenshots replay recorded
   answers (`docs/ai-fixtures/`) — consider `npm run shoot -- --with-ai
   --record` so the recorded answer matches what the shipped default would say,
   then ask Emil which frames to ship (never commit screenshots yourself).

## The scheduled review (agent)

A scheduled Claude agent runs this protocol **weekly** so a provider launch
(gpt-5.7, a new Grok, a Gemini bump) reaches the curated lists within days,
not whenever someone happens to look.

It lives in `.github/workflows/model-review.yml` — GitHub Actions, Mondays at
09:00 Oslo time, `workflow_dispatch` for a manual run. Deliberately CI and not
a laptop-side job: a freshness review that depends on someone's machine being
awake is not a review. It authenticates with the `CLAUDE_CODE_OAUTH_TOKEN`
repo secret (Emil's Claude subscription — no metered API billing; regenerate
with `claude setup-token`, tracked in MAINTENANCE.md row 6) and runs with NO
provider keys, so `check:models` contributes its static half only.

The agent's run:

1. **Check the sources.** For each curated provider, compare the curated list
   in `ai-models.ts` against the provider's public model documentation:
   - Anthropic: https://docs.anthropic.com/en/docs/about-claude/models
   - OpenAI: https://platform.openai.com/docs/models
   - Gemini: https://ai.google.dev/gemini-api/docs/models (ids) and /pricing
   - xAI: https://docs.x.ai/developers/models
   - Mistral: https://docs.mistral.ai/getting-started/models
   - Groq: https://console.groq.com/docs/models (production tier only) and
     /docs/deprecations
   Also run `npm run check:models` — keyless it validates the static
   consistency; with provider keys in the environment it diffs the live lists
   too.
2. **No drift → stop.** Leave a short note (issue comment or run log), touch
   nothing.
3. **Drift → follow step 2 of this document** and open a **pull request**
   (never push to master): curated-list edits, context floors, heuristic
   updates, and the modeller-api.md notes with the date and source for every
   claim. New models enter ONLY with their parameter behavior verified against
   provider docs — when the docs do not answer (does it take reasoning_effort?
   which context?), add the model without the unverified affordance and list
   the open question in modeller-api.md rather than guessing. Run
   `npm run typecheck` and `npm run test:ai-chat` before opening the PR.
4. **Never touch** `DEFAULT_AI_MODELS`, thinking defaults, or reasoning-effort
   defaults — flag them in the PR text when a default looks stale and let Emil
   decide (standing rule).
5. **Verification Emil owns:** a real question per touched provider with his
   own keys (MAINTENANCE.md row 2) — the PR should say which providers need
   that pass.

The monthly maintenance issue (docs/MAINTENANCE.md row 1) double-checks that
this schedule is alive and does the keyed live checks the agent may lack.

## Related notes

- `docs/agent-notes/modeller-api.md` — the hand-verified API behavior notes
  (thinking rules, prices, context sizes) that the heuristics encode.
- Standing rule: default model / reasoning-effort / thinking defaults are
  product decisions, not maintenance — ask before changing them.
