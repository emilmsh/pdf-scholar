# Model update protocol

The AI feature is the one part of the app whose external surface moves on its
own: providers launch, rename and retire models, and change what request
parameters those models accept. Three runtime layers absorb most of that
without an app update, but the shipped (curated) data still goes stale and is
refreshed by hand — this document is the checklist for doing that quickly.

## What the runtime already handles (and what it cannot)

| Layer | What it does | What it does NOT cover |
|---|---|---|
| Live catalog (`src/shared/ai-model-catalog.ts`) | Fetches `GET /v1/models` from Anthropic (with capability data) and OpenAI (ids only) with the user's key, cached 24 h in `pdfx-state.json` / `chrome.storage.local`. New models appear in the model menu on their own; retired ones get a ⚠ marker. | Labels/hints stay generic (`prettyModelName`); OpenAI capabilities; Azure (manual by design); pricing. |
| Capability-driven request shaping (`anthropicTraits` in `src/shared/ai-chat.ts`) | Uses the fetched capability tree to decide thinking/effort parameters, so a fetched model never depends on the name regexes. | First run/offline (regex fallback applies); behaviors the capability tree does not expose (always-on thinking, off-semantics) — those stay family knowledge in code. |
| Degrade-on-400 retry (`ai-chat.ts`, all three providers) | A request rejected over a parameter we added (thinking, effort, reasoning, web-search variant, fallbacks) is retried once without it. | It degrades silently: users lose thinking tuning / modern search on that model until the code catches up. A safety net, not a solution. |

So: **nothing here removes the need to update the curated data — it removes the
urgency.** Users keep working while the checklist below waits for a calm moment.

## When to run this

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

## Step 2 — update what the report points at

| Finding | File to touch | What to do |
|---|---|---|
| New model at provider | `src/renderer/src/components/ai-models.ts` (`MODELS`) | Add id + `label`/`short`/`hint`, keep capability order (heaviest first). Until you do, the model already works via the live catalog with a generic label. Also add the model's context window to `MODEL_CONTEXT_TOKENS` in the same file (verify against provider docs; conservative floor, decides when huge documents switch to excerpt mode) — an unlisted model falls back to the provider floor, which only ever errs toward excerpting early. |
| Curated model retired | same | Remove the entry (users who still have it selected see the ⚠ marker and a tooltip). |
| Default model retired/wrong | `src/shared/defaults.ts` (`DEFAULT_AI_MODELS`) | **Product decision — Emil decides which model is the default.** Never change silently. |
| Capability summary contradicts the heuristics | `src/shared/ai-chat.ts` (`anthropicTraits` fallback, `anthropicWebSearchTool` regex, OpenAI `/gpt-5|o[0-9]/` reasoning gate) | Update the regex fallbacks so first-run/offline behavior matches the API's answer. |
| New model family with new parameter semantics | `src/shared/ai-chat.ts` + `docs/agent-notes/modeller-api.md` | Verify against provider docs, encode the rules, note them (with date) in modeller-api.md. |
| OpenAI filter hides/shows the wrong ids | `src/shared/ai-model-catalog.ts` (`isOpenAiChatModel`) **and** `scripts/check-models.mjs` (same filter — keep in sync) | Adjust both copies. |
| Azure api-version too old for current models | `src/shared/defaults.ts` (`DEFAULT_AZURE_API_VERSION`) | Bump the default; users can also override per-account in settings without an app update. |
| New hint category needed | `src/renderer/src/i18n.ts` (`ai.modelHint*`, nb + en) | Add both languages. |

## Step 3 — verify

1. `npm run typecheck`
2. One real question per provider you touched (desktop or extension — same
   shared core), with thinking on and off, and one with web search, watching
   for the degrade net in devtools (a retried 400 means a heuristic is still
   wrong).
3. If the **default** model changed: the assistant screenshots replay recorded
   answers (`docs/ai-fixtures/`) — consider `npm run shoot -- --with-ai
   --record` so the recorded answer matches what the shipped default would say,
   then ask Emil which frames to ship (never commit screenshots yourself).

## Related notes

- `docs/agent-notes/modeller-api.md` — the hand-verified API behavior notes
  (thinking rules, prices, context sizes) that the heuristics encode.
- Standing rule: default model / reasoning-effort / thinking defaults are
  product decisions, not maintenance — ask before changing them.
