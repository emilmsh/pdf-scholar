# API-katalog (agentverifisert juli 2026, sist oppdatert 2026-09-05) — grunnlag for modell/tenkeinnsats-implementasjon

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
| Claude Fable 5.1 | `claude-fable-5-1` | 1M | $10/$50 (cache-lesing $0.25, en fjerdedel av Fable 5) |
| Claude Opus 5 | `claude-opus-5` | 1M | $5/$25 |
| Claude Sonnet 5 | `claude-sonnet-5` | 1M | $2/$10 |
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

Ukentlig review 2026-08-24 (platform.claude.com/docs/en/about-claude/pricing,
sjekket samme dag): ingen endring i den kuraterte listen eller Mythos
5-status. **Prisrettelse:** Sonnet 5 sto med $3/$15 i tabellen over — det var
den planlagte prisen etter en introduksjonsperiode. Prissiden bekrefter nå at
introduksjonsprisen $2/$10 er blitt permanent («The previously scheduled
increase to $3/$15 per million input/output tokens on September 1, 2026 will
not occur»); rettet til $2/$10 over. Ingen kodeendring — pris brukes ikke i
`ai-models.ts` for kuraterte Anthropic-modeller, kun i denne tabellen. Fable
5/Opus 5/Haiku 4.5-priser bekreftet uendret samme kilde.

Ukentlig review 2026-08-31 (platform.claude.com/docs/en/models/overview,
sjekket samme dag): ingen endring i kuratert liste, pris eller kontekstvindu
— tabellen over stemmer fortsatt ord for ord. Mythos 5 fortsatt kun via
Project Glasswing (anthropic.com/news/claude-fable-5-mythos-5), ingen
selvbetjent tilgang. **Ryddet en feilkilde:** et par tredjeparts SEO-sider
(ikke Anthropic) påsto i søk denne runden at Fable 5/Mythos 5-tilgang er
suspendert av amerikansk eksportkontroll — udokumentert og feil. Anthropics
egen kunngjøring nevner kun en midlertidig driftsstans 12.6–1.7.2026 («We are
suspending access... apologize for this disruption», gjenåpnet 1.7.2026),
ingen eksportkontroll-sammenheng. Ingen relevans for dagens status, men notert
her så en fremtidig runde ikke lar seg lure av samme søketreff.

**Review 2026-09-05 (platform.claude.com/docs/en/models/overview,
anthropic.com/claude-fable-and-mythos-5-1, sjekket samme dag): Claude Fable
5.1 (`claude-fable-5-1`) lanserte 1.9.2026 og har tatt Fable 5s plass i
tabellen over.** Fable 5 (`claude-fable-5`) ligger nå under «Legacy models»
— fortsatt tilgjengelig, så den beholdes i `MODEL_CONTEXT_TOKENS` for lagrede
valg, men er ute av den kuraterte listen (samme regel som Opus 4.8 → Opus 5).
Samme tier, samme pris per token ($10/$50), samme 1M kontekst og 128K output,
samme tokenizer; cache-lesing er satt ned til $0.25/MTok (0,025× inn-pris,
mot 0,1× på resten av lineupen). Kunnskaps-cutoff juni 2026, pensjonering
tidligst 1.9.2027. Mythos 5.1 (`claude-mythos-5-1`) er samme modell for
Project Glasswing — fortsatt ikke selvbetjent, samme status som Mythos 5.

Hva 5.1 bryter i forhold til Fable 5, og hvorfor ingen av dem treffer oss
(vurdert mot `chatAnthropic` i `src/shared/ai-chat.ts`, 2026-09-05):
- **Tvunget `tool_choice` (`any`/`tool`) gir 400.** Vi sender aldri
  `tool_choice` — eneste verktøy er den server-side web-søk-tool'en under
  `auto`. Ingen endring.
- **«Preserved thinking»: thinking-blokker er bundet til modellen som laget
  dem OG til samtaleprefikset** — å redigere en tidligere tur invaliderer
  alle senere blokker, og nye kontoer (opprettet fra 31.8.2026) får 400 på
  det uten `thinking-binding-controls-2026-08-01`-headeren. Vi replayer aldri
  thinking-blokker på tvers av forespørsler: historikken bygges av
  `req.messages` som rolle + ren tekst, så assistent-turer går tilbake som
  tekst og det finnes ingen blokk å invalidere. Innenfor ÉN forespørsel
  legges `final.content` (med thinking) til kun i pause_turn-løkken, som er
  append-only. Ingen endring, og headeren trengs ikke.
- **`thinking: {type:"disabled"}` gir 400 på alle effort-nivåer** (Opus 5
  tok det på `high` og lavere) — vi sender aldri `thinking`-feltet for
  `fable|mythos` (`alwaysThinks`). Ingen endring.
- Fallbacks (`fallbacks: 'default'` + `server-side-fallback-2026-07-01`)
  virker som på Fable 5; tillatte mål er Opus 4.8 og Opus 5. Fallback-
  modellen kan ikke lese 5.1s thinking-blokker, API-et dropper dem selv.
  Refusal-kategoriene er bredere enn Opus 5s (`bio`, `reasoning_extraction`
  i tillegg til `cyber`) — vi leser bare `stop_reason === 'refusal'`, så det
  spiller ingen rolle.
- Ikke støttet på Priority Tier; krever 30 dagers dataoppbevaring (ZDR-org
  får 400 — det gjaldt Fable 5 også).
- Regex-fallbackene (`/fable|mythos/` i `anthropicTraits`,
  `anthropicWebSearchTool`, beta-klienten) matcher `claude-fable-5-1` uten
  endring; verifisert i `npm run test:ai-chat` («fable 5.1»-assertions).
  **Live spørsmål med ekte nøkkel gjenstår (Emil, MAINTENANCE.md rad 2).**

Thinking-regler:
- `budget_tokens` gir **400** på Fable/Opus 5/Sonnet 5. Bruk `thinking: {type:"adaptive"}` + `output_config: {effort: "low|medium|high|xhigh|max"}`.
- Fable 5 og 5.1: thinking alltid på (disabled/budget → 400); `temperature` → 400; krever `client.beta.messages.stream` med `betas: ['server-side-fallback-2026-07-01']`, `fallbacks: 'default'` (Anthropic velger fallback per avslagskategori — ingen pinnet modell-id å vedlikeholde; den eldre array-formen bruker `-2026-06-01`-headeren); sjekk `stop_reason === 'refusal'` før content leses.
- Sonnet 5: thinking er PÅ som default når feltet utelates — «Av» krever `{type:"disabled"}`.
- Opus 5 (og 4.8): utelatt felt = av.
- Haiku 4.5: `effort` feiler; thinking via `budget_tokens` (min 1024) eller utelat.
- `effort` i `output_config`, GA. Hev `max_tokens` til 8–16K når thinking er på (dagens 4096 er for lite).
- Nytt 2026-08-13: på Opus 5 og Sonnet 5 defaulter `effort` til `"high"` på Claude API/Claude Code når feltet utelates (Opus 4.8 defaulter til `high` på ALLE surfaces, inkl. claude.ai). Vi setter alltid `effort` explisitt fra tenkeinnsats-valget, så dette endrer ikke request-shapingen — bare verdt å vite hvis en fremtidig degrade-net-treff ser rar ut.
- Å endre `thinking`-feltet invaliderer messages-cachen (dokumentblokken) → lås tenkeinnsats per samtale.
- Citations upåvirket av thinking.

## OpenAI gpt-6 Astra (lansert 3.9.2026) og gpt-5.6 (lansert 9.7.2026)

**Review 2026-09-05 (developers.openai.com/api/docs/models,
/api/docs/models/gpt-6-astra og /api/docs/guides/reasoning, sjekket samme
dag; lanseringsdato fra techcrunch.com/2026/09/03 og cnbc.com/2026/09/03):
GPT-6 Astra (`gpt-6-astra`) er lagt til øverst i den kuraterte listen.**
Det er et nytt topp-tier over 5.6-trioen, ikke en erstatning — Sol/Terra/Luna
står uendret på modellsiden, så listen har nå fire. Tekst + bilde inn, tekst
ut (kuratert-regel #2 innfridd), Chat Completions og Responses støttet,
streaming, web-søk og prompt caching støttet. Kunnskaps-cutoff 30.4.2026.
Eneste snapshot-id er `gpt-6-astra` selv.

- **`reasoning.effort` tar `low|medium|high|xhigh|max` — IKKE `none`.**
  Reasoning-guiden sier ordrett: «GPT-6 Astra does not support `none`
  reasoning effort. Setting `reasoning.effort` … to `none` returns HTTP 400.»
  Vår «Av» sendte `none` for alle OpenAI-modeller; for Astra hadde det gitt
  én 400 + degrade-retry uten reasoning per spørsmål. Kodet som
  `OPENAI_ALWAYS_REASONS_RE` (`/gpt-6/`, `ai-provider-profile.ts`): «Av» →
  `low`, samme ærlige mapping som Fable-familien på Anthropic-siden.
  gpt-5.6 beholder `none` (dokumentert der, og billigere). Default-effort
  for Astra er ikke oppgitt — vi setter alltid effort eksplisitt, så det
  spiller ingen rolle.
- **`OPENAI_REASONING_RE` utvidet fra `/gpt-5/` til `/gpt-[5-9]/`** — uten
  det hadde Astra fått ingen tenkeinnsats-styring i stillhet (ingen 400,
  bare default-effort). Dette er nøyaktig drift-typen MODEL-UPDATE.md rad
  «Capability summary contradicts the heuristics» beskriver.
- `isOpenAiChatModel` (`ai-model-catalog.ts`) og filteret i
  `check-models.mjs` matcher `gpt-6-astra` allerede (`/^(gpt-[0-9]|o[0-9])/`);
  `lineageOf` leser generasjon 6 → sorterer over 5.6 i live-lister.
- Kontekst: 1,05M totalt, **922K input**, 128K output — identisk med 5.6,
  så `MODEL_CONTEXT_TOKENS` får 900_000 som de tre andre. 272K-pristerskelen
  gjelder Astra også (samme ordlyd: >272K input → 2× inn/cache og 1,5× ut).
- Pris $10/$50 per MTok, cached inn $1, batch halv pris, «Fast mode» 2×.
- Presseomtale (TechCrunch/CNBC 3.9.2026) beskriver trinnvis utrulling
  («a limited set of organizations on day one, then … the OpenAI API and AWS
  over the coming days»); modellsiden selv nevner ingen tilgangsbegrensning.
  Om en konto ikke har fått den ennå, viser ⚠-markøren i menyen det (live
  `/v1/models`-diff), og valget står. **Live spørsmål med ekte nøkkel
  gjenstår (Emil).**

| Modell | ID | Kontekst (input) | Pris inn/ut | Cached inn |
|---|---|---|---|---|
| Astra (GPT-6, tyngst) | `gpt-6-astra` | 922K (1,05M totalt inkl. 128K output) | $10/$50 | $1 |

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
| Sol (flaggskip) | `gpt-5.6-sol` | 922K (1,05M totalt inkl. 128K output) | $4/$20 (ned fra $5/$30, se nedenfor) | $0.40 |
| Terra (anbefalt) | `gpt-5.6-terra` | 922K (som Sol) | $2/$12 (ned fra $2.50/$15 i juli) | $0.25 |
| Luna (rask) | `gpt-5.6-luna` | 922K (som Sol) | $0.20/$1.20 (ned fra $1/$6 i juli) | $0.10 — SVAK på long-context (41 %), unngå som dokument-default |

- `reasoning_effort: none|low|medium|high|xhigh|max` (default medium) — gyldig toppnivåfelt på `/v1/chat/completions`, dagens SSE-kode fungerer uendret.
- Azure: dagens `api-version=2024-12-01-preview` er for gammel for 5.6 — oppgrader ved behov.
- **Prisrettelse 2026-08-24** (developers.openai.com/api/docs/models/gpt-5.6-sol):
  Sol falt fra $5/$30 (cached $0.50) til $4/$20 (cached $0.40) per MTok inn/ut.
  Terra og Luna uendret samme kilde. Ren prisendring, ingen kodeendring —
  `MODEL_CONTEXT_TOKENS` styres av kontekst, ikke pris, og pris for kuraterte
  ids brukes ikke i UI-rangeringen (den gjelder kun live/OpenRouter-lister).
  272K-terskelteksten fortsatt ordrett som notert 17.8.2026, samme side.
- Ukentlig review 2026-08-31 (developers.openai.com/api/docs/models, sjekket
  samme dag): ingen endring i modeller, id-er, kontekst eller pris for Sol/
  Terra/Luna. Ingen nye eller pensjonerte modeller i familien.

## Hostede kompat-tjenester (agentverifisert 12.8.2026, oppdatert 17.8.2026 og 31.8.2026 mot leverandørdocs)

Kuratert i `ai-models.ts` etter kuratert-kun-regelen (færre modeller som
beviselig virker > alle modeller). Kilder: ai.google.dev/gemini-api/docs
(models + pricing) og ai.google.dev/gemini-api/docs/openai (reasoning-mapping),
docs.x.ai/developers/grok-4-6 og docs.x.ai/developers/model-capabilities/text/reasoning,
docs.mistral.ai/getting-started/models og docs.mistral.ai/models/model-cards/*,
console.groq.com/docs/models, /docs/reasoning og /docs/deprecations.

| Leverandør | Kuratert id | Kontekst | Notat |
|---|---|---|---|
| Gemini | `gemini-3.1-pro-preview` | 1M | Flaggskip (Preview — id-en KAN rotere ved GA, sjekk ved neste review; fortsatt Preview 31.8.2026 (ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview: 1 048 576 inn / 65 536 ut, text+image+video+audio+PDF → text), «Gemini 3.5 Pro»-lansering fortsatt forsinket ifølge presseomtale 13.8.2026) |
| Gemini | `gemini-3.7-flash` | 1M (1 048 576 dokumentert, gulvet på 1_000_000 som ellers i katalogen) | **Byttet inn 17.8.2026, erstatter `gemini-3.6-flash`** — lansert 13.8.2026, tre uker etter 3.6 Flash (blog.google/.../introducing-gemini-3-7-flash, ai.google.dev/gemini-api/docs/models/gemini-3.7-flash). Modellkortet bekrefter input tekst/bilde/video/lyd/PDF, output kun tekst — kuratert-regel #2 innfridd. Intropris $0.75/$3.75 per MTok inn/ut ut 2026, stiger til $1.50/$7.50 fra 1.1.2027 (ai.google.dev/gemini-api/docs/pricing) |
| Gemini | `gemini-3.5-flash-lite` | ukjent → gulv | GA, billigst ($0.30/$2.50) |
| xAI | `grok-4.6` | 500K | **Nytt 13.8.2026** — landet, forbigår grok-4.5 som flaggskip; `reasoning_effort` low/medium/high (default)/xhigh DOKUMENTERT → med i OPENAI_REASONING_RE |
| xAI | `grok-4.3` | 1M | Standard-tier ($1.25/$2.50); effort-støtte UVERIFISERT → utenfor regexen (fortsatt uverifisert 17.8.2026, docs.x.ai/developers/models nevner ikke reasoning for 4.3) |
| Mistral | `mistral-medium-3-5-26-04` | 256K (verifisert 13.8.2026, gjensjekket 31.8.2026: docs.mistral.ai/models/model-cards/mistral-medium-3-5-26-04) | Frontier (Medium > Large i dagens lineup!) |
| Mistral | `mistral-large-3-25-12` | 256K (verifisert 13.8.2026, model-card) | Open-weight arbeidshest ($0.50/$1.50) |
| Mistral | `mistral-small-4-0-26-03` | 256K (verifisert 13.8.2026, model-card) | Rask/billig |
| Groq | `openai/gpt-oss-120b` | 131K | Production-tier; Llama-parene (`llama-3.1-8b-instant`, `llama-3.3-70b-versatile`) deprecated **16.8.2026, bekreftet på nytt 24.8.2026** (console.groq.com/docs/deprecations — datoen fra 17.8-runden holder, forrige notat om 17.6.2026 var feil kilde/lesing; begge Llama-idene er uansett utenfor vår kuraterte liste, så ingen kodeendring). `reasoning_effort` low/medium/high **bekreftet 17.8.2026** (console.groq.com/docs/reasoning: «only supported by GPT-OSS 20B and GPT-OSS 120B») → lagt til i OPENAI_REASONING_RE; «none»/av UVERIFISERT (samme gap som grok-4.5/4.6s av-verdi), degrade-on-400-nettet dekker feilgjetningen |
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
  thinking_level/-budget-tabell (sjekket 13.8.2026, gjensjekket 17.8.2026 og
  24.8.2026 — samme fire rader), men radene heter «Gemini 3.1 Pro / 3.1
  Flash-Lite / 3 Flash / 2.5» — ikke våre eksakte kuraterte id-er
  (`gemini-3.5-flash-lite`
  matcher ingen rad, og med byttet til `gemini-3.7-flash` denne runden matcher
  INGEN av de tre kuraterte id-ene en rad eksakt lenger; `gemini-3.1-pro-preview`
  er trolig samme familie som «3.1 Pro», men tabellen har INGEN `none`-rad, og
  modellkort-siden for 3.7 Flash sier ingenting om reasoning_effort i det hele
  tatt). Fortsatt IKKE lagt til regexen — for tynn/foreldet dekning til å
  stole på for hele effort-spekteret vi trenger, og «Av» ville vært et gjett
  uansett id.
- ~~Groq: nevner reasoning_effort for gpt-oss-120b/20b i det hele tatt?~~
  **Lukket 31.8.2026** (delvis lukket 17.8.2026) — console.groq.com/docs/reasoning
  bekrefter low/medium/high for begge (se tabellen over); lagt til
  OPENAI_REASONING_RE. Samme side svarer nå også på «none»-spørsmålet
  eksplisitt: GPT-OSS 120B/20B støtter **kun** low/medium/high — «none» er
  reservert for Qwen 3.6/3.8-modellene Groq også hoster, ikke for gpt-oss.
  Det er altså en bekreftet FEILVERDI, ikke lenger en udokumentert gjetning:
  når tenkeinnsats settes til «Av» sender `openAiEffort()`
  (`src/shared/ai-chat.ts`) i dag `reasoning_effort: "none"` for gpt-oss
  (samme heuristikk som grok-4.5/4.6), Groq avviser den, og
  degrade-on-400-nettet fanger den og prøver på nytt uten parameteren —
  samme oppførsel brukeren ser i dag, ingen regresjon. Ingen kodeendring
  gjort her (retten til å hoppe over å sende reasoning_effort i det hele
  tatt når nivå=Av for gpt-oss er en heuristikk-finpuss, ikke en
  korrekthetsrettelse — flagg til Emil om ønskelig, ikke gjort i denne
  runden).
- Mistral: ingen `-latest`-alias funnet for medium-3-5/large-3/small-4 på
  docs.mistral.ai (sjekket 13.8.2026, gjensjekket 17.8.2026 og 24.8.2026 —
  uendret). Kontekstvinduene er nå verifisert (se tabellen), så denne delen av
  spørsmålet er lukket; alias-delen forblir åpen i den forstand at et
  fremtidig alias ikke er utelukket, bare ikke observert. Sett på samme side
  24.8.2026, men IKKE relevant for vår liste: en Ministral 3-serie (14B/8B/3B)
  og Zhipus «Z.ai GLM 5.2» (tredjeparts open-weight, hostet i Mistrals
  katalog, oppgitt 1M kontekst) — ingen av dem er Mistrals eget
  flaggskip-spor, og verken bilde-input eller chat-kvalitet er vurdert for
  dem; utenfor kuratert-kun-regelen inntil noen faktisk trenger dem.
- **xAI Grok 4.20, fortsatt IKKE lagt til.** Nytt 24.8.2026, oppdatert
  31.8.2026 (docs.x.ai/developers/models,
  docs.x.ai/developers/models/grok-4.20-0309-reasoning,
  docs.x.ai/developers/model-capabilities/text/reasoning). De tre id-ene
  (`grok-4.20-0309-reasoning`/`-non-reasoning`/`-multi-agent-0309`, 1M
  kontekst hver) har nå egne dokumenterte modellsider uten beta-suffiks i
  selve id-en, og `grok-4.20-0309-reasoning`s side bekrefter bilde-input
  («text, image → text», output kun tekst — kuratert-regel #2 ville vært
  innfridd) og posisjonerer familien som «industry-leading speed and
  agentic tool calling», ikke generell chat. Om alias som `grok-4.20-beta`
  fortsatt eksisterer ved siden av kunne ikke bekreftes entydig denne
  runden (sprikende svar); sjekk igjen neste review.

  **Viktig funn 31.8.2026:** reasoning-siden dokumenterer INGEN
  `reasoning_effort` for `grok-4.20-0309-reasoning` selv — kun for
  `grok-4.20-multi-agent`, og der betyr `reasoning.effort` noe helt annet
  enn på resten av lineupen: den styrer **hvor mange agenter samarbeider**
  om forespørselen, ikke tenkedybde. Å legge `grok-4.20-multi-agent` inn med
  vår vanlige effort-heuristikk ville altså sendt riktig parameternavn med
  fullstendig feil betydning — nøyaktig den typen gjetning
  kuratert-kun-regelen finnes for å hindre. Fortsatt et åpent spørsmål:
  sjekk ved neste review om id-ene har rotet helt ut av beta, om
  `-0309-reasoning` får en dokumentert reasoning_effort, og om
  multi-agent-varianten i det hele tatt hører hjemme i en chat-modell-meny
  (svaret er trolig nei, den er et agentisk verktøy). Samtidig sett:
  `grok-build-0.1` (kodingsspesifikt agent-verktøy, 256K kontekst, samme
  pristerskel-mønster) — ikke et generelt chat-produkt og bilde-input er
  udokumentert, så den er utenfor scope uavhengig av beta-status.

## Anbefalt mapping «Tenkeinnsats» (Av/Lav/Middels/Høy)

| Valg | Opus 5 / Sonnet 5 | Fable 5 / 5.1 | Haiku 4.5 | OpenAI gpt-5.6 | OpenAI gpt-6 |
|---|---|---|---|---|---|
| Av | Opus: utelat; Sonnet 5: `{type:"disabled"}` | umulig (→ effort low) | utelat | `none` | umulig (`none` → 400; → `low`) |
| Lav/Middels/Høy | `adaptive` + effort low/medium/high | effort low/medium/high | ikke støttet (utelat) | low/medium/high | low/medium/high |

Defaults: anthropic `claude-sonnet-5` + Middels; openai `gpt-5.6-terra` + medium.
Heuristikk: effort kun når id ikke matcher `haiku` (fallback i `anthropicTraits`
skiller ikke videre på Opus/Sonnet/Fable-generasjon — «alwaysThinks» slår bare
inn for `fable|mythos`); Haiku alltid uten thinking. OpenAI: `reasoning_effort`
sendes for `OPENAI_REASONING_RE` (`gpt-[5-9]|o[0-9]|grok-4.[56]|gpt-oss`), og
«Av» blir `low` i stedet for `none` for `OPENAI_ALWAYS_REASONS_RE` (`gpt-6`).
