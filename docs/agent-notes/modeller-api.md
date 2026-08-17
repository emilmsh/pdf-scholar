# API-katalog (agentverifisert juli 2026, sist oppdatert 2026-08-17) — grunnlag for modell/tenkeinnsats-implementasjon

> Vedlikehold: kjør `npm run check:models` og følg `docs/MODEL-UPDATE.md` når
> katalogen skal fornyes. Appen henter nå modell-lister og kapabiliteter live
> fra leverandørene (src/shared/ai-model-catalog.ts) og degraderer pent på
> parameter-400 — dette dokumentet er notatene bak regex-fallbackene i
> src/shared/ai-chat.ts, ikke lenger eneste kilde.

## Anthropic

Kilde: https://platform.claude.com/docs/en/docs/about-claude/models (docs.anthropic.com
redirigerer dit nå), sjekket 2026-08-13. **Claude Opus 4.8 er forbigått av Claude
Opus 5** — Opus 4.8 (og Opus 4.7/4.6, Sonnet 4.6/4.5, Opus 4.5) ligger nå under
«Legacy models» på siden, fortsatt tilgjengelig men ikke lenger flaggskip-tieret.
Kuratert liste byttet `claude-opus-4-8` → `claude-opus-5` denne runden (samme
pris, samme tenke-egenskaper — regex-fallbacken i `anthropicTraits` skiller
ikke på Opus-generasjon, så ingen kodeendring der).

| Modell | ID | Kontekst | Pris inn/ut per MTok |
|---|---|---|---|
| Claude Fable 5 | `claude-fable-5` | 1M | $10/$50 |
| Claude Opus 5 | `claude-opus-5` | 1M | $5/$25 |
| Claude Sonnet 5 | `claude-sonnet-5` | 1M | $3/$15 |
| Claude Haiku 4.5 | `claude-haiku-4-5-20251001` (alias `claude-haiku-4-5`) | 200K | $1/$5 |

Kontekstvinduet på 1M for Fable 5/Opus 5/Sonnet 5 sto allerede i tabellen over,
men `MODEL_CONTEXT_TOKENS` i `ai-models.ts` hadde 200_000 (provider-gulvet) for
alle fire — ute av synk med denne siden helt til denne runden. Rettet til 1M
for de tre 1M-modellene (Haiku 4.5 er fortsatt 200K, det er dens faktiske vindu).

Ukentlig review 2026-08-17 (samme kilde): ingen endring i den kuraterte listen.
Sett, men IKKE lagt til: **Claude Mythos 5** (`claude-mythos-5`) lanserte samme
dag som Fable 5, men er invitasjons-only innenfor Project Glasswing (defensive
cybersecurity, kontakt Anthropic/AWS/GCP-team for tilgang) — ingen selvbetjent
API-nøkkel gir tilgang, så den kan ikke verifiseres eller brukes av våre
brukere. Utenfor kuratert-kun-regelen inntil den blir allment tilgjengelig.

Thinking-regler:
- `budget_tokens` gir **400** på Fable/Opus 5/Sonnet 5. Bruk `thinking: {type:"adaptive"}` + `output_config: {effort: "low|medium|high|xhigh|max"}`.
- Fable 5: thinking alltid på (disabled/budget → 400); `temperature` → 400; krever `client.beta.messages.stream` med `betas: ['server-side-fallback-2026-07-01']`, `fallbacks: 'default'` (Anthropic velger fallback per avslagskategori — ingen pinnet modell-id å vedlikeholde; den eldre array-formen bruker `-2026-06-01`-headeren); sjekk `stop_reason === 'refusal'` før content leses.
- Sonnet 5: thinking er PÅ som default når feltet utelates — «Av» krever `{type:"disabled"}`.
- Opus 5 (og 4.8): utelatt felt = av.
- Haiku 4.5: `effort` feiler; thinking via `budget_tokens` (min 1024) eller utelat.
- `effort` i `output_config`, GA. Hev `max_tokens` til 8–16K når thinking er på (dagens 4096 er for lite).
- Nytt 2026-08-13: på Opus 5 og Sonnet 5 defaulter `effort` til `"high"` på Claude API/Claude Code når feltet utelates (Opus 4.8 defaulter til `high` på ALLE surfaces, inkl. claude.ai). Vi setter alltid `effort` explisitt fra tenkeinnsats-valget, så dette endrer ikke request-shapingen — bare verdt å vite hvis en fremtidig degrade-net-treff ser rar ut.
- Å endre `thinking`-feltet invaliderer messages-cachen (dokumentblokken) → lås tenkeinnsats per samtale.
- Citations upåvirket av thinking.

## OpenAI gpt-5.6 (lansert 9.7.2026)

Kontekst-kolonnen er kontrakten mot `MODEL_CONTEXT_TOKENS` (`npm run
check:models` sammenligner dem): den oppgir **input**-kapasiteten, ikke en
total som inkluderer output. Verifisert mot developers.openai.com/api/docs/models
13.8.2026 — 1,05M er totalen, og med 128K output blir input ~922K. Notatene
oppgav tidligere 1.05M i denne kolonnen, altså totalen, som er feil kontrakt.

**272K-pristerskelen er bekreftet reell** (åpent spørsmål fra 13.8.2026, lukket
17.8.2026): developers.openai.com/api/docs/models/gpt-5.6-terra sier ordrett
«Prompts with >272K input tokens are priced at 2x input and 1.5x output for
the full request» — HELE forespørselen repris, ikke bare overskytende tokens
(Sol $5/$30 → $10/$45, Terra $2/$12 → $4/$18, Luna $0.20/$1.20 → $0.40/$1.80
over terskelen). Dette er en PRISendring, ikke en kapasitetsendring — modellen
tar fortsatt 922K input, terskelen endrer bare hva det koster. Ingen
kodeendring i `MODEL_CONTEXT_TOKENS` (som styrer når et dokument MÅ kuttes til
utdrag for å unngå en hard feil, ikke kostnad). Om appen bør kutte til utdrag
tidligere enn 922K av kostnadshensyn — altså senke gulvet av rene
sparegrunner, ikke korrekthet — er en produktbeslutning (brukerens egen nøkkel
betaler); flagget til Emil i PR-en, ikke gjort her.

| Modell | ID | Kontekst (input) | Pris inn/ut | Cached inn |
|---|---|---|---|---|
| Sol (flaggskip) | `gpt-5.6-sol` | 922K (1,05M totalt inkl. 128K output) | $5/$30 | $0.50 |
| Terra (anbefalt) | `gpt-5.6-terra` | 922K (som Sol) | $2/$12 (ned fra $2.50/$15 i juli) | $0.25 |
| Luna (rask) | `gpt-5.6-luna` | 922K (som Sol) | $0.20/$1.20 (ned fra $1/$6 i juli) | $0.10 — SVAK på long-context (41 %), unngå som dokument-default |

- `reasoning_effort: none|low|medium|high|xhigh|max` (default medium) — gyldig toppnivåfelt på `/v1/chat/completions`, dagens SSE-kode fungerer uendret.
- Azure: dagens `api-version=2024-12-01-preview` er for gammel for 5.6 — oppgrader ved behov.

## Hostede kompat-tjenester (agentverifisert 12.8.2026, oppdatert 17.8.2026 mot leverandørdocs)

Kuratert i `ai-models.ts` etter kuratert-kun-regelen (færre modeller som
beviselig virker > alle modeller). Kilder: ai.google.dev/gemini-api/docs
(models + pricing) og ai.google.dev/gemini-api/docs/openai (reasoning-mapping),
docs.x.ai/developers/grok-4-6 og docs.x.ai/developers/model-capabilities/text/reasoning,
docs.mistral.ai/getting-started/models og docs.mistral.ai/models/model-cards/*,
console.groq.com/docs/models, /docs/reasoning og /docs/deprecations.

| Leverandør | Kuratert id | Kontekst | Notat |
|---|---|---|---|
| Gemini | `gemini-3.1-pro-preview` | 1M | Flaggskip (Preview — id-en KAN rotere ved GA, sjekk ved neste review; fortsatt Preview 17.8.2026, «Gemini 3.5 Pro»-lansering fortsatt forsinket ifølge presseomtale 13.8.2026) |
| Gemini | `gemini-3.7-flash` | 1M (1 048 576 dokumentert, gulvet på 1_000_000 som ellers i katalogen) | **Byttet inn 17.8.2026, erstatter `gemini-3.6-flash`** — lansert 13.8.2026, tre uker etter 3.6 Flash (blog.google/.../introducing-gemini-3-7-flash, ai.google.dev/gemini-api/docs/models/gemini-3.7-flash). Modellkortet bekrefter input tekst/bilde/video/lyd/PDF, output kun tekst — kuratert-regel #2 innfridd. Intropris $0.75/$3.75 per MTok inn/ut ut 2026, stiger til $1.50/$7.50 fra 1.1.2027 (ai.google.dev/gemini-api/docs/pricing) |
| Gemini | `gemini-3.5-flash-lite` | ukjent → gulv | GA, billigst ($0.30/$2.50) |
| xAI | `grok-4.6` | 500K | **Nytt 13.8.2026** — landet, forbigår grok-4.5 som flaggskip; `reasoning_effort` low/medium/high (default)/xhigh DOKUMENTERT → med i OPENAI_REASONING_RE |
| xAI | `grok-4.3` | 1M | Standard-tier ($1.25/$2.50); effort-støtte UVERIFISERT → utenfor regexen (fortsatt uverifisert 17.8.2026, docs.x.ai/developers/models nevner ikke reasoning for 4.3) |
| Mistral | `mistral-medium-3-5-26-04` | 256K (verifisert 13.8.2026, model-card) | Frontier (Medium > Large i dagens lineup!) |
| Mistral | `mistral-large-3-25-12` | 256K (verifisert 13.8.2026, model-card) | Open-weight arbeidshest ($0.50/$1.50) |
| Mistral | `mistral-small-4-0-26-03` | 256K (verifisert 13.8.2026, model-card) | Rask/billig |
| Groq | `openai/gpt-oss-120b` | 131K | Production-tier; Llama-parene deprecated (deprecations-siden ga en litt annen dato enn notert her: 16.8.2026 vs. tidligere notert 17.6.2026 — begge Llama-idene er uansett utenfor vår kuraterte liste, så ingen kodeendring uansett hvilken dato er riktig). `reasoning_effort` low/medium/high **bekreftet 17.8.2026** (console.groq.com/docs/reasoning: «only supported by GPT-OSS 20B and GPT-OSS 120B») → lagt til i OPENAI_REASONING_RE; «none»/av UVERIFISERT (samme gap som grok-4.5/4.6s av-verdi), degrade-on-400-nettet dekker feilgjetningen |
| Groq | `openai/gpt-oss-20b` | 131K | Production-tier, rask — samme reasoning_effort-bekreftelse som 120b |

Grok 4.5 (`grok-4.5`) er ikke lenger i den kuraterte listen, men står fortsatt
i `MODEL_CONTEXT_TOKENS` og `OPENAI_REASONING_RE` (ai-provider-profile.ts) slik
at brukere som allerede har den valgt ikke mister kontekstestimat eller
tenkeinnsats-styring. Det samme gjelder nå `gemini-3.6-flash` i
`MODEL_CONTEXT_TOKENS` etter byttet til 3.7 Flash over.

Åpne spørsmål til neste review (svar med kilde + dato når de lukkes):
- ~~Finnes det et prishopp over 272K input-tokens hos OpenAI?~~ **Lukket
  17.8.2026** — bekreftet førstepartskilde, se § OpenAI gpt-5.6 over. Det er
  en PRIS-terskel, ikke en kapasitetsterskel, så `MODEL_CONTEXT_TOKENS` er
  uendret; om appen bør kutte til utdrag tidligere enn 922K av rene
  kostnadshensyn er en produktbeslutning, ikke en korrekthetsrettelse — flagg
  til Emil, gjør det ikke selv.
- Gemini: ai.google.dev/gemini-api/docs/openai har en reasoning_effort→
  thinking_level/-budget-tabell (sjekket 13.8.2026, gjensjekket 17.8.2026 —
  samme fire rader), men radene heter «Gemini 3.1 Pro / 3.1 Flash-Lite / 3
  Flash / 2.5» — ikke våre eksakte kuraterte id-er (`gemini-3.5-flash-lite`
  matcher ingen rad, og med byttet til `gemini-3.7-flash` denne runden matcher
  INGEN av de tre kuraterte id-ene en rad eksakt lenger; `gemini-3.1-pro-preview`
  er trolig samme familie som «3.1 Pro», men tabellen har INGEN `none`-rad, og
  modellkort-siden for 3.7 Flash sier ingenting om reasoning_effort i det hele
  tatt). Fortsatt IKKE lagt til regexen — for tynn/foreldet dekning til å
  stole på for hele effort-spekteret vi trenger, og «Av» ville vært et gjett
  uansett id.
- ~~Groq: nevner reasoning_effort for gpt-oss-120b/20b i det hele tatt?~~
  **Delvis lukket 17.8.2026** — console.groq.com/docs/reasoning bekrefter
  low/medium/high for begge (se tabellen over); lagt til OPENAI_REASONING_RE.
  Fortsatt åpent: ingen kilde nevner en «none»/av-verdi for gpt-oss — sendes
  likevel (samme mønster som grok-4.5/4.6), degrade-on-400-nettet dekker en
  feilgjetning der.
- Mistral: ingen `-latest`-alias funnet for medium-3-5/large-3/small-4 på
  docs.mistral.ai (sjekket 13.8.2026, gjensjekket 17.8.2026 — uendret).
  Kontekstvinduene er nå verifisert (se tabellen), så denne delen av
  spørsmålet er lukket; alias-delen forblir åpen i den forstand at et
  fremtidig alias ikke er utelukket, bare ikke observert.

## Anbefalt mapping «Tenkeinnsats» (Av/Lav/Middels/Høy)

| Valg | Opus 5 / Sonnet 5 | Fable 5 | Haiku 4.5 | OpenAI |
|---|---|---|---|---|
| Av | Opus: utelat; Sonnet 5: `{type:"disabled"}` | umulig (grå ut → Lav) | utelat | `none` |
| Lav/Middels/Høy | `adaptive` + effort low/medium/high | effort low/medium/high | ikke støttet (utelat) | low/medium/high |

Defaults: anthropic `claude-sonnet-5` + Middels; openai `gpt-5.6-terra` + medium.
Heuristikk: effort kun når id ikke matcher `haiku` (fallback i `anthropicTraits`
skiller ikke videre på Opus/Sonnet/Fable-generasjon — «alwaysThinks» slår bare
inn for `fable|mythos`); Haiku alltid uten thinking.
