# Monthly staleness audit

Most of the app is inert: pdf.js is pinned, the engine is settled, nothing
rots. But a slice of it points at the outside world — AI providers, store
APIs, tokens, dependency advisories — and that slice goes stale on other
people's schedules, not ours. This is the once-a-month pass over exactly that
slice. A workflow (`.github/workflows/maintenance-reminder.yml`) opens an
issue on the 15th linking here; the full-release reminder (1st of the month)
covers the outbound store channels and is deliberately separate.

Everything here is a *check* first — most months most rows are "still fine,
close the issue". Budget ~20 minutes.

## The checklist

| # | What goes stale | Check | Act on findings |
|---|---|---|---|
| 1 | **AI model catalogue + request rules** (providers launch/retire models, change accepted params). The menu is curated-only, so a stale list means users LACK models — a weekly scheduled agent runs the protocol and PRs drift (see MODEL-UPDATE.md § scheduled review); this monthly row verifies that schedule is alive and adds what the agent cannot | `npm run check:models` with `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` (and any of `GEMINI_API_KEY`/`XAI_API_KEY`/`MISTRAL_API_KEY`/`GROQ_API_KEY`) in env; check that the weekly review has run and its PRs got handled | [docs/MODEL-UPDATE.md](MODEL-UPDATE.md) maps every finding to a file. After any rule change: `npm run test:ai-chat` |
| 1b | **What the OpenRouter menu actually offers.** Its list is the live one minus the selection rule (MODEL-UPDATE.md § Curation rules), so drift here is silent in a way a curated list is not: the report says the fields are intact and the menu still fills with the wrong models. Open it once and look | Open the model menu with the OpenRouter key set — are the entries current chat models, ~7 per vendor, nothing that answers in pictures or audio? `npm run check:models` flags a field rename; the eye is for everything else | Tighten the rule in `curateRemoteModels` (`src/shared/ai-model-catalog.ts`) and extend `npm run test:model-curation` with the case you found |
| 2 | **Degrade-net firings** (a heuristic quietly wrong: answers lose thinking tuning / modern search) | One real question per provider you hold a key for, devtools open — a retried 400 is the tell | Same protocol, step 2 table |
| 3 | **Azure api-version default** (`DEFAULT_AZURE_API_VERSION` in `src/shared/defaults.ts`) | Skim the Azure OpenAI "what's new" / API lifecycle page | Bump the default; users can override per-account meanwhile |
| 4 | **Service base URLs, local presets + spend-cap links** (`COMPAT_SERVICES` in `src/shared/ai-provider-profile.ts`; `compatPresets` — local URLs + example model-id placeholders — and `SPEND_CAP_URLS`/`SPEND_CAP_LABELS` in `src/renderer/src/components/ai-models.ts`) | Do the URLs still resolve, and do the example ids still exist? | Update the constants — no other surface mirrors them. A moved service base URL breaks every user of that provider, so this row is the audit's most load-bearing |
| 5 | **Dependency advisories** | `npm audit` (prod deps are few by design); `npm outdated` for context | Patch what's advisories-driven. Respect the deliberate pins: electron-vite 5 needs vite ≤ 7; pdf.js majors are upgraded deliberately, never casually (check `PDFJS_ASSET_DIRS` in `config/vite.pdfjs-assets.ts` when you do); Electron majors follow their security notes |
| 6 | **Tokens and API keys the automation depends on** | `TAP_GITHUB_TOKEN` (Homebrew tap auto-bump — a dead token fails the next release's bump step, check expiry in GitHub settings); `CLAUDE_CODE_OAUTH_TOKEN` (the weekly model review — an expired token fails `model-review.yml`, regenerate with `claude setup-token`); Edge Add-ons API key (a 401 in ext-publish means it expired, renew in Partner Center) | Renew in place; secrets live in repo settings |
| 7 | **Scheduled workflows still alive** (GitHub suspends cron after ~60 days without repo activity) | Actions tab — are the two reminder workflows and `model-review.yml` still enabled? | Re-enable from the Actions tab |
| 8 | **Shipped screenshots vs UI drift** | `npm run check:shots` | Prompt Emil to re-shoot per [docs/RELEASE.md](RELEASE.md) step 0 — never generate them |

## What does NOT belong here

- **Store submissions and listings** — that is the full-release reminder's
  checklist (1st of the month), see [docs/RELEASE.md](RELEASE.md).
- **Default model changes** — finding a retired default is checklist row 1,
  but *choosing* the replacement is a product decision: Emil decides, never
  a maintenance edit (standing rule, see MODEL-UPDATE.md).
- **Feature work discovered along the way** — file an issue, keep the pass
  short.
