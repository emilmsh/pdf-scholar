# PDFX — Veikart

Mål: en poliert, moderne PDF-leser og -annotator for Windows, med et informasjonsarkitektur og verktøysett som holder mål mot bransjens beste lesere. Hver fase skal gi en brukbar app. Detaljert funksjonsspesifikasjon: [docs/SPEC.md](docs/SPEC.md).

**Arkitektur (besluttet 2026-07-09, skrivemotoren byttet 2026-07-16):** Electron + electron-vite + React + TypeScript. pdf.js (pdfjs-dist v6) er **lesemotoren** (rendering, tekstlag, søk, TOC). **EmbedPDF (@embedpdf/pdfium + @embedpdf/engines, MIT/BSD-3) er annoteringsmotoren** — den skriver standard PDF-annotasjoner med appearance streams bak et typet `AnnotationEngine`-grensesnitt i hovedprosessen (`src/main/annotation-engine-embedpdf.ts`), og repoet er omlisensiert til MIT. Annotasjoner tegnes av vårt eget React-overlegg — vi bruker ikke pdf.js sitt redigeringslag (det mangler underline/strikeout/notater og har kjente feil). Dette er samme arkitektur som Zotero/Okular. *Erstattet:* mupdf (offisiell WASM, npm) var den opprinnelige skrivemotoren, og fordi den er AGPL sto distribusjonsspørsmålet åpent til fase 8-porten. Den er nå degradert til devDependency og brukes bare som uavhengig verifikator i `npm run test:engine`/`bench:engine` — den følger ikke med i release-bygg og skal aldri importeres fra `src/`.

## Fase 1 — Skjelett + minimal leser ✅ (påbegynt 2026-07-09, kjernen ferdig)
- [x] Electron + React + TS-oppsett med typesjekk og produksjonsbygg
- [x] pdf.js-rendering med virtualisert kontinuerlig rulling, tekstlag (markering), zoom (Ctrl+hjul/pinch, tilpass bredde)
- [x] Husker siste leseposisjon + zoom per fil; nylige filer; tema lagres
- [x] Åpning via kommandolinje/«Åpne med» (argv), single-instance med `second-instance`-ruting
- [x] Vindusstørrelse/-posisjon huskes; dra-og-slipp av PDF
- [x] Lesemodus: Dag/Sepia/Natt + distraksjonsfri modus (verktøylinjen skjules, vises ved å peke mot toppen, Esc avslutter)
- [x] Myk zoom: pinch/Ctrl+hjul som CSS-transform under gesten, skarp gjentegning ved ro, fokuspunkt bevares; canvas-bytte uten hvit blink; horisontal panorering ved zoom (levert 2026-07-09)
- [x] Fullskjerm via F11/knapp/Esc (levert 2026-07-09)
- [x] electron-builder NSIS-installer med `fileAssociations` for .pdf (per-bruker, uten admin; «Åpne med»-oppføring, kaprer ikke standardapp) + app-ikon (levert 2026-07-10 — `npm run dist` → `release/PDFX-Setup-*.exe`)
- [x] Jump List («Recent»-kategori) i oppgavelinjen + AppUserModelId (levert 2026-07-10)

## Fase 2 — Leseopplevelse + temaer (Emils prioritet nr. 1)
- [x] Justerbar **kontrast** og **lysstyrke** per lesemodus (glidere i «aA»-panelet, lagres per tema); Auto-tema som følger Windows (levert 2026-07-09)
- [x] Hold skjermen våken (powerSaveBlocker) (levert 2026-07-09)
- [x] Flytende sidetall-pille nede til høyre i distraksjonsfri modus (klikk = gå til side) (levert 2026-07-09)
- [x] Venstre sidepanel med Miniatyrer + Innholdsfortegnelse (TOC); klikk for å hoppe (levert 2026-07-09)
- [x] To-siders oppslag: knapp i verktøylinjen, radlayout i `src/renderer/src/rotation.ts`, leseposisjonen re-ankres over relayouten; sidene parres strengt (1-2, 3-4) — «forside alene» er ikke med (levert 2026-07-15)
- [ ] «aA»-panel: rulleretning (vertikal kontinuerlig / horisontal én-side)
- [ ] Beskjær marger
- Merk: «klikk midt på siden skjuler alt» er en iPad-gest; på desktop bruker vi knapp/F11 + pek-mot-toppen for å hente verktøylinjen (bevisst tilpasning)

## Fase 3 — Navigasjonsdybde + søk
- [x] Navigasjonshistorikk: «Tilbake til s. N»-pille etter alle hopp (lenker, TOC, miniatyrer, gå-til-side); full tilbake-stakk (levert 2026-07-09)
- [x] Frem-navigasjon: Alt+← / Alt+→, frem/tilbake-knapper i verktøylinjen og «Frem til s. N»-pille (levert 2026-07-09)
- [x] Pinch-zoom snapper til tilpass-bredde/-høyde/-side når man slipper nær (levert 2026-07-09)
- [x] Navigasjonspillene fader ut etter dødtid; våkner ved navigering eller hover i hjørnet (levert 2026-07-10)
- [x] Dokumenter åpnes med hele første side synlig (fit-page, sentrert — ikke avkuttet vertikalt); lagret posisjon/zoom overstyrer (levert 2026-07-10)
- [x] Klikkbare hyperlenker i dokumentet: interne mål med presis Y-posisjon, eksterne åpnes i nettleser (levert 2026-07-09)
- [x] Kontekstmeny ved tekstmarkering v1: Kopier, Nettsøk, Ordbok, Oversett (levert 2026-07-09)
- [x] Søkelinje (Ctrl+F): skill store/små bokstaver, hele ord (æøå-sikker), resultatliste med utdrag, treffmarkering på siden, F3/Shift+F3, søkehopp gir tilbake-pille (levert 2026-07-09)
- [x] Marker alle treff samtidig (dempet bakgrunnsmarkering bak det aktive treffet, løst per montert side) + søkehistorikk med «tøm» (siste 10, pil-navigasjon; levert 2026-07-29)
- [x] **Bokmerker-fane** (levert 2026-07-29) — fjerde sidepanelfane: bokmerk gjeldende side med B eller knappen, gi navn inline, klikk hopper (med tilbake-pille), lagres per fil ved siden av leseposisjonen på alle tre plattformene. Drag-omorganisering utgår: listen sorteres etter sidetall

## Fase 4 — Annoteringsfundament (Emils prioritet nr. 2)
Grunnmuren levert 2026-07-09: mupdf `AnnotationEngine` skriver Highlight (5 farger)/Underline/StrikeOut/Squiggly/notater som standard PDF-annotasjoner med appearance streams, inkrementell lagring og atomisk filbytte.
- [x] Eksisterende annotasjoner leses inn ved åpning (enumerert via pdf.js) og er klikkbare
- [x] Klikk/høyreklikk på annotasjon → egenskaper-popover: bytt farge, rediger notattekst, slett — også annotasjoner fra andre apper (motoren adresserer via PDF-objektnummer; rundtur verifisert)
- [x] Squiggly (bølgestrek) i kontekstmenyen
- [x] Merknader-fane i sidepanelet: alle annotasjoner gruppert per side med farge/tekst/forfatter; klikk hopper, hover-slett
- [x] Sømløs dokument-gjenåpning etter redigering (én pdf.js-worker per dokument)
- [x] Kommentar kan knyttes til ALLE annotasjonstyper via popoveren, ikke bare notater (levert 2026-07-09)
- [x] Angre/gjør om for annotasjoner: Ctrl+Z / Ctrl+Shift+Z (også Ctrl+Y) som inverterbare motoroperasjoner — fungerer også på tvers av dokument-gjenåpninger (levert 2026-07-09, opprinnelig fase 5-punkt)
- [x] «Armert verktøy»-flyt: tekstmarkeringsverktøyene armes fra verktøylinjen, merker utvalget ved museslipp og forblir aktive til neste utvalg (Esc slår av) (levert 2026-07-16)
- [x] Egendefinert fargevelger + opasitetskontroll: fargehjul bak «+» i markeringsmenyen som husker de sist valgte fargene (levert 2026-07-12), opasitetsglider per verktøy i verktøyvalgene (levert 2026-07-25)
- [x] **Interop-port**: PDFX-annoterte filer åpner med identisk visning i Edges innebygde viser — Emils manuelle test, godkjent som tilstrekkelig 2026-08-02 (Acrobat/SumatraPDF-matrisen utgår som krav; Edge er uansett interop-baren, jf. plattformparitetsregelen)

## Fase 5 — Fullt annoteringsverktøysett
- [x] Penn og gjennomskinnelig markeringstusj: frihåndstegning med coalesced pointer events, farge- og breddevalg per verktøy, skrives som standard Ink-annotasjoner (rundtur verifisert); Esc avslutter verktøyet (levert 2026-07-10)
- [x] Viskelær: sletter hele strøk med presis punkt-til-segment-trefftest; angrbart (levert 2026-07-10)
- [x] ~~Angre/gjør om som inverterbare motor-operasjoner; hurtigtaster~~ (levert 2026-07-09)
- [x] Former: rektangel, ellipse, linje og pil — dra for å tegne med live forhåndsvisning; farge/bredde-valg; skrives som Square/Circle/Line-annotasjoner (pil = Line med ClosedArrow-ende; rundtur verifisert) (levert 2026-07-10)
- [x] Fritekst på siden: klikk med tekstverktøyet → skriv → FreeText-annotasjon med riktig DA (tekstfarge, Helv 12) (levert 2026-07-10)
- [ ] Trykkfølsom penn (krever polygon-appearance i stedet for enkel Ink-bredde — utsatt bevisst for interop)
- [ ] Lasso-multivalg for blekk
- [x] Flytt/endre størrelse på former og fritekst med håndtak (levert 2026-07-29) — hjørnehåndtak for firkant/ellipse/fritekst/blekk (blekket skalerer strekene), endepunkthåndtak for linje/pil, og **endene på en tekstmarkering kan dras** slik at en for kort utheving rettes i stedet for å slettes og tegnes på nytt (ordsnapping, `src/renderer/src/text-range.ts`). Krevde at `ModifyAnnotationRequest` tar ny geometri (`quads`/`strokes`) i begge skrivestier. Bevisste grenser: bare urotert visning, ingen resize av notatbobler
- [ ] Verktøysett-system i verktøylinjen (tilpassbare grupper)

## Fase 6 — Annotasjonspanel + eksport (Emils prioritet nr. 3)
- [x] Merknader-fane: liste gruppert per side; klikk for å hoppe; slett enkeltvis (levert med fase 4)
- [x] **Eksporter annotasjonssammendrag** som Markdown, HTML og ren tekst — inkluderer faktisk markert tekst (hentet via quad/tekst-geometri), kommentarer og forfatter, gruppert per side (levert 2026-07-09)
- [x] Markert tekst-utdrag i selve listen («utdrag» — kommentar som andrelinje) (levert 2026-07-10)
- [x] Søk i merknader + fargefilter (5 palettfarger, kombinerbart med søk) (levert 2026-07-10)
- [x] Tøm alle med bekreftelse (levert 2026-07-29) — én angrehandling: ny `batch`-variant i undo-stakken, én reload og én samletoast for hele operasjonen
- [ ] «Annoterte sider»: ny PDF med kun sider som har annotasjoner

## Fase 6.5 — Faner (Emil ønsker dette tidlig, trukket frem fra fase 7)
- [x] Fanelinje for flere åpne dokumenter: klikk/klikk-på-✕/midtklikk lukker, + åpner, Ctrl+Tab / Ctrl+Shift+Tab veksler, Ctrl+W lukker, Ctrl+O åpner; bakgrunnsfaner beholder full tilstand (scroll, zoom, angre-stakk) og leseposisjon lagres ved fanebytte (levert 2026-07-10)
- [x] Dra faner for å endre rekkefølge; «lukk andre faner»-meny (levert 2026-07-29) — dra bytter plass live i linja (ingen protokollendring: main svarte allerede `'same'` når slippet skjer i eget vindu), meny med «Lukk andre faner»/«Lukk faner til høyre» som spør om én fane om gangen, og «Flytt til venstre/høyre» + Ctrl+Shift+PageUp/PageDown for berøring og tastatur

## Fase 7 — Skall-paritet og polering
- [x] **Språkvalg i appen: norsk bokmål og engelsk** (Emils ønske 2026-07-11, levert samme dag) — alle UI-strenger i `src/renderer/src/i18n.ts` med `t()`-oppslag, velger i aA-menyen (Norsk/English/Auto der auto følger OS-språket), gjelder også KI-systemprompter, eksportdokumenter og datoformat. Nye strenger SKAL inn i begge ordbøkene.
- [x] Høytlesing (Emils valg fra Edge-vurderingen, levert 2026-07-12): setningsvis TTS via SpeechSynthesis med markering som følger og auto-scroll, spill/pause/stopp, hastighet og stemmevalg. **Skjult bak `READ_ALOUD`-flagget på alle plattformer siden 2026-07-20** (`src/renderer/src/flags.ts`): Chromium på Windows eksponerer bare de gamle SAPI5-stemmene for `speechSynthesis`, og de er for robotiske å sende ut — funksjonen venter på en lokal nevral TTS (Piper e.l.), og skjules på alle plattformer for paritet selv om Edges stemmer er brukbare i utvidelsen
- [x] Skriv ut (levert 2026-07-12): skjult vindu med Chromiums PDF-viser + systemets utskriftsdialog
- [x] **Nettleserutvidelse** (Emils idé 2026-07-09, levert 2026-07-15) — PDFX som PDF-visnings-erstatning i Edge/Chrome (MV3): samme renderer via `bridge.ts`, en tredje `PdfxApi`-plattform, File System Access for lagring i fila og egen KI-implementasjon i visnings-siden. Se `docs/BROWSER-EXTENSION.md` og paritetskontrakten i `docs/PLATFORMS.md`
- [x] **Roter sider** (Emils bestilling 2026-07-12, levert 2026-07-15) — visningsrotasjon i 90°-steg (Shift+R / `]` / `[`), koordinatmapping i alle overlegg (`src/renderer/src/rotation.ts`, dekket av `npm run test:rotation`); tegneverktøyene slås av mens siden er rotert i stedet for å inverteres
- [x] **Tosiders visning** (Emils bestilling 2026-07-12, levert 2026-07-15) — layoutmotoren bygger rader, én eller to sider per rad; parringen er streng (1-2, 3-4), «forside alene» gjenstår
- Fanelinje for flere dokumenter; delt visning
- Stempler, signatur, verktøylinje-tilpasning
- Designgjennomgang: avstander, ikoner, animasjoner, mørkt app-chrome

## Fase 9 — KI-assistent («PDF Scholar»-retningen; plan i docs/AI-PLAN.md)
Besluttet med Emil 2026-07-10: prioritering 1→3→2→4→6 (deretter 5 referanseoppslag); fleksibel multi-leverandør fra start; forklar-utvalg som popover med «Send til chat»; **PDF Scholar som arbeidsnavn** (appen er PDF-leser først, KI-appene i Scholar-rommet er KI først — forvekslingsrisikoen er mindre relevant).
- [x] **Nivå 1 levert (2026-07-10):** chat-sidepanel med strømmende svar og klikkbare kildechips «s. N» (hopp + markering på setningsnivå via søkemaskineriet); Forklar/Forenkle/Definer i kontekstmenyen med popover + «Send til chat»; API-nøkkel kryptert med safeStorage (nøkkel forlater aldri main-prosessen); leverandører: Anthropic (innebygde Citations, prompt-caching), OpenAI + Azure (SSE + ordrett-sitat-kontrakt løst mot sideteksten), mock (offline test); tokenforbruk per svar (inn/ut), slik leverandøren selv rapporterer det
  - *Merk 2026-07-26:* kostnadsestimatet i kroner (per svar + løpende sum) er **fjernet** — en prisliste kompilert inn i appen blir feil så snart leverandøren endrer priser eller slipper en modell som treffer et gammelt mønster, og appen er ikke i faktureringsløyfa i det hele tatt. Det som står igjen er tokentallene leverandøren rapporterer, som ikke kan bli foreldet; nøkkelinnstillingene peker i stedet på leverandørens egen side for utgiftstak og faktisk forbruk. Ikke foreslå estimatet på nytt.
- [x] Strukturert artikkelsammendrag (levert 2026-07-11): knapp i panelets tomtilstand + toppfelt → forskningsspørsmål/metode/data/funn/bidrag/begrensninger med kildechips; går gjennom vanlig chat-løype (strømming + siteringer gratis); kompakt brukerboble skjuler instruks-stillaset; tilpasser seksjonene for ikke-empiriske dokumenter
- [x] Spør annotasjonene (levert 2026-07-11): ✦-knapp i Merknader-fanen + forslag i panelets tomtilstand (vises kun når dokumentet har merknader) → sender merknadsblokken (side/type/utdrag/kommentar fra eksportuttrekket) inn i chatten; blokken ligger i historikken så oppfølgingsspørsmål beholder den
- [x] Referanseoppslag (levert 2026-07-15) — differensiatoren: «Referanse» i markeringsmenyen («Hva er det som siteres her – og hvorfor?») slår opp den valgte siteringen og forklarer det refererte verket
- [ ] Begrepshjelp (ordliste slik begrepene brukes i dokumentet)
- [x] Skannede dokumenter kan leses (levert 2026-07-29) — appen sier først at dokumentet mangler tekstlag (varsel i panelet + egen status i KI-søket), og **leser sidene som bilder** når du ber om det: sidevelger over komponisten (fra/til, maks 4 om gangen — `MAX_IMAGES`), sidene rendres offscreen som JPEG ≤ 1400 px og stages som vedlegg med redigerbart spørsmål; brikken navngir sidene, og systemprompten sier at bare de vedlagte sidene er synlige og at modellen skal si det når svaret ville krevd andre. Det tomme dokumentet sløyfes i den saken. *Gjenstår:* page_location-siteringer (svaret viser til sidetall i prosa, ikke klikkbare sitater)
- [ ] Nivå 3 (parkert): kryssdokument, forhør-meg-quiz, metodekritikk-modus, forklar figur

## Fase 8 — Filhåndtering + sky (utgår for nå — Emils beslutning 2026-08-02)
Synkmapper (OneDrive/Dropbox) dekker skybehovet implisitt allerede, og hjemskjerm/innholdssøk tas ikke opp igjen før appen har fått modne i drift. Punktene under står som tankegods, ikke plan.
- Hjemskjerm: Nylige (20) + Favoritter med egendefinert rekkefølge og fargeetiketter
- Innholdssøk på tvers av filer i valgt mappe
- Sky: primært via synkmapper (OneDrive/Dropbox) + filovervåking; API-integrasjon bare hvis nødvendig
- **Beslutningsport for distribusjon**: mupdf AGPL-avklaring, kodesignering, auto-oppdatering
  - *AVGJORT 2026-07-16*: **EmbedPDF er eneste produksjonsmotor og repoet er omlisensiert til MIT.**
    Spike + produksjonstester bestått (alle 11 annotasjonstyper med appearance streams, objektnummer-
    kontrakt via EPDF-utvidelsene, obj# stabile gjennom `saveAsCopy`); interop bekreftet i praksis
    (redigerbar annotering i Edges PDF-leser). Skrivemotor: `src/main/annotation-engine-embedpdf.ts`
    med dokument-cache + debounced flush (`doc-cache.ts`, ~40× raskere burst-annotering). mupdf er
    degradert til devDependency (uavhengig verifikator i `npm run test:engine`/`bench:engine`) og
    følger ikke med i release-bygg. Store filer (≥150 MB) skrives av den inkrementelle appenderen
    (`src/main/incremental-appender.ts`, ren Node, ingen WASM — appends objekter + AP + xref direkte;
    verifisert av mupdf/EmbedPDF/pdf.js, 413 MB-fil annoteres på ~0,3–0,5 s). Under 150 MB: doc-cache
    med debounced flush. Test: `npm run test:appender`.

## Neste bolk — penn og nettbrett (retning valgt 2026-08-02)
Emil peker på Windows-nettbrett med penn (Surface-klassen) som neste satsing etter lanseringspausen. Kandidatene er eksisterende åpne punkter fra fasene over, samlet her:
- Beskjær marger (fase 2)
- Trykkfølsom penn (fase 5 — krever polygon-appearance for interop)
- Lasso-multivalg for blekk (fase 5)
- Stempler og signatur (fase 7)
- Begrepshjelp (fase 9)

Berøringsparitetsregelen gjelder hele bolken: hver mus/hover-interaksjon trenger en intuitiv berøringsekvivalent.

## Tankeboks (ikke planlagt, ikke glemt)
- **Zotero-integrasjon** (Emils notat 2026-07-12): vurdere kobling mot referanseverktøy — import av PDF-er fra Zotero-bibliotek, eksport av annoteringer/notater tilbake, evt. Better BibTeX-nøkler i referanseoppslaget.
- **Legg monetiseringsstrategi**: hvordan PDFX eventuelt kan tjene penger (lisens/kjøp/abonnement/gratis+pro — omfang avklares med Emil når det tas opp). (Emils ønske 2026-07-09.)

## Viktigste risikoer (med tiltak)
1. **Koordinat-mapping** pdf.js-viewport ↔ PDF-sideflate (y-flipp, rotasjon, cropbox) — én delt, enhetstestet transformmodul; overlegget måler quads i vår `PageRect`-flate, og EmbedPDFs modellflate er den samme (topp-venstre, y-ned, ingen flipp), mens den inkrementelle appenderen gjør flippen selv.
2. **Utseende på tvers av visere** — interop-testmatrise som fasekrav for hver annotasjonstype.
3. **To parsere** (pdf.js leser, EmbedPDF skriver) kan divergere — overlegget eier annotasjonspiksler, pdf.js lastes aldri på nytt etter lagring; test tidlig med 1000+ siders dokumenter.
4. **Inkrementell lagring-kanttilfeller** — sjekk `canBeSavedIncrementally()`, fall tilbake til full lagring; alltid temp-fil + atomisk rename.
5. **pdf.js API-endringer** (månedlige major-versjoner) — pin eksakt versjon, all pdf.js-bruk bak egen modul.
6. **Windows-integrasjon**: `second-instance`-argv får Chromium-brytere injisert — defensiv parser; single-instance-lås feiler når første instans kjører forhøyet (kjent Electron-bug).
7. **Omfang vs. én utvikler** — strengt «brukbar app per fase»; OCR/reflow/skjemaer eksplisitt utenfor omfang (KI kom inn som egen fase 9 etter Emils beslutning 2026-07-10).
