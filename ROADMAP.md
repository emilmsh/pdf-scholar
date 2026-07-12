# PDFX — Veikart

Mål: en så tro kopi av PDF Expert (Readdle) som mulig, for Windows. Hver fase skal gi en brukbar app. Detaljert funksjonsspesifikasjon: [docs/SPEC.md](docs/SPEC.md).

**Arkitektur (besluttet 2026-07-09):** Electron + electron-vite + React + TypeScript. pdf.js (pdfjs-dist v6) er **lesemotoren** (rendering, tekstlag, søk, TOC). mupdf (offisiell WASM, npm) blir **annoteringsmotoren** (skriver standard PDF-annotasjoner med appearance streams, inkrementell lagring) bak et typet `AnnotationEngine`-grensesnitt i hovedprosessen. Annotasjoner tegnes av vårt eget React-overlegg — vi bruker ikke pdf.js sitt redigeringslag (det mangler underline/strikeout/notater og har kjente feil). Dette er samme arkitektur som Zotero/Okular. Merk: mupdf er AGPL — uproblematisk for personlig bruk; beslutning om ev. distribusjon tas ved fase 8 (åpen kildekode, kommersiell lisens, eller bytte til EmbedPDF/PDFium bak grensesnittet).

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
- [ ] «aA»-panel: rulleretning (vertikal kontinuerlig / horisontal én-side), to-siders oppslag, beskjær marger
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
- [ ] Marker alle treff samtidig; søkehistorikk
- [ ] Bokmerker-fane utvalg

## Fase 4 — Annoteringsfundament (Emils prioritet nr. 2)
Grunnmuren levert 2026-07-09: mupdf `AnnotationEngine` skriver Highlight (5 farger)/Underline/StrikeOut/Squiggly/notater som standard PDF-annotasjoner med appearance streams, inkrementell lagring og atomisk filbytte.
- [x] Eksisterende annotasjoner leses inn ved åpning (enumerert via pdf.js) og er klikkbare
- [x] Klikk/høyreklikk på annotasjon → egenskaper-popover: bytt farge, rediger notattekst, slett — også annotasjoner fra andre apper (motoren adresserer via PDF-objektnummer; rundtur verifisert)
- [x] Squiggly (bølgestrek) i kontekstmenyen
- [x] Merknader-fane i sidepanelet: alle annotasjoner gruppert per side med farge/tekst/forfatter; klikk hopper, hover-slett
- [x] Sømløs dokument-gjenåpning etter redigering (én pdf.js-worker per dokument)
- [x] Kommentar kan knyttes til ALLE annotasjonstyper via popoveren, ikke bare notater (levert 2026-07-09)
- [x] Angre/gjør om for annotasjoner: Ctrl+Z / Ctrl+Shift+Z (også Ctrl+Y) som inverterbare motoroperasjoner — fungerer også på tvers av dokument-gjenåpninger (levert 2026-07-09, opprinnelig fase 5-punkt)
- [ ] «Armert verktøy»-flyt (verktøyet forblir aktivt for gjentatt bruk)
- [ ] Egendefinert fargevelger + opasitetskontroll (5-feltspalett finnes)
- [ ] **Interop-port**: åpne PDFX-annoterte filer i Acrobat/SumatraPDF/PDF Expert (iPad) og verifiser identisk visning — Emils manuelle test gjenstår

## Fase 5 — Fullt annoteringsverktøysett
- [x] Penn og gjennomskinnelig markeringstusj: frihåndstegning med coalesced pointer events, farge- og breddevalg per verktøy, skrives som standard Ink-annotasjoner (rundtur verifisert); Esc avslutter verktøyet (levert 2026-07-10)
- [x] Viskelær: sletter hele strøk med presis punkt-til-segment-trefftest; angrbart (levert 2026-07-10)
- [x] ~~Angre/gjør om som inverterbare motor-operasjoner; hurtigtaster~~ (levert 2026-07-09)
- [x] Former: rektangel, ellipse, linje og pil — dra for å tegne med live forhåndsvisning; farge/bredde-valg; skrives som Square/Circle/Line-annotasjoner (pil = Line med ClosedArrow-ende; rundtur verifisert) (levert 2026-07-10)
- [x] Fritekst på siden: klikk med tekstverktøyet → skriv → FreeText-annotasjon med riktig DA (tekstfarge, Helv 12) (levert 2026-07-10)
- [ ] Trykkfølsom penn (krever polygon-appearance i stedet for enkel Ink-bredde — utsatt bevisst for interop)
- [ ] Lasso-multivalg for blekk
- [ ] Flytt/endre størrelse på former og fritekst med håndtak
- [ ] Verktøysett-system i verktøylinjen (tilpassbare grupper)

## Fase 6 — Annotasjonspanel + eksport (Emils prioritet nr. 3)
- [x] Merknader-fane: liste gruppert per side; klikk for å hoppe; slett enkeltvis (levert med fase 4)
- [x] **Eksporter annotasjonssammendrag** som Markdown, HTML og ren tekst — inkluderer faktisk markert tekst (hentet via quad/tekst-geometri), kommentarer og forfatter, gruppert per side (levert 2026-07-09)
- [x] Markert tekst-utdrag i selve listen («utdrag» — kommentar som andrelinje) (levert 2026-07-10)
- [x] Søk i merknader + fargefilter (5 palettfarger, kombinerbart med søk) (levert 2026-07-10)
- [ ] Tøm alle med bekreftelse
- [ ] «Annoterte sider»: ny PDF med kun sider som har annotasjoner

## Fase 6.5 — Faner (Emil ønsker dette tidlig, trukket frem fra fase 7)
- [x] Fanelinje for flere åpne dokumenter: klikk/klikk-på-✕/midtklikk lukker, + åpner, Ctrl+Tab / Ctrl+Shift+Tab veksler, Ctrl+W lukker, Ctrl+O åpner; bakgrunnsfaner beholder full tilstand (scroll, zoom, angre-stakk) og leseposisjon lagres ved fanebytte (levert 2026-07-10)
- [ ] Dra faner for å endre rekkefølge; «lukk andre faner»-meny

## Fase 7 — Skall-paritet og polering
- [x] **Språkvalg i appen: norsk bokmål og engelsk** (Emils ønske 2026-07-11, levert samme dag) — alle UI-strenger i `src/renderer/src/i18n.ts` med `t()`-oppslag, velger i aA-menyen (Norsk/English/Auto der auto følger OS-språket), gjelder også KI-systemprompter, eksportdokumenter og datoformat. Nye strenger SKAL inn i begge ordbøkene.
- [x] Høytlesing (Emils valg fra Edge-vurderingen, levert 2026-07-12): setningsvis TTS via SpeechSynthesis med markering som følger og auto-scroll, spill/pause/stopp, hastighet og stemmevalg
- [x] Skriv ut (levert 2026-07-12): skjult vindu med Chromiums PDF-viser + systemets utskriftsdialog
- [ ] **Roter sider** (Emils bestilling 2026-07-12) — visningsrotasjon 90°-steg; krever koordinatmapping i alle overlegg + inverse på tegneverktøy
- [ ] **Tosiders visning** (Emils bestilling 2026-07-12) — motstående sider (forside alene), layoutmotoren må lære rader
- Fanelinje for flere dokumenter; delt visning
- Stempler, signatur, verktøylinje-tilpasning
- Designgjennomgang mot PDF Expert: avstander, ikoner, animasjoner, mørkt app-chrome

## Fase 9 — KI-assistent («PDF Scholar»-retningen; plan i docs/AI-PLAN.md)
Besluttet med Emil 2026-07-10: prioritering 1→3→2→4→6 (deretter 5 referanseoppslag); fleksibel multi-leverandør fra start; forklar-utvalg som popover med «Send til chat»; **PDF Scholar som arbeidsnavn** (appen er PDF-leser først, KI-appene i Scholar-rommet er KI først — forvekslingsrisikoen er mindre relevant).
- [x] **Nivå 1 levert (2026-07-10):** chat-sidepanel med strømmende svar og klikkbare kildechips «s. N» (hopp + markering på setningsnivå via søkemaskineriet); Forklar/Forenkle/Definer i kontekstmenyen med popover + «Send til chat»; API-nøkkel kryptert med safeStorage (nøkkel forlater aldri main-prosessen); leverandører: Anthropic (innebygde Citations, prompt-caching), OpenAI + Azure (SSE + ordrett-sitat-kontrakt løst mot sideteksten), mock (offline test); kostnadsestimat per svar + løpende sum
- [x] Strukturert artikkelsammendrag (levert 2026-07-11): knapp i panelets tomtilstand + toppfelt → forskningsspørsmål/metode/data/funn/bidrag/begrensninger med kildechips; går gjennom vanlig chat-løype (strømming + siteringer gratis); kompakt brukerboble skjuler instruks-stillaset; tilpasser seksjonene for ikke-empiriske dokumenter
- [x] Spør annotasjonene (levert 2026-07-11): ✦-knapp i Merknader-fanen + forslag i panelets tomtilstand (vises kun når dokumentet har merknader) → sender merknadsblokken (side/type/utdrag/kommentar fra eksportuttrekket) inn i chatten; blokken ligger i historikken så oppfølgingsspørsmål beholder den
- [ ] Referanseoppslag (klikk på sitering → KI forklarer det refererte verket) — differensiatoren
- [ ] Begrepshjelp (ordliste slik begrepene brukes i dokumentet)
- [ ] PDF-base64-fallback for skannede dokumenter (page_location-siteringer)
- [ ] Nivå 3 (parkert): kryssdokument, forhør-meg-quiz, metodekritikk-modus, forklar figur

## Fase 8 — Filhåndtering + sky (Emils prioritet nr. 4)
- Hjemskjerm: Nylige (20) + Favoritter med egendefinert rekkefølge og fargeetiketter
- Innholdssøk på tvers av filer i valgt mappe
- Sky: primært via synkmapper (OneDrive/Dropbox) + filovervåking; API-integrasjon bare hvis nødvendig
- **Beslutningsport for distribusjon**: mupdf AGPL-avklaring, kodesignering, auto-oppdatering

## Tankeboks (ikke planlagt, ikke glemt)
- **Nettleserutvidelse**: PDFX som PDF-visnings-erstatning i Edge/Chrome (MV3-extension). Fundamentet ligger til rette: renderer-en kjører allerede i ren nettleser via `bridge.ts`-fallbacks. Krever: mupdf WASM flyttet til renderer/worker, File System Access API for lagring, extension-innpakning. (Emils idé 2026-07-09.)
- **Legg monetiseringsstrategi**: hvordan PDFX eventuelt kan tjene penger (lisens/kjøp/abonnement/gratis+pro — omfang avklares med Emil når det tas opp). NB: mupdf er AGPL — kommersiell distribusjon krever Artifex-lisens eller bytte av skrivemotor, se fase 8-porten. (Emils ønske 2026-07-09.)

## Viktigste risikoer (med tiltak)
1. **Koordinat-mapping** pdf.js-viewport ↔ PDF-sideflate (y-flipp, rotasjon, cropbox) — én delt, enhetstestet transformmodul; la mupdf beregne quads selv.
2. **Utseende på tvers av visere** — interop-testmatrise som fasekrav for hver annotasjonstype.
3. **To parsere** (pdf.js leser, mupdf skriver) kan divergere — overlegget eier annotasjonspiksler, pdf.js lastes aldri på nytt etter lagring; test tidlig med 1000+ siders dokumenter.
4. **Inkrementell lagring-kanttilfeller** — sjekk `canBeSavedIncrementally()`, fall tilbake til full lagring; alltid temp-fil + atomisk rename.
5. **pdf.js API-endringer** (månedlige major-versjoner) — pin eksakt versjon, all pdf.js-bruk bak egen modul.
6. **Windows-integrasjon**: `second-instance`-argv får Chromium-brytere injisert — defensiv parser; single-instance-lås feiler når første instans kjører forhøyet (kjent Electron-bug).
7. **Omfang vs. én utvikler** — strengt «brukbar app per fase»; OCR/reflow/skjemaer eksplisitt utenfor omfang (KI kom inn som egen fase 9 etter Emils beslutning 2026-07-10).
