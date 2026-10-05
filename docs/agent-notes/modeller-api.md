# API-katalog (agentverifisert juli 2026, sist oppdatert 2026-10-05) — grunnlag for modell/tenkeinnsats-implementasjon

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
| Claude Opus 5.5 | `claude-opus-5-5` | 1M | $4/$20 (cache-lesing $0.20, 0,05× inn-pris) |
| Claude Opus 5 (legacy fra 22.9.2026, kun lagrede valg) | `claude-opus-5` | 1M | $5/$25 |
| Claude Sonnet 5.5 | `claude-sonnet-5-5` | 1M | $2/$10 |
| Claude Sonnet 5 (legacy fra 28.9.2026, kun lagrede valg) | `claude-sonnet-5` | 1M | $2/$10 |
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

**Review 2026-09-26 (platform.claude.com/docs/en/models/overview,
/models/opus-5-5/overview og /models/opus-5-5/whats-new-opus-5-5, sjekket
samme dag): Claude Opus 5.5 (`claude-opus-5-5`) lanserte 22.9.2026 og har tatt
Opus 5s plass i tabellen over.** Opus 5 ligger nå under «Legacy models» —
fortsatt tilgjengelig, så den beholdes i `MODEL_CONTEXT_TOKENS` for lagrede
valg, men er ute av den kuraterte listen (samme regel som Fable 5 → 5.1).
Oversiktssiden anbefaler nå Opus 5.5 som startpunkt «for most workloads».
1M kontekst, 128K output, tekst + bilde inn → tekst ut (kuratert-regel #2
innfridd), billigere enn Opus 5 ($4/$20 mot $5/$25). Kunnskaps-cutoff juni
2026, pensjonering tidligst 22.9.2027. Default effort er `medium` (Opus 5:
`high`) — vi setter alltid effort eksplisitt, så det endrer ingenting her.

Bruddene mot Opus 5, vurdert mot `chatAnthropic` i `src/shared/ai-chat.ts`:
- **Thinking kan ikke slås av.** Ordrett: «a request that sets `thinking:
  {"type": "disabled"}`, or a manual budget … returns a 400». Dette traff
  oss: `anthropicTraits` regnet bare `fable|mythos` som alltid-tenkende, og
  med live capability-data (adaptive, ingen budget) ble Opus 5.5 lest som en
  explicit-off-modell som Sonnet 5 — «Av» hadde sendt `disabled`, fått 400 og
  gått via degrade-nettet. **Rettet:** `alwaysThinks` er nå
  `/fable|mythos|opus-5-5/`, på begge grener; «Av» → effort `low` uten
  thinking-felt, som Fable. Server-side fallback (`fallbacks: 'default'`)
  gjelder også Opus fra 27.9.2026 — se «Standardmodeller og fallback» under.
- **Tvunget `tool_choice` gir 400**, og **thinking-blokker er bundet til
  modell og samtaleprefiks** — samme to brudd som Fable 5.1, og av samme
  grunner uten betydning for oss (vi sender aldri `tool_choice`, og
  historikken går tilbake som ren tekst). Ingen endring.
- **`computer_20251124` avvises** — vi bruker ikke computer use.
- **Tekst mellom verktøykall kommer som thinking-blokker** (tom tekst ved
  default `display: "omitted"`). Treffer bare web-søk-svar med flere søk:
  mellomnotatene («Jeg søker etter …») vises ikke lenger; selve svaret etter
  siste søk er fortsatt tekst. Ingen endring — vi viser ikke mellomnotater
  som fremdrift.
- **Web-søk:** web-search-siden (platform.claude.com/docs/en/agents-and-tools/
  tool-use/web-search-tool) sier «Dynamic filtering is available with Claude
  4.6 and later models», og bruker `claude-opus-5-5` i eksemplene med både
  `_20250305` og `_20260318`. `anthropicWebSearchTool` kjente bare
  `opus-4-[6-9]`, så **Opus 5 har fått basis-varianten i det stille siden
  13.8.2026**; regexen har nå `opus-[5-9]`, som dekker begge.
- **Rettelse av en eldre regel:** whats-new-siden sier ordrett «On Claude Opus
  5, thinking is on by default and `thinking: {"type": "disabled"}` is
  accepted at effort `high` or below». Regelen under («Opus 5: utelatt felt
  = av») var altså feil, og regex-fallbacken fulgte den — uten live
  capability-data (førstegangskjøring/offline) lot «Av» thinking stå PÅ for
  Opus 5. `explicitOff` i fallbacken er nå `/sonnet-[5-9]|opus-[5-9]/`
  (Opus 5.5 når aldri dit, `alwaysThinks` slår inn først). Med live data
  var dette allerede riktig.
- Verifisert i `npm run test:ai-chat` («opus 5.5»- og «opus 5»-assertions,
  både regex- og live-caps-grenen). **Live spørsmål med ekte nøkkel
  gjenstår (Emil, MAINTENANCE.md rad 2).**

**Ukentlig review 2026-10-05 (platform.claude.com/docs/en/docs/about-claude/models
→ platform.claude.com/docs/en/models/overview, /models/sonnet-5-5/overview og
/models/sonnet-5-5/whats-new-sonnet-5-5, sjekket samme dag): Claude Sonnet 5.5
(`claude-sonnet-5-5`) lanserte 28.9.2026 og har tatt Sonnet 5s plass i
tabellen over.** Sonnet 5 ligger nå under «Legacy models» — fortsatt
tilgjengelig, så den beholdes i `MODEL_CONTEXT_TOKENS` for lagrede valg, men
er ute av den kuraterte listen (samme regel som de tre foregående byttene).
1M kontekst, 128K output, samme pris som Sonnet 5 ($2/$10), tekst + bilde inn
→ tekst ut (kuratert-regel #2 innfridd). Kunnskaps-cutoff juni 2026,
pensjonering tidligst 28.9.2027. Default effort `high` (som Fable 5.1, ulikt
Opus 5.5s `medium`) — vi setter alltid effort eksplisitt, så det endrer
ingenting her.

Sonnet 5.5s thinking er **Adaptiv, IKKE alltid-på** (oversiktstabellen sier
«Adaptive», ikke «Adaptive (always on)» som Fable/Opus 5.5) — den tilhører
altså Sonnet 5s familie av eksplisitt-av-modeller, ikke Fable/Opus 5.5s. Men
selve AV-mekanismen er ny og brøt oss (vurdert mot `chatAnthropic`/
`anthropicThinking` i `src/shared/ai-chat.ts`, 2026-10-05):

- **`thinking: {"type":"disabled"}` er nå en 400 på Sonnet 5.5** — ordrett:
  «a request that sends `thinking: {"type": "disabled"}` returns a 400
  `invalid_request_error` whose message points to `between_tools`». Laveste
  tenkenivå er i stedet `thinking: {"type":"between_tools"}` — godtatt på
  `low`/`medium`/`high` effort (400 på `xhigh`/`max`, som UI-et vårt uansett
  ikke tilbyr), tar ingen andre felt (`display`/`budget_tokens`/
  `block_binding` → 400). Uten denne rettelsen hadde «Av» sendt `disabled`,
  fått 400, og degrade-nettet hadde strippet HELE thinking-feltet — nøyaktig
  samme regresjonsklasse som Opus 5.5-hendelsen 26.9.2026 (thinking hadde
  blitt stående PÅ etter at brukeren ba om «Av»). **Rettet:** ny
  `betweenToolsOff`-egenskap i `AnthropicTraits`, lest av modell-id-en
  (`/sonnet-5-5/i`) uavhengig av caps-grenen, akkurat som `alwaysThinks` —
  API-ets capability-tre skiller ikke på dette. `anthropicThinking` sender nå
  `{type:"between_tools"}` i stedet for `{type:"disabled"}` når flagget er
  satt.
- **Sonnet 5.5 har klassifikatorer, Sonnet 5 hadde ikke.** «Behavior
  differences»-seksjonen lister fem `stop_details`-kategorier (`cyber`,
  `bio`, `frontier_llm`, `reasoning_extraction`, `general_harms»), og
  server-side fallback «retries "cyber" and "frontier_llm" declines on Claude
  Sonnet 5» — altså samme mønster som Opus 5.5 (fallback-mål navngitt, ingen
  pinnet id å vedlikeholde siden vi bruker `fallbacks:"default"`). **Rettet:**
  `hasClassifiers`-regexen i `chatAnthropic` er nå
  `/fable|mythos|opus-5|sonnet-5-5/i` — Sonnet 5.5 spør nå om
  server-side-fallback-beta og bruker beta-klienten, Sonnet 5 fortsatt ikke.
- **Tvunget `tool_choice` gir 400** (samme som Fable/Opus 5.5) — vi sender
  aldri `tool_choice`. Ingen endring.
- **Thinking-blokker bundet til modell OG samtale** — Sonnet 5.5 leser bare
  Sonnet 5/Opus 4.8/Haiku 4.5/eldre sine blokker, ikke Opus 5/5.5 eller
  Fable/Mythos. Vi replayer aldri thinking-blokker (historikken går tilbake
  som ren tekst), så dette rammer oss ikke — samme konklusjon som for Fable
  5.1 og Opus 5.5.
- **`computer_20251124` avvises på Claude API/Google Cloud** — vi bruker ikke
  computer use. Ingen endring.
- **«Text between tool calls» kommer nå som thinking-blokker** ved default
  `display:"omitted"` — samme mekanisme som Opus 5.5s web-søk-mellomnotater;
  vi viser ikke mellomnotater som fremdrift uansett. Ingen endring.
- Web-søk: `anthropicWebSearchTool`s `sonnet-[5-9]`-gren dekker allerede
  `claude-sonnet-5-5` (understreng-match) — ingen kodeendring nødvendig.
- Verifisert i `npm run test:ai-chat` («sonnet 5.5»-assertions: between_tools
  av, adaptive på, fallbacks default, moderne web-søk-verktøy). **Live
  spørsmål med ekte nøkkel gjenstår (Emil, MAINTENANCE.md rad 2).**

Thinking-regler:
- `budget_tokens` gir **400** på Fable/Opus 5/Sonnet 5. Bruk `thinking: {type:"adaptive"}` + `output_config: {effort: "low|medium|high|xhigh|max"}`.
- Fable 5 og 5.1: thinking alltid på (disabled/budget → 400); `temperature` → 400; krever `client.beta.messages.stream` med `betas: ['server-side-fallback-2026-07-01']`, `fallbacks: 'default'` (Anthropic velger fallback per avslagskategori — ingen pinnet modell-id å vedlikeholde; den eldre array-formen bruker `-2026-06-01`-headeren); sjekk `stop_reason === 'refusal'` før content leses.
- Sonnet 5: thinking er PÅ som default når feltet utelates — «Av» krever `{type:"disabled"}`.
- Sonnet 5.5: thinking er PÅ som default (adaptiv, IKKE alltid-på) — men `{type:"disabled"}` er selv en 400 her. «Av» krever `{type:"between_tools"}` i stedet (godtatt på effort `high` og lavere); default effort `high`. Har klassifikatorer (ulikt Sonnet 5) → `fallbacks:'default'` + beta-klient.
- Opus 5.5: thinking alltid på (disabled/budget → 400, ingen beta-header involvert); default effort `medium`.
- Opus 5: thinking PÅ som default når feltet utelates — «Av» krever `{type:"disabled"}` (godtatt på effort `high` og lavere). Notatet sa «utelatt felt = av» fram til 26.9.2026; det var feil (se review 2026-09-26 over). Opus 4.8 er ikke gjensjekket.
- Haiku 4.5: `effort` feiler; thinking via `budget_tokens` (min 1024) eller utelat.
- `effort` i `output_config`, GA. Hev `max_tokens` til 8–16K når thinking er på (dagens 4096 er for lite).
- Nytt 2026-08-13: på Opus 5 og Sonnet 5 defaulter `effort` til `"high"` på Claude API/Claude Code når feltet utelates (Opus 4.8 defaulter til `high` på ALLE surfaces, inkl. claude.ai). Vi setter alltid `effort` explisitt fra tenkeinnsats-valget, så dette endrer ikke request-shapingen — bare verdt å vite hvis en fremtidig degrade-net-treff ser rar ut.
- Å endre `thinking`-feltet invaliderer messages-cachen (dokumentblokken) → lås tenkeinnsats per samtale.
- Citations upåvirket av thinking.

## OpenAI gpt-6 Astra (lansert 3.9.2026), gpt-6 Sol/Luna (22.9.2026) og gpt-5.6 (9.7.2026)

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

**Review 2026-09-26 (developers.openai.com/api/docs/models,
/api/docs/models/all, /api/docs/models/gpt-6-sol og /gpt-6-luna, sjekket
samme dag; lanseringsdato fra techcrunch.com/2026/09/22/openai-launches-gpt-6-sol-and-luna):
GPT-6 Sol (`gpt-6-sol`) og GPT-6 Luna (`gpt-6-luna`) har erstattet
`gpt-5.6-sol` og `gpt-5.6-luna` i den kuraterte listen.** Modellsiden viser
nå Astra/Sol/Luna som de tre flaggskipene; 5.6-modellene står fortsatt i
«all models» uten deprecated-merke, så de beholdes i `MODEL_CONTEXT_TOKENS`
for lagrede valg. **Det finnes ingen GPT-6 Terra** — `gpt-5.6-terra` beholder
sin plass denne runden. **Oppdatert 27.9.2026:** GPT-6 Sol er ny standard
(Emil), og `gpt-5.6-terra` gikk ut av menyen samtidig — den er både eldre og
dyrere enn 6 Sol ($2/$12 mot $2/$10), så den hadde ingen rolle igjen. Listen
er Astra, 6 Sol, 6 Luna, sterkest først; et lagret Terra-valg står.

- Begge: tekst + bilde inn, kun tekst ut (kuratert-regel #2 innfridd);
  1,05M totalt / **922K input** / 128K output, som resten av familien →
  900_000 i `MODEL_CONTEXT_TOKENS`. Samme 272K-pristerskel (2× inn/cache,
  1,5× ut for hele forespørselen).
- **`reasoning.effort` tar `none|low|medium|high|xhigh|max` (default medium)
  på begge** — altså MED `none`, i motsetning til Astra.
  `OPENAI_ALWAYS_REASONS_RE` var `/gpt-6/` og ville sendt `low` for «Av» til
  hele 6-serien; snevret inn til `gpt-6-astra` (se også xAI-raden i
  § Hostede kompat-tjenester, som deler regexen nå).
- Sol-siden: «Chat Completions supports function calling only with
  `reasoning_effort` set to `none`». Treffer ikke oss: OpenAI-stien bruker
  Responses API med den hostede `web_search`-tool'en, ikke function calling;
  Azure-stien (Chat Completions) sender ingen tools.
- Pris: Sol $2/$10 (cached $0.20), Luna $0.10/$0.50 (cached $0.01) — halve
  5.6-prisene. Kunnskaps-cutoff: Sol 20.4.2026, Luna 18.5.2026.
- **Live spørsmål med ekte nøkkel gjenstår (Emil).**

| Modell | ID | Kontekst (input) | Pris inn/ut | Cached inn |
|---|---|---|---|---|
| Sol (GPT-6) | `gpt-6-sol` | 922K (1,05M totalt inkl. 128K output) | $2/$10 | $0.20 |
| Luna (GPT-6, rask) | `gpt-6-luna` | 922K (som Sol) | $0.10/$0.50 | $0.01 |

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
| Sol (5.6, ute av menyen 26.9.2026, kun lagrede valg) | `gpt-5.6-sol` | 922K (1,05M totalt inkl. 128K output) | $4/$20 (ned fra $5/$30, se nedenfor) | $0.40 |
| Terra (5.6, ute av menyen 27.9.2026, kun lagrede valg) | `gpt-5.6-terra` | 922K (som Sol) | $2/$12 (ned fra $2.50/$15 i juli) | $0.25 |
| Luna (5.6, ute av menyen 26.9.2026, kun lagrede valg) | `gpt-5.6-luna` | 922K (som Sol) | $0.20/$1.20 (ned fra $1/$6 i juli) | $0.10 — SVAK på long-context (41 %), unngå som dokument-default |

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

**Ukentlig review 2026-10-05 (developers.openai.com/api/docs/models,
/api/docs/models/all og /api/docs/models/gpt-6.1-sol, sjekket samme dag;
lanseringsdato og «nearly matches Astra»-sitat fra
techcrunch.com/2026/09/29/openai-launches-gpt-6-1-sol-says-it-nearly-matches-gpt-6-astra-and-costs-less):
GPT-6.1 Sol (`gpt-6.1-sol`) lagt til i den kuraterte listen, som et NYTT
mellomsjikt — ikke en erstatning.** `/api/docs/models/all` lister fortsatt
`gpt-6-sol` som gjeldende og ikke pensjonert ved siden av 6.1 Sol, så
«samme-slot-bytte»-regelen (Fable 5→5.1, Opus 5→5.5, Sonnet 5→5.5) passer
ikke her — begge blir stående, `gpt-6-sol` beholder plassen sin OG
standard-rollen (`DEFAULT_MODELS.openai`, urørt). Lansert 29.9.2026 på DevDay;
TechCrunch siterer OpenAI: nesten på nivå med GPT-6 Astra til en femtedel av
Astras pris — som også er nøyaktig samme pris som GPT-6 Sol allerede hadde
($2/$10). Plassert over GPT-6 Sol i den kuraterte rekkefølgen (nest sterkest,
under Astra), med `ai.modelHintCapable` — «Anbefalt»-hinten følger fortsatt
standarden på `gpt-6-sol` (Emils valg, urørt).

- Modellsiden (developers.openai.com/api/docs/models/gpt-6.1-sol, sjekket
  5.10.2026): tekst + bilde inn → kun tekst ut (kuratert-regel #2 innfridd),
  1,05M totalt / **922K input** / 128K output — identisk med resten av
  6-familien → 900_000 i `MODEL_CONTEXT_TOKENS`. Pris $2/$10 (cached inn
  $0.10). Kunnskaps-cutoff 30.4.2026.
- **`reasoning.effort` tar `low|medium|high|xhigh|max` — verken `none` eller
  `minimal`.** Samme brudd som Astra (se review 2026-09-05 over). **Rettet:**
  `OPENAI_ALWAYS_REASONS_RE` (`src/shared/ai-provider-profile.ts`) er nå
  `/gpt-6-astra|gpt-6\.1-sol|grok-4\.[5-7]|gpt-oss/i` — «Av» sender `low` i
  stedet for `none`, i ÉN forespørsel. `OPENAI_REASONING_RE` dekker den
  allerede (`gpt-[5-9]` matcher «gpt-6» i «gpt-6.1-sol»).
- `isOpenAiChatModel`/`check-models.mjs`-filteret (`/^(gpt-[0-9]|o[0-9])/`)
  matcher `gpt-6.1-sol` allerede; `lineageOf` leser generasjon 6 (punktummet
  parses ikke videre, men det endrer ingenting for curated-only-menyen).
- Live `/v1/models`-tilgjengelighet ikke sjekket denne runden (ingen nøkkel i
  miljøet) — en konto som ikke har fått modellen ennå ville vist ⚠ i menyen.
  **Live spørsmål med ekte nøkkel gjenstår (Emil).**
- Verifisert i `npm run test:ai-chat` («gpt-6.1-sol off → effort low i ÉN
  forespørsel»-assertion).

| Modell | ID | Kontekst (input) | Pris inn/ut | Cached inn |
|---|---|---|---|---|
| 6.1 Sol (nær-Astra, billigere) | `gpt-6.1-sol` | 922K (1,05M totalt inkl. 128K output) | $2/$10 | $0.10 |

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
| Gemini | `gemini-3.8-flash` | 1M (1 048 576 dokumentert, gulvet på 1_000_000 som ellers i katalogen) | **Byttet inn 7.9.2026, erstatter `gemini-3.7-flash`** — lansert rundt 4.9.2026, tre uker etter 3.7 Flash (ai.google.dev/gemini-api/docs/models, /gemini-3.8-flash). Modellkortet bekrefter input tekst/bilde/video/lyd/PDF, output kun tekst — kuratert-regel #2 innfridd. Samme pris som 3.7 hadde: $0.75/$3.75 per MTok inn/ut ut 2026, stiger til $1.50/$7.50 fra 1.1.2027 (ai.google.dev/gemini-api/docs/pricing, sjekket 7.9.2026). Modellsiden nevner egen `thinkingLevel: low/medium/high`, men det er den native Gemini-APIens felt, ikke `reasoning_effort` på OpenAI-kompat-laget vi faktisk bruker — svarer ikke på det åpne reasoning-mapping-spørsmålet under. `gemini-3.7-flash` fortsatt tilgjengelig som «previous-generation», ikke pensjonert |
| Gemini | `gemini-3.5-flash-lite` | ukjent → gulv | GA, billigst ($0.30/$2.50) |
| xAI | `grok-4.7` | 500K | **Byttet inn 26.9.2026, erstatter `grok-4.6`** — lansert 21.9.2026 (marktechpost.com/2026/09/21/spacexai-releases-grok-4-7; docs.x.ai/developers/models kaller den «the most capable model we've built»). docs.x.ai/developers/models/grok-4.7: «text, image → text», 500K kontekst, samme pris som 4.6 ($2/$6, $4/$12 over 200K prompt). `reasoning_effort` low/medium/high (default)/xhigh DOKUMENTERT → med i OPENAI_REASONING_RE. **«Reasoning cannot be disabled»** (docs.x.ai/developers/model-capabilities/text/reasoning, gjelder 4.5/4.6/4.7) → med i OPENAI_ALWAYS_REASONS_RE, «Av» sender `low` |
| xAI | `grok-4.6` | 500K | Ute av menyen 26.9.2026 (erstattet av 4.7); beholdt i `MODEL_CONTEXT_TOKENS` og begge regexene for lagrede valg. Det åpne spørsmålet om 4.5/4.6s av-verdi er LUKKET samme dag: reasoning kan ikke slås av, så `none` var aldri en gyldig verdi |
| xAI | `grok-4.3` | 1M | Standard-tier ($1.25/$2.50); effort-støtte UVERIFISERT → utenfor regexen (fortsatt uverifisert 17.8.2026, docs.x.ai/developers/models nevner ikke reasoning for 4.3) |
| Mistral | `mistral-medium-2604` | 256K (model-card docs.mistral.ai/models/model-cards/mistral-medium-3-5-26-04, verifisert 13.8.2026; **id-en rettet 5.10.2026**, se review) | Frontier ($1.5/$7.5). `reasoning_effort` high/none dokumentert (docs.mistral.ai/capabilities/reasoning) → `MISTRAL_REASONING_RE`. Alias `mistral-medium-latest` |
| Mistral | `ministral-14b-2512` | 256K (model-card docs.mistral.ai/models/model-cards/ministral-3-14b-25-12, lest 5.10.2026) | **Inn 5.10.2026** som rask modell: test:live 7/7 (svar 1,1 s, sitat, bildet lest «Rød.»), ingen reasoning_effort (ikke dokumentert, ikke sendt). $0.2/$0.2. Alias `ministral-14b-latest`. Apache 2.0 |
| Mistral | ~~`mistral-small-2603`~~ | — (utenfor koden; vinduet står i model-card) | **IKKE kuratert** fra 5.10.2026 (var inne noen timer samme dag): blind for bilder under `reasoning_effort: "high"`, og under `none` kalte den et rødt kvadrat «et blankt dokument» med assistentens systemprompt — test:live 6/7 to ganger. `MISTRAL_REASONING_RE`/`MISTRAL_BLIND_WHEN_REASONING_RE` dekker den fortsatt for et lagret/skrevet valg. $0.15/$0.6 |
| Mistral | ~~`mistral-large-2512`~~ | — (utenfor koden; vinduet står i model-card) | **IKKE kuratert** fra 5.10.2026: finnes (changelog 12.2025). Først 403 `tier_not_allowed` på eierens gratisnivå; etter at pay-as-you-go ble aktivert samme dag svarer den, men **blind for bilder**: test:live 6/7, og direkte sonder kalte et rødt kvadrat «Hvitt» i fem av seks forsøk (også uten tenkeparametre; assistentens prompt ga i tillegg «ingen farge, dokumentet har ingen visuelle elementer»). Sitat og dokumentbruk fungerer (1,5 s). Avviser `reasoning_effort` med 400 «not enabled for this model» (kode 3051) — riktig at vi ikke sender den. $0.5/$1.5, 256k. Domineres av Medium 3.5 på bildelesing, så den er ute etter Emils regel om state of the art (5.10.2026) |
| Groq | `openai/gpt-oss-120b` | 131K | Production-tier; Llama-parene (`llama-3.1-8b-instant`, `llama-3.3-70b-versatile`) deprecated **16.8.2026, bekreftet på nytt 24.8.2026** (console.groq.com/docs/deprecations — datoen fra 17.8-runden holder, forrige notat om 17.6.2026 var feil kilde/lesing; begge Llama-idene er uansett utenfor vår kuraterte liste, så ingen kodeendring). `reasoning_effort` low/medium/high **bekreftet 17.8.2026** (console.groq.com/docs/reasoning: «only supported by GPT-OSS 20B and GPT-OSS 120B») → lagt til i OPENAI_REASONING_RE. «Av»: kun low/medium/high er gyldig (lukket 31.8.2026, se åpne spørsmål) → med i OPENAI_ALWAYS_REASONS_RE fra 26.9.2026, «Av» sender `low` |
| Groq | `openai/gpt-oss-20b` | 131K | Production-tier, rask — samme reasoning_effort-bekreftelse som 120b |

Grok 4.5 (`grok-4.5`) er ikke lenger i den kuraterte listen, men står fortsatt
i `MODEL_CONTEXT_TOKENS` og `OPENAI_REASONING_RE` (ai-provider-profile.ts) slik
at brukere som allerede har den valgt ikke mister kontekstestimat eller
tenkeinnsats-styring. Det samme gjelder nå `gemini-3.6-flash` OG
`gemini-3.7-flash` i `MODEL_CONTEXT_TOKENS` etter byttene til hhv. 3.7 og 3.8
Flash.

Åpne spørsmål til neste review (svar med kilde + dato når de lukkes):
- ~~Finnes det et prishopp over 272K input-tokens hos OpenAI?~~ **Lukket
  17.8.2026** — bekreftet førstepartskilde, se § OpenAI gpt-5.6 over. Det er
  en PRIS-terskel, ikke en kapasitetsterskel, så `MODEL_CONTEXT_TOKENS` er
  uendret; om appen bør kutte til utdrag tidligere enn 922K av rene
  kostnadshensyn er en produktbeslutning, ikke en korrekthetsrettelse — flagg
  til Emil, gjør det ikke selv.
- Gemini: ai.google.dev/gemini-api/docs/openai har en reasoning_effort→
  thinking_level/-budget-tabell (sjekket 13.8.2026, gjensjekket 17.8.2026,
  24.8.2026 og 7.9.2026 — fortsatt samme fire rader), men radene heter «Gemini
  3.1 Pro / 3.1 Flash-Lite / 3 Flash / 2.5» — ikke våre eksakte kuraterte
  id-er (`gemini-3.5-flash-lite` matcher ingen rad, og med byttet til
  `gemini-3.8-flash` denne runden matcher fortsatt INGEN av de tre kuraterte
  id-ene en rad eksakt; `gemini-3.1-pro-preview` er trolig samme familie som
  «3.1 Pro», men tabellen har INGEN `none`-rad). 3.8 Flashs eget modellkort
  (ai.google.dev/gemini-api/docs/models/gemini-3.8-flash, sjekket 7.9.2026)
  oppgir riktignok «Thinking: Supported (low, medium, high)» — men det er den
  native Gemini-APIens `thinkingLevel`-felt, ikke `reasoning_effort` på
  OpenAI-kompat-laget appen faktisk snakker mot
  (`generativelanguage.googleapis.com/v1beta/openai`, se
  `ai-provider-profile.ts`), så det svarer ikke på spørsmålet heller. Fortsatt
  IKKE lagt til regexen — for tynn/foreldet dekning til å stole på for hele
  effort-spekteret vi trenger, og «Av» ville vært et gjett uansett id.
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
  **Rettet 26.9.2026:** gpt-oss står nå i `OPENAI_ALWAYS_REASONS_RE`, så
  «Av» sender `low` i stedet for `none` — samme ærlige mapping som Astra og
  grok 4.5–4.7, og én forespørsel i stedet for 400 + retry.
- ~~Opus 5.5 og server-side fallback?~~ **Lukket 27.9.2026** — se
  «Standardmodeller og fallback» under.
- ~~Mistral: ingen `-latest`-alias funnet for medium-3-5/large-3/small-4~~
  **Lukket 5.10.2026** — aliasene finnes (`mistral-medium-latest`,
  `mistral-small-latest` i /v1/models), og det vi hadde lest som id-er var
  dokumentasjonens URL-slugs; se review 2026-10-05. Historikk: sjekket
  13.8.2026, gjensjekket 17.8.2026 og 24.8.2026 — uendret. Kontekstvinduene er nå verifisert (se tabellen), så denne delen av
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

  **Gjensjekket 7.9.2026** (docs.x.ai/developers/models,
  docs.x.ai/developers/models/grok-4.20-0309-reasoning): samme status som
  31.8.2026 — konteksten (1M) og modaliteten (bilde inn, kun tekst ut) er
  uendret, siden nevner fortsatt ingen `reasoning_effort` for
  `-0309-reasoning` selv, og beta-alias (`grok-4.20-beta-*`) ser fortsatt ut
  til å eksistere ved siden av de «rene» id-ene uten at kilden er entydig om
  hvorvidt de er synonyme eller et eget spor. Fortsatt utenfor kuratert-kun-
  regelen; ingen fremgang siden forrige runde utover at statusen holder seg
  stabil.

Ukentlig review 2026-09-07 (platform.claude.com/docs/en/models/overview,
developers.openai.com/api/docs/models, ai.google.dev/gemini-api/docs/models,
docs.x.ai/developers/models, docs.mistral.ai/getting-started/models,
console.groq.com/docs/models og /docs/deprecations, alle sjekket samme dag):

- **Anthropic:** tabellen over stemmer ord for ord (Fable 5.1/Opus 5/Sonnet
  5/Haiku 4.5, samme priser, samme kontekst, samme «Legacy models»-liste).
  Ingen endring.
- **OpenAI:** GPT-6 Astra + 5.6-trioen uendret — samme id-er, kontekst
  (1,05M/922K input) og reasoning-verdier (Astra low..max uten `none`; Sol/
  Terra/Luna low..max MED `none`) som notert 5.9.2026. Ingen nytt lansert.
  Ingen endring.
- **Gemini — DRIFT:** **Gemini 3.8 Flash** erstatter `gemini-3.7-flash` i den
  kuraterte listen denne runden — se § Hostede kompat-tjenester-tabellen over
  for full verifisering (kontekst, modaliteter, pris, reasoning-forbehold).
  `gemini-3.1-pro-preview` (fortsatt Preview) og `gemini-3.5-flash-lite`
  uendret. Ingen «Gemini 3.5 Pro»-GA observert.
- **xAI:** `grok-4.6`/`grok-4.3` uendret. Grok 4.20 fortsatt IKKE lagt til —
  se oppdatert åpent spørsmål nedenfor.
- **Mistral:** alle tre kuraterte id-er, kontekstvinduer og priser uendret;
  fortsatt ingen `-latest`-alias observert.
- **Groq:** `openai/gpt-oss-120b`/`-20b` uendret; Llama-paret fortsatt
  deprecated 16.8.2026 (console.groq.com/docs/deprecations, sjekket samme
  dag — ingen nye pensjoneringer siden). Ingen endring.
- `npm run check:models` (keyless): ingen statisk drift; OpenRouter-probe
  fortsatt 430 modeller, alle tre felt (`input_modalities`/`output_modalities`/
  `created`) og `pricing.completion` intakte.

Review 2026-09-26 (manuell, på Emils spørsmål; kildene er de samme som
7.9.2026, alle sjekket samme dag). De ukentlige agentkjøringene 14.9 og 21.9
fant ingen drift; alle tre lanseringene under kom 21.–22.9:

- **Anthropic — DRIFT:** Opus 5.5 erstatter Opus 5 (se § Anthropic, review
  2026-09-26). Fable 5.1/Sonnet 5/Haiku 4.5 uendret.
- **OpenAI — DRIFT:** GPT-6 Sol og Luna erstatter 5.6 Sol og Luna; Astra og
  5.6 Terra uendret (se § OpenAI, review 2026-09-26).
- **xAI — DRIFT:** Grok 4.7 erstatter Grok 4.6; `grok-4.3` uendret. Grok
  4.20-id-ene står fortsatt i listen, ikke gjensjekket i dybden denne
  runden.
- **Gemini:** `gemini-3.1-pro-preview` (fortsatt Preview), `gemini-3.8-flash`
  og `gemini-3.5-flash-lite` uendret. Ny `gemini-3.8-live` er en
  tale-/Live API-modell, ikke relevant.
- **Mistral:** de tre kuraterte id-ene står fortsatt på
  docs.mistral.ai/getting-started/models (id-ene grepet ut av siden
  ordrett), ingen nyere generasjon.
- **Groq:** `openai/gpt-oss-120b`/`-20b` fortsatt Production-tier.
- `npm run check:models` (keyless): ingen statisk drift; OpenRouter-probe
  458 modeller, alle felt intakte.

Review 2026-10-05 (manuell, på Emils melding om at Mistral-modellene måtte
oppdateres; kilder: appens egen cache av Mistrals /v1/models hentet med hans
nøkkel samme morgen (`modelCatalog.mistral` i pdfx-state.json, 46 id-er),
docs.mistral.ai/getting-started/models, /resources/changelogs,
/capabilities/reasoning og model-cards, pluss `npm run test:live --
--provider=mistral --model=…` mot tre kandidat-id-er):

- **Mistral — FEIL ID-FORMAT siden 12.8.2026, rettet.** De tre kuraterte
  id-ene (`mistral-medium-3-5-26-04`, `mistral-large-3-25-12`,
  `mistral-small-4-0-26-03`) var model-card-sidenes URL-slugs, ikke API-id-er.
  Mistrals API bruker navn + ÅÅMM: /v1/models lister `mistral-medium-2604`
  (+ `mistral-medium-latest`, `mistral-medium-3-5`, `mistral-medium-3.5`),
  `mistral-small-2603` (+ `mistral-small-latest`), `ministral-{3b,8b,14b}-2512`
  (+ `-latest`), `magistral-{small,medium}-latest` osv. Changelogen bekrefter
  formatet («We released Mistral Large 3 (mistral-large-2512) and Ministral 3
  (ministral-3b-2512, …)»). Alle tidligere reviews «grep'et id-ene ordrett
  ut av siden» — og fikk slugs; menyen hadde dermed aldri en Mistral-modell
  som svarte. Lærdom for neste review: en id er verifisert når den står i
  leverandørens /v1/models eller i en changelog/kodesnutt, ikke når den står
  i en URL.
- **Large 3 ut av menyen.** `mistral-large-2512` finnes, men live-testen
  svarte 403 `tier_not_allowed` («This model is not available in your
  subscription tier»), og den mangler i eierens /v1/models — listen er altså
  filtrert per abonnementsnivå, og ⚠-markøren vår («trolig pensjonert») ville
  vært misvisende for den. Mistrals egen deprecation-tabell peker dessuten
  Large 2.1-brukere til Medium 3.5 som etterfølger. Medium 3.5 får
  «Anbefalt»-hinten (ingen standardmodell for Mistral, `DEFAULT_AI_MODELS`
  urørt).
- **Large 3 testet på nytt etter pay-as-you-go, fortsatt UT.** Tilgangen var
  problemet i første runde (kontoens nivå), ikke modellen: etter aktivering
  svarte den på dokumentspørsmål med sitat. Men bildesjekken feilet: den
  kaller et ensfarget rødt 64×64-kvadrat «Hvitt» (5 av 6 direkte kall, to
  forskjellige prompter, uten `reasoning_effort` som den avviser med 400
  kode 3051). Medium 3.5 og Ministral 3 14B svarer «Rød» hver gang. Siden
  bilder er førsteklasses input i assistenten og Medium 3.5 slår den på
  akkurat det, er Large 3 dominert og kommer ikke inn; Mistrals chatbot
  sier alle modeller er åpne på pay-as-you-go, men det er en påstand, ikke
  en verifisering. Sjekk bildelesing på nytt hvis Mistral ruller ut en ny
  Large-versjon.
- **Reasoning:** docs.mistral.ai/capabilities/reasoning dokumenterer
  `reasoning_effort` med NØYAKTIG to verdier for Mistral-modellene, `high` og
  `none` (low/medium/max finnes bare for GLM 5.3), og at reasoning er AV som
  standard. Ny `MISTRAL_REASONING_RE` i ai-provider-profile.ts: Lav/Middels/
  Høy → `high`, Av → `none`; Large 3 og alt annet uten parameter som før.
  Med reasoning på kommer `delta.content` som en LISTE av chunks
  (`{type:"thinking", thinking:[{type:"text",text}]}` → `{type:"text",text}`
  → vanlige strenger); parseren i `chatOpenAiCompatible` skilte ikke på det
  og ville ha vist «[object Object]». Rettet (tekst-chunks → svar,
  thinking-chunks → liveness), testet i `test:ai-chat`.
- **Live-verifisert samme dag** (`npm run test:live -- --provider=mistral
  --record`, etter at nøkkelen ble «Live» i Mistrals konsoll — de to første
  forsøkene fikk 429 «Rate limit exceeded» på en nøkkel som ennå ikke var
  aktivert, og appen navnga det riktig som `ai-rate-limited`): Medium 3.5
  7/7 (svar på 2,6 s, sitat, dokument brukt, én forespørsel, thinking som
  liveness, bildet lest: «Rød. (Bildet er ensfarget rødt.)»). Small 4 6/7 —
  alt likt, men bildet IKKE sett under `high`. En direkte sonde (to
  forespørsler, nøytral systemprompt) viste at Small 4 svarer «Rød.» med
  `reasoning_effort: "none"` og «Jeg kan ikke se bildet» med `"high"`:
  reasoning-modus gjør den blind. Kodet inn som
  `MISTRAL_BLIND_WHEN_REASONING_RE` (ai-provider-profile.ts): en forespørsel
  med bilde går til Small 4 med `none` uansett tenkenivå; Medium 3.5 er
  upåvirket. Udokumentert hos Mistral — sondér på nytt ved neste review.
- **Small 4 likevel UT, Ministral 3 14B INN.** Med `none` tvunget på
  bildeforespørsler svarte Small 4 fortsatt feil i test:live («Dokumentet er
  blankt, så det er umulig å avgjøre fargen») — sonden med samme systemprompt
  gir det samme, så det er modellen som leser et rødt kvadrat som «blankt
  dokument» når prompten handler om et vedlagt dokument. En kuratert modell
  som feiler release-porten hver kjøring er støy vi ikke vil ha; ut etter
  kuratert-kun-regelen. Rask-setet gikk til `ministral-14b-2512` (Ministral 3
  14B, Apache 2.0, «text & vision» på docs-oversikten): test:live 7/7, svar på
  1,1 s, bildet lest «Rød.», ingen reasoning-parameter sendt (ikke
  dokumentert for Ministral). Kortet oppgir 256k kontekst og $0.2/$0.2 per
  MTok (lest 5.10.2026) → `MODEL_CONTEXT_TOKENS`. Seks opptak ligger nå i
  `scripts/fixtures/streams/mistral-*` og replayes av `test:streams`.
- Funn utenfor denne runden: 403 `tier_not_allowed` kommer i dag som en
  unavngitt feil (rå HTTP-tekst); en egen kode à la `ai-no-credit` ville vært
  mer i tråd med named-failures-regelen. Ikke gjort her.
- Anthropic, OpenAI, Gemini, xAI og Groq: ikke gjennomgått denne runden
  (utenfor spørsmålet).

Ukentlig review 2026-10-05 (platform.claude.com/docs/en/models/overview,
developers.openai.com/api/docs/models, ai.google.dev/gemini-api/docs/models,
docs.x.ai/developers/models og /developers/models/grok-4.20-0309-reasoning,
console.groq.com/docs/models og /docs/deprecations, alle sjekket samme dag —
dekker Anthropic/OpenAI/Gemini/xAI/Groq, som Mistral-runden over hoppet over):

- **Anthropic — DRIFT:** Sonnet 5.5 erstatter Sonnet 5 (se § Anthropic,
  review 2026-10-05, over). Fable 5.1/Opus 5.5/Haiku 4.5 uendret.
- **OpenAI — DRIFT:** GPT-6.1 Sol lagt til som NYTT mellomsjikt, ikke en
  erstatning (se § OpenAI, review 2026-10-05, over). Astra, 6 Sol, 6 Luna og
  5.6 Terra uendret.
- **Gemini:** `gemini-3.1-pro-preview` (fortsatt Preview), `gemini-3.8-flash`
  og `gemini-3.5-flash-lite` uendret — modellsiden bekrefter 3.8 Flash nå
  eksplisitt «stable» (ikke lenger nylig byttet inn). Nytt sett, ikke
  relevant: Gemini 3.8 Live (tale), Gemini 3.8 Flash TTS og Gemini 3.5
  Transcribe (alle tale/lyd-modeller, svarer ikke i tekst — utenfor
  kuratert-regel #2). Ingen «Gemini 3.5 Pro»-GA observert fortsatt.
- **xAI:** `grok-4.7`/`grok-4.3` uendret. Grok 4.20 fortsatt IKKE lagt til.
  **Gjensjekket 5.10.2026** (docs.x.ai/developers/models/grok-4.20-0309-reasoning):
  siden bekrefter nå eksplisitt «Modalities: text, image → text» for
  `-0309-reasoning` selv (kuratert-regel #2 ville vært innfridd), men
  dokumenterer fortsatt INGEN `reasoning_effort` for akkurat den id-en — og
  modell-aliaslisten viser fortsatt beta/experimental-varianter
  (`grok-4.20-beta-0309-reasoning`, `grok-4.20-experimental-beta-0304-reasoning`,
  `grok-4.20-experimental-beta-latest`) ved siden av de «rene» id-ene, samme
  tvetydighet som 31.8/7.9-rundene. Ingen fremgang på det åpne spørsmålet;
  fortsatt utenfor kuratert-kun-regelen av samme grunn som før.
- **Groq:** `openai/gpt-oss-120b`/`-20b` uendret, fortsatt Production-tier,
  `reasoning_effort` low/medium/high fortsatt bekreftet. Llama-paret
  (`llama-3.1-8b-instant`, `llama-3.3-70b-versatile`) står fortsatt oppført
  som «deprecated 16.8.2026» på /docs/deprecations — en separat
  modell-oversikt-side viste dem kortvarig uten det merket i denne runden,
  men deprecations-siden (den autoritative kilden for pensjonering) er
  uendret, og ingen av dem er i vår kuraterte liste uansett. Ingen
  kodeendring.
- `npm run check:models` (keyless): ingen statisk drift; OpenRouter-probe
  465–466 modeller (to kjøringer samme dag), alle felt
  (`input_modalities`/`output_modalities`/`created`/`pricing.completion`)
  intakte.

## Standardmodeller og fallback (Emil, 27.9.2026)

- **Standard:** `claude-opus-5-5` for Anthropic og `gpt-6-sol` for OpenAI
  (`DEFAULT_AI_MODELS` i `src/shared/defaults.ts`, speilet i `DEFAULT_MODELS`
  i `ai-models.ts`). Gjelder bare brukere uten lagret modell — et lagret valg
  står. «Anbefalt»-hinten følger standarden; Sonnet 5 (nå Sonnet 5.5, se
  under) fikk den nye `ai.modelHintValue` («Raskere og rimeligere, fortsatt
  sterk»), som er faktisk: Anthropic oppgir Fast mot Moderate latens og
  $2/$10 mot $4/$20. **Urørt av denne runden** — GPT-6.1 Sol kom inn
  2026-10-05 som et nytt mellomsjikt, ikke standarden (se § OpenAI).
- **Server-side fallback gjelder nå Opus 5, 5.5 og Sonnet 5.5 i tillegg til
  Fable** (`hasClassifiers` = `/fable|mythos|opus-5|sonnet-5-5/` i
  `chatAnthropic`; Opus-delen Emils valg 27.9.2026, Sonnet 5.5 lagt til
  2026-10-05 etter at Anthropics egen dokumentasjon bekreftet
  klassifikatorer for den også — se § Anthropic, review 2026-10-05).
  Refusals-siden (platform.claude.com/docs/en/build-with-claude/refusals-and-fallback)
  sier at Fable 5.1, Fable 5, Opus 5.5, Opus 5 og Sonnet 5.5 alle har
  sikkerhetsklassifikatorer som kan avslå med `stop_reason: "refusal"`, og
  at `fallbacks: "default"` + `server-side-fallback-2026-07-01` virker for
  dem. Begrunnelse: Opus 5.5 kjører en biologi-klassifikator i tillegg til
  cyber, og et avslag på et spørsmål om en biologi-artikkel gir leseren
  ingenting, mens fallback gir svar fra modellen Anthropic anbefaler for den
  kategorien. En kategori uten anbefalt fallback ender fortsatt i avslaget.
  Sonnet 5 (IKKE 5.5) og Haiku 4.5 har ingen klassifikatorer og får ingen
  fallback.
- **Svaret sier hvem som svarte.** Et svar fra fallback-modellen bærer en
  `fallback`-innholdsblokk (`{from:{model}, to:{model}}`, «What the response
  contains» på samme side); `chatAnthropic` leser `to.model` fra siste blokk
  og returnerer den som `fallbackModel`. Den leses fra blokken og ikke fra
  `final.model`, fordi `message_start` fortsatt navngir den valgte modellen
  ved et avslag midt i strømmen. Panelet og markeringsboblen viser «Besvart
  av {modell}» (`FallbackChip.tsx`), ellers ville menyvalget ikke holdt i
  det stille. Ved avslag midt i strømmen fortsetter fallback-modellen fra den
  delvise teksten («nothing you have already received is invalidated»), så
  teksten vises sammenhengende uten opprydding.
- **Fortsettelse etter en pause (pause_turn) etter et bytte:** den
  avslående modellens thinking/redacted_thinking/connector_text før SISTE
  `fallback`-blokk må ut av det vi sender tilbake, mens selve blokken skal stå
  på samme plass («Continuing the conversation» på samme side). Løkken sendte
  alt uendret — en 400 midt i svaret, latent for Fable siden fallback kom inn,
  og nå også for Opus. `echoPausedTurn` i `ai-chat.ts` filtrerer etter
  tabellen der; testet i `test:ai-chat`.
- Verifisert i `npm run test:ai-chat` (fallback-forespørsel for Opus 5/5.5 og
  Sonnet 5.5, ingen for Sonnet 5, `fallbackModel` fra overleveringsblokken).
  **Et ekte avslag er ikke fremprovosert** — det krever et innhold
  klassifikatoren slår ut på.

## Anbefalt mapping «Tenkeinnsats» (Av/Lav/Middels/Høy)

| Valg | Opus 5 / Sonnet 5 | Fable 5 / 5.1, Opus 5.5 | Sonnet 5.5 | Haiku 4.5 | gpt-5.6, GPT-6 Sol/Luna | GPT-6 Astra, GPT-6.1 Sol, grok 4.5–4.7, gpt-oss | Mistral Medium 3.5 / Small 4 |
|---|---|---|---|---|---|---|---|
| Av | `{type:"disabled"}` | umulig (→ effort low) | `{type:"between_tools"}` | utelat | `none` | umulig (→ `low`) | `none` |
| Lav/Middels/Høy | `adaptive` + effort low/medium/high | effort low/medium/high | `adaptive` + effort low/medium/high | ikke støttet (utelat) | low/medium/high | low/medium/high | `high` (eneste på-verdi) |

Defaults: anthropic `claude-opus-5-5` + Middels; openai `gpt-6-sol` + medium
(fra 27.9.2026; var `claude-sonnet-5` og `gpt-5.6-terra`).
Heuristikk: effort kun når id ikke matcher `haiku` (fallback i `anthropicTraits`
skiller ikke videre på Opus/Sonnet/Fable-generasjon — «alwaysThinks» slår bare
inn for `fable|mythos|opus-5-5`, og explicit-off for `sonnet-[5-9]|opus-[5-9]`,
som Sonnet 5.5 også treffer; den AV-mekanismen («disabled» vs «between_tools»)
avgjøres separat av en egen `betweenToolsOff`-sjekk, `/sonnet-5-5/i`); Haiku
alltid uten thinking. OpenAI-stil: `reasoning_effort` sendes for
`OPENAI_REASONING_RE` (`gpt-[5-9]|o[0-9]|grok-4.[5-7]|gpt-oss`), og «Av» blir
`low` i stedet for `none` for `OPENAI_ALWAYS_REASONS_RE`
(`gpt-6-astra|gpt-6\.1-sol|grok-4.[5-7]|gpt-oss`). Mistral: `MISTRAL_REASONING_RE`
(`mistral-medium-2604`/`-3.5`/`-latest`, `mistral-small-2603`/`-latest`)
sender `high` for alle på-nivåer og `none` for «Av» — Mistral dokumenterer
bare de to verdiene (5.10.2026).
