# API-katalog (agentverifisert juli 2026) — grunnlag for modell/tenkeinnsats-implementasjon

## Anthropic

| Modell | ID | Kontekst | Pris inn/ut per MTok |
|---|---|---|---|
| Claude Fable 5 | `claude-fable-5` | 1M | $10/$50 |
| Claude Opus 4.8 | `claude-opus-4-8` | 1M | $5/$25 |
| Claude Sonnet 5 | `claude-sonnet-5` | 1M | $3/$15 |
| Claude Haiku 4.5 | `claude-haiku-4-5` | 200K | $1/$5 |

Thinking-regler:
- `budget_tokens` gir **400** på Fable/Opus 4.8/Sonnet 5. Bruk `thinking: {type:"adaptive"}` + `output_config: {effort: "low|medium|high|xhigh|max"}`.
- Fable 5: thinking alltid på (disabled/budget → 400); `temperature` → 400; krever `client.beta.messages.stream` med `betas: ['server-side-fallback-2026-06-01']`, `fallbacks: [{model:'claude-opus-4-8'}]`; sjekk `stop_reason === 'refusal'` før content leses.
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

## Anbefalt mapping «Tenkeinnsats» (Av/Lav/Middels/Høy)

| Valg | Opus 4.8 / Sonnet 5 | Fable 5 | Haiku 4.5 | OpenAI |
|---|---|---|---|---|
| Av | Opus: utelat; Sonnet 5: `{type:"disabled"}` | umulig (grå ut → Lav) | utelat | `none` |
| Lav/Middels/Høy | `adaptive` + effort low/medium/high | effort low/medium/high | ikke støttet (utelat) | low/medium/high |

Defaults: anthropic `claude-sonnet-5` + Middels; openai `gpt-5.6-terra` + medium.
Heuristikk: effort kun når id matcher `fable|opus-4-[78]|sonnet-5`; Haiku alltid uten thinking.
