# API-katalog (agentverifisert juli 2026) — grunnlag for modell/tenkeinnsats-implementasjon

> Vedlikehold: kjør `npm run check:models` og følg `docs/MODEL-UPDATE.md` når
> katalogen skal fornyes. Appen henter nå modell-lister og kapabiliteter live
> fra leverandørene (src/shared/ai-model-catalog.ts) og degraderer pent på
> parameter-400 — dette dokumentet er notatene bak regex-fallbackene i
> src/shared/ai-chat.ts, ikke lenger eneste kilde.

## Anthropic

| Modell | ID | Kontekst | Pris inn/ut per MTok |
|---|---|---|---|
| Claude Fable 5 | `claude-fable-5` | 1M | $10/$50 |
| Claude Opus 4.8 | `claude-opus-4-8` | 1M | $5/$25 |
| Claude Sonnet 5 | `claude-sonnet-5` | 1M | $3/$15 |
| Claude Haiku 4.5 | `claude-haiku-4-5` | 200K | $1/$5 |

Thinking-regler:
- `budget_tokens` gir **400** på Fable/Opus 4.8/Sonnet 5. Bruk `thinking: {type:"adaptive"}` + `output_config: {effort: "low|medium|high|xhigh|max"}`.
- Fable 5: thinking alltid på (disabled/budget → 400); `temperature` → 400; krever `client.beta.messages.stream` med `betas: ['server-side-fallback-2026-07-01']`, `fallbacks: 'default'` (Anthropic velger fallback per avslagskategori — ingen pinnet modell-id å vedlikeholde; den eldre array-formen bruker `-2026-06-01`-headeren); sjekk `stop_reason === 'refusal'` før content leses.
- Sonnet 5: thinking er PÅ som default når feltet utelates — «Av» krever `{type:"disabled"}`.
- Opus 4.8: utelatt felt = av.
- Haiku 4.5: `effort` feiler; thinking via `budget_tokens` (min 1024) eller utelat.
- `effort` i `output_config`, GA. Hev `max_tokens` til 8–16K når thinking er på (dagens 4096 er for lite).
- Å endre `thinking`-feltet invaliderer messages-cachen (dokumentblokken) → lås tenkeinnsats per samtale.
- Citations upåvirket av thinking.

## OpenAI gpt-5.6 (lansert 9.7.2026)

| Modell | ID | Kontekst | Pris inn/ut | Cached inn |
|---|---|---|---|---|
| Sol (flaggskip) | `gpt-5.6-sol` | 1.05M | $5/$30 | $0.50 |
| Terra (anbefalt) | `gpt-5.6-terra` | 1.05M | $2.50/$15 | $0.25 |
| Luna (rask) | `gpt-5.6-luna` | 1.05M | $1/$6 | $0.10 — SVAK på long-context (41 %), unngå som dokument-default |

- `reasoning_effort: none|low|medium|high|xhigh|max` (default medium) — gyldig toppnivåfelt på `/v1/chat/completions`, dagens SSE-kode fungerer uendret.
- Azure: dagens `api-version=2024-12-01-preview` er for gammel for 5.6 — oppgrader ved behov.

## Hostede kompat-tjenester (agentverifisert 12.8.2026, mot leverandørdocs)

Kuratert i `ai-models.ts` etter kuratert-kun-regelen (færre modeller som
beviselig virker > alle modeller). Kilder: ai.google.dev/gemini-api/docs
(models + pricing), docs.x.ai/developers (models + grok-4-5),
docs.mistral.ai/getting-started/models, console.groq.com/docs/models.

| Leverandør | Kuratert id | Kontekst | Notat |
|---|---|---|---|
| Gemini | `gemini-3.1-pro-preview` | 1M | Flaggskip (Preview — id-en KAN rotere ved GA, sjekk ved neste review) |
| Gemini | `gemini-3.6-flash` | 1M | Stabil, «most intelligent built for speed», $1.50/$7.50 |
| Gemini | `gemini-3.5-flash-lite` | ukjent → gulv | GA, billigst ($0.30/$2.50) |
| xAI | `grok-4.5` | 500K | Flaggskip; `reasoning_effort` low/medium/high DOKUMENTERT (default high) → med i OPENAI_REASONING_RE |
| xAI | `grok-4.3` | 1M | Standard-tier ($1.25/$2.50); effort-støtte UVERIFISERT → utenfor regexen |
| Mistral | `mistral-medium-3-5-26-04` | ukjent → gulv | Frontier (Medium > Large i dagens lineup!) |
| Mistral | `mistral-large-3-25-12` | ukjent → gulv | Open-weight arbeidshest ($0.50/$1.50) |
| Mistral | `mistral-small-4-0-26-03` | ukjent → gulv | Rask/billig |
| Groq | `openai/gpt-oss-120b` | 131K | Production-tier; Llama-parene deprecated 17.6.2026 |
| Groq | `openai/gpt-oss-20b` | 131K | Production-tier, rask |

Åpne spørsmål til neste review (svar med kilde + dato når de lukkes):
- Godtar Gemini-modellene `reasoning_effort` på OpenAI-kompat-endepunktet?
  (Selektoren er skjult for dem i dag — degrade-nettet eier en evt. feil.)
- Groqs gpt-oss-kort nevner reasoning — verifiser `reasoning_effort` mot
  Groq-docs før id-ene evt. tas inn i regexen.
- Mistral: finnes `-latest`-aliaser for 3.5/3/4-generasjonen, og hva er
  kontekstvinduene? (Docs-siden oppga ingen tall 12.8.2026.)
- xAI: Grok 4.6 var annonsert for uke 32–33/2026 — sjekk om den har landet og
  hva `reasoning_effort`-støtten er.

## Anbefalt mapping «Tenkeinnsats» (Av/Lav/Middels/Høy)

| Valg | Opus 4.8 / Sonnet 5 | Fable 5 | Haiku 4.5 | OpenAI |
|---|---|---|---|---|
| Av | Opus: utelat; Sonnet 5: `{type:"disabled"}` | umulig (grå ut → Lav) | utelat | `none` |
| Lav/Middels/Høy | `adaptive` + effort low/medium/high | effort low/medium/high | ikke støttet (utelat) | low/medium/high |

Defaults: anthropic `claude-sonnet-5` + Middels; openai `gpt-5.6-terra` + medium.
Heuristikk: effort kun når id matcher `fable|opus-4-[78]|sonnet-5`; Haiku alltid uten thinking.
