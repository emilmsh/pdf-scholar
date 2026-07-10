# KI i PDF Scholar — forslag til diskusjon

> Status: **UTKAST til diskusjon med Emil** — ingenting her er implementert eller besluttet.
> Posisjonering: appen er for «scholars» — folk som leser og arbeider dypt med forskningsartikler
> og rapporter. KI-funksjonene skal styrke *lesing, forståelse og læring* — ikke kontor-automatisering.

## Prinsipper

1. **Egen API-nøkkel (BYO-key).** Brukeren betaler sin egen KI-bruk direkte til leverandøren. Ingen server hos oss, ingen abonnement, full kostnadskontroll.
2. **Grounding er hellig.** Hvert KI-utsagn om dokumentet skal kunne klikkes → hopp til nøyaktig sted i PDF-en med markering. En scholar stoler ikke på påstander uten kilde — appen skal aldri be dem om det.
3. **KI forstyrrer aldri lesingen.** Panelet er valgfritt, lukkbart, og distraksjonsfri modus skjuler det. Ingen KI-knapper i selve lesefeltet.
4. **Dokumentet forlater maskinen kun når brukeren ber om det** (dvs. når de stiller et spørsmål). Tydelig førstegangsforklaring.

## Foreslått funksjonsliste (til prioritering)

### Nivå 1 — Grunnmuren (foreslått første leveranse)

| # | Funksjon | Beskrivelse |
|---|----------|-------------|
| 1 | **Chat med dokumentet** | Sidepanel til høyre (som sidebar, men høyre side). Strømmende svar. **Hvert utsagn får klikkbare kildechips «s. 12»** som hopper til og markerer den eksakte passasjen svaret bygger på. Oppfølgingsspørsmål med samtaleminne. |
| 2 | **Forklar utvalg** | Kontekstmenyen (som allerede har Nettsøk/Ordbok/Oversett) får KI-handlinger: **Forklar**, **Forenkle**, **Definer i kontekst**, **Oversett (KI)**. Svar i lite popover med «fortsett i chat»-knapp. |
| 3 | **API-nøkkel + innstillinger** | Innstillingsside: lim inn nøkkel (kryptert med Windows-nøkkellager via Electron safeStorage), velg modell, se estimert kostnad per svar og løpende forbruk. |

### Nivå 2 — Scholar-verktøyene (det som skiller oss fra «chat with PDF»-mengden)

| # | Funksjon | Beskrivelse |
|---|----------|-------------|
| 4 | **Strukturert artikkelsammendrag** | Én knapp → forskningsspørsmål, metode/identifikasjonsstrategi, data, funn, bidrag, begrensninger — hvert punkt med kildechip. Skreddersydd for empiriske artikler (økonomi/samfunnsfag først). |
| 5 | **Referanseoppslag** | Klikk på en sitering i teksten («(Williamson, 1968)») → KI forklarer hva det refererte arbeidet er, hvorfor det siteres her, og hva det betyr for argumentet — basert på referanselisten i PDF-en (+ valgfritt nettsøk). |
| 6 | **Spør annotasjonene dine** | «Oppsummer det jeg har markert», «hvilke svakheter noterte jeg?» — bygger direkte på annotasjonsuttrekket vi allerede har (markert tekst + kommentarer). Kobler KI til Emils faktiske arbeidsflyt: les → annotér → syntetiser. |
| 7 | **Begrepshjelp** | Automatisk ordliste for dokumentet: faguttrykk med definisjon slik de brukes *i dette dokumentet*, med kildechips. |

### Nivå 3 — Senere (parkeres til 1–2 er i bruk)

| # | Funksjon | Beskrivelse |
|---|----------|-------------|
| 8 | **Kryssdokument-spørsmål** | Spør på tvers av åpne faner eller en mappe («hva sier disse tre artiklene om X?»). |
| 9 | **Forhør meg** | Quiz/leseforståelse for læring («test meg på kapittel 3»). Passer læringsposisjoneringen. |
| 10 | **Metodekritikk-modus** | «Stress-test artikkelen»: trusler mot identifikasjon, alternative forklaringer, hva ville en referee spurt om. |
| 11 | **Forklar figur/tabell** | Send sidebilde av figuren → forklaring. (Krever bildekontekst; trinn to av chat.) |

## Teknisk skisse (kortversjon)

- **SDK i hovedprosessen.** `@anthropic-ai/sdk` (TypeScript) kjører i Electron-main; nøkkelen når aldri renderer-prosessen. Strømming videresendes over IPC (samme mønster som annoteringsmotoren).
- **Grounding via Citations-API-et.** Vi sender dokumentet som tekst (vi har allerede sidevis tekstuttrekk fra søkefunksjonen) med `citations: {enabled: true}`. Svaret kommer tilbake oppdelt med `char_location`-referanser (start-/sluttposisjon i teksten) → disse mapper vi til eksakte rektangler med **nøyaktig samme maskineri som søket bruker i dag** (`resolveMatchRects`) → klikk på kildechip = hopp + markering, ned på setningsnivå. For skannede/figurtunge PDF-er: send selve PDF-en (base64) i stedet → `page_location` (sidenivå-presisjon).
- **Prompt caching.** Dokumentblokken caches (`cache_control`) → første spørsmål betaler full pris, oppfølgingsspørsmål koster ~10 % for dokumentdelen. Viktig for chat-økonomien.
- **Kostnadstransparens.** `usage`-feltet i hvert svar × prisliste → «dette svaret kostet ca. $0.04» + løpende sum. Token-telling via `count_tokens` før store dokumenter sendes.
- **Modellvalg.** Standard: `claude-opus-4-8` (kvalitet); «rask/billig»-valg: `claude-haiku-4-5`. Dropdown i innstillinger.
- **Grenser.** Typisk artikkel (30 sider ≈ 20–40k tokens) er langt innenfor kontekstvinduet (1M). Ingen RAG/embeddings nødvendig for enkeltdokumenter — hele teksten sendes. Kryssdokument (nivå 3) revurderer dette.

## Læring fra KI-intervjuappen (oe-intervju)

Kartlagt 2026-07-10. Deres arkitektur er React + FastAPI-backend mot **Azure OpenAI** (rå REST, ingen SDK), nøkkel som server-miljøvariabel — altså en server-app, ikke BYO-nøkkel. Det vi låner og det vi gjør annerledes:

**Låner:**
- **Kildeblokk-mønsteret**: dokumentkonteksten legges som en stabil blokk tidlig i meldingslisten (byte-identisk mellom kall) → prompt caching virker. Historikk = siste ~20 meldinger.
- **Token-måler**: estimert kontekststørrelse med grønn/gul/rød-indikator, advarsel ved 80 % av kontekstvinduet.
- **Retry/fallback**: ett gjenforsøk på transiente feil (429/5xx/timeout), deretter fallback til billigere modell; aldri mer enn én samtidig storjobb.
- **Optimistisk brukerboble + «Skriver …»**-tilstand; feil som avvisbart kort, ikke modal.
- **Auto-navngiving av samtaletråder** (billig minimal-kall etter første spørsmål).
- Deres `QUOTE_GROUNDING_RULES`-prompt (siteringskontrakt med ordrette sitater) — som **fallback-mønster** hvis vi senere støtter leverandører uten innebygd siteringsstøtte.

**Gjør annerledes:**
- **Ekte strømming** (de blokkerer og venter) — SDK-streaming over IPC gir svar-mens-du-leser.
- **Innebygde siteringer** (Claude Citations API) i stedet for håndrullet prompt-kontrakt — API-garantert at sitatet finnes i kilden, med posisjoner vi kan hoppe til.
- **BYO-nøkkel kryptert lokalt** (safeStorage) i stedet for server-nøkkel — ingen backend i det hele tatt.
- RAG/embeddings droppes helt for enkeltdokumenter (de trenger det for store intervjukorpus; en artikkel er liten).

## Kostnadsbilde (omtrentlig, Opus 4.8: $5/M inn, $25/M ut)

- Første spørsmål til en 30-siders artikkel: ~30k tokens inn + ~1k ut ≈ **$0.18** (+cache-skriving)
- Oppfølgingsspørsmål (dokument cachet): ≈ **$0.03–0.05**
- Med Haiku 4.5 ($1/$5): ~1/5 av dette.

## Konkurrentbildet (kartlagt 2026-07-10)

- **Grunnet sitering er dét brukerne roser** på tvers av verktøyene (Acrobat AI Assistant, Humata, NotebookLM, ChatPDF, ReadCube): «klikk på kilden → hopp til eksakt sted». Generiske sammendrag uten kildekobling får gimmick-stempel. → Prinsipp 2 (grounding) er riktig satsing.
- **Åpent rom:** «klikk på en litteraturreferanse → KI forklarer det refererte verket» gjøres i praksis ikke av noen i dag (nærmest: Semantic Readers TLDR-kort, uten LLM-dybde). **Ingen Windows-desktopleser tilbyr dette** — nivå 2-funksjonen «Referanseoppslag» er vår tydeligste differensiator.
- **BYO-nøkkel-presedens** finnes (Zotero-plugins, KOReader-plugin) men ingen polert Windows-app — også et rom.
- Elicit/SciSpace løser kryssdokument-oversikter (nivå 3 hos oss) — ikke vår kamp nå.

## Navn: «PDF Scholar» — teknisk ledig, men risikabelt

Sjekket 2026-07-10: **Ingen produkter heter eksakt «PDF Scholar»** (kun ett dødt hobbyrepo på GitHub). MEN:
- **Google Scholar PDF Reader** er en svært utbredt utvidelse fra Google — «Scholar + PDF» er i praksis Googles assosiasjonsrom, med forvekslingsfare og SEO-usynlighet.
- «Scholar»-rommet er trangt: Scholarly, Scholaread, Scholarcy, AI Scholar, ScholarPhi finnes alle.

**Alternativer som ser ledige ut:** PaperGlass, PaperPane, RefLens. Beslutningen er Emils — arbeidstittelen PDFX fungerer inntil videre.

**Designretning:** PDF Expert-roen i bunn + «scholarly» egenart — f.eks. akademisk typografi i KI-panelet, sitatkort med kildechips, dempet «lærd» aksent. Konkretiseres når navnet er valgt.

## Åpne spørsmål til Emil

1. Hvilke nivå 1/2-funksjoner er viktigst? Foreslått rekkefølge: 1 → 3 → 2 → 4 → 6, med **5 (referanseoppslag)** løftet frem som differensiator kort etter.
2. Kun Anthropic/Claude først (innebygde siteringer = grounding-garantien), eller multi-leverandør (OpenAI/Azure) fra start? Anbefaling: Claude først, men med leverandør-abstraksjon i koden fra dag én; OpenAI-støtte kan da legges til senere med oe-intervju-appens prompt-baserte siteringskontrakt som fallback.
3. Skal «Forklar utvalg» svare i popover (raskt) eller alltid gå via chatpanelet?
4. Navnebeslutning: PDF Scholar (ledig men risikabelt) vs. PaperGlass / PaperPane / RefLens vs. beholde PDFX inntil videre.
