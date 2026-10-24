# Kokebok for håndtesting

Det maskinene allerede har sjekket står i CLAUDE.md (CI-testene og
skrivebordstestene). Dette er resten: det som bare kan ses med egne øyne, og
det som er lett å glemme etter en stor runde. Hver oppskrift sier hva du gjør,
hva du skal se, og hvilken automatisk test som dekker resten – så du vet hva du
IKKE trenger å prøve.

Skrevet 2026-10-24 for v0.67–v0.71 (håndverktøy, samtaler på tvers av
dokumenter, OCR, issue #53, egne farger, bindersen). Eldre funksjoner har sine
egne håndsjekker i `docs/RELEASE.md` steg 1 (Print, utvidelsen, fanedrag).

## Før du begynner

```bash
npm run build
```

- Testdokumenter: «Attention Is All You Need» (`docs/screenshots/attention.pdf`,
  ikke i git), en EKTE skann (JSTOR-utskrift eller en fotokopi – `npm run
  shoot` kan lage én av attention.pdf i `docs/screenshots/_auto/attention-scan.pdf`),
  og ett passordbeskyttet dokument.
- Assistenten: en nøkkel inne, eller en lokal modell (Ollama). Testene under
  bruker ekte modell der det står; ellers holder det at svaret kommer.
- Kjør på den skjermskalaen du faktisk leser på (150 % på Surface), og én gang
  på en ekstern skjerm med annen skala – punkt 1 under er avhengig av det.

## 1. Skarp tekst ved alle zoomnivåer (v0.70, issue #53 pkt 1)

**Gjør:** Åpne attention.pdf. Zoom med Ctrl+hjul gjennom 100 → 110 → 115 → 125
→ 132 → 150 %. Stopp på hver, se på brødteksten. Prøv også fit-width og
tosidig visning. Flytt vinduet til en skjerm med annen skala.

**Se:** Teksten er like skarp på alle. Det gamle symptomet var «uklar på noen
nivåer, skarp på andre, ±1 % hjalp». Et merke (utheving) ligger nøyaktig på
teksten også etter zoom.

**Dekket av maskin:** `test:rotation` § 9 (alle bokser på hele enhetspiksler
ved 1/1.25/1.5/1.75/2). Det en test ikke ser: om bildet faktisk oppleves
skarpt – det er dette punktet.

## 2. Tekstboks: størrelse etterpå, og menyen med verktøyet valgt (v0.70, #53 pkt 2)

**Gjør:** Velg tekstverktøyet (T), klikk på siden, skriv «Prøve», klikk
utenfor. Klikk boksen igjen (uten verktøy): dra størrelsesglideren til 24 pt.
Bytt skrift til Courier. Velg tekstverktøyet igjen og klikk på den samme boksen.

**Se:** Glideren står på boksens egen størrelse; 24 pt dobler bokstavene og
boksen vokser. Courier overlever at du endrer størrelse og farge etterpå. Med
verktøyet valgt åpner klikket BÅDE redigering og menyen ved siden av. Lagre,
åpne i Edge: samme skrift, samme størrelse.

**Dekket av maskin:** `test:annot-edit` § 4–5, `test:engine` (skrift gjennom
regenerering). Håndsjekk: utseendet i Edge/Acrobat etter lagring.

## 3. Dupliser fane (v0.70, #53 pkt 3)

**Gjør:** Stå på side 6. Høyreklikk fanen → «Dupliser fane» (eller
Ctrl+Shift+K). Marker tekst i kopien. Lukk kopien.

**Se:** Kopien åpner rett til høyre, på side 6. Utheving gjort i kopien vises
i originalen uten lagring; begge faner får prikken. Lukking av kopien spør
ingenting, og merket står i originalen. Fest originalen og dupliser: kopien
er ufestet, etter den festede gruppa.

**Dekket av maskin:** `test:tab-duplicate` (alt over, mupdf-verifisert
lagring). Håndsjekk: at det kjennes riktig – det er en «ny visning», ikke et
nytt dokument.

## 4. Håndverktøy (v0.67)

**Gjør:** Trykk hånd-knappen ved pennen. Dra siden i alle retninger over
tekst, en lenke og et merke. Esc. Åpne chevronen ved hånden, slå på
«Space holder hånden», velg uthevingspennen, hold Space og dra, slipp.

**Se:** Ingenting markeres, ingen lenke åpner, ingen merker flyttes. Esc
legger hånden ned; å velge penn/utheving/form gjør det samme. Space-grepet
gir pennen tilbake når du slipper. Bryteren er av som levert (Space blar
ellers).

**Dekket av maskin:** ingen egen test (ingen reaksjon = ingenting å måle).
Dette er en ren håndsjekk, også med penn på Surface.

## 5. Samtaler på tvers av dokumenter (v0.68, issue #46)

**Gjør:** Still tre spørsmål om attention.pdf i assistenten (ett med et
klipp av figur 1). Lukk appen, åpne den igjen. Biblioteket → fanen
«Samtaler». Søk på et ord fra ett av svarene. Klikk kildebrikken «s. 6» i et
svar. Flytt attention.pdf til en annen mappe OG gi den nytt navn, åpne den
derfra.

**Se:** Samtalene er der etter omstart (ingen grense på ti lenger).
«Nylig lest»-kortet har et stille tall; «Vis samtaler» åpner fanen filtrert
på dokumentet. Søket finner samtalen med et utdrag. Kildebrikken åpner
dokumentet på side 6 med avsnittet blinkende og assistenten på den
samtalen. Den flyttede filen åpner på siden du sto, sier «Gjenkjent fra
…», og samtalene er med. Slett filen (eller flytt den uten å åpne) →
«Filen finnes ikke» i lista, og filteret «Filen mangler» viser bare den.

**Rydding:** «Rydd opp og eksporter» → «Egendefinert …» → skriv 1 måned:
dialogen SIER hvor mange den tar før du bekrefter. Skriv bokstaver i feltet:
handlingen tilbyr ingenting. Eksporter til Markdown og åpne fila.

**Passord:** Still ett spørsmål med et klipp om det låste dokumentet. Se i
`%APPDATA%\PDF Scholar\chats\` at fila for det dokumentet ikke inneholder
bildedata (søk etter `dataBase64`); når samtalen åpnes igjen står det
«Bilder ikke lagret (1)» i stedet for bildet.

**Dekket av maskin:** `test:chat-history`, `test:doc-identity`,
`test:library-desktop`, `test:identity-desktop`. Håndsjekk: lesbarheten av
lista med MANGE samtaler, og at flyttingen kjennes trygg.

## 6. OCR – tekst på skannede sider (v0.69–v0.70)

**Gjør:** Åpne en ekte skann. Vent til teksten er lest (chip i verktøylinja).
Marker en setning, kopier, lim inn et sted. Uthev to ord. Søk etter et ord
som står på side 20. Spør assistenten «Hva handler side 3 om?». Slå av
«Les tekst i bilder automatisk» i innstillingene, åpne en ANNEN skann.

**Se:** Markeringen følger ordene på skannet (ikke forskjøvet). Uthevingen
ligger på ordene. Søket viser «Leser tekst i bilder og skannede sider … N av
M» og treffene kommer mens det leser; et 30-siders dokument tar et minutt
eller to første gang, og er umiddelbart neste gang (lagret i IndexedDB).
Assistenten svarer med kildebrikker som hopper til riktig sted. Med
bryteren av: ingenting leses før du trykker «Gjenkjenn tekst» (chipen,
søkefeltets notis, eller assistentens varsel).

**Bilder på vanlige sider:** Ta et dokument med et innlimt SKJERMBILDE av
en tabell (figurene i attention.pdf er vektortegninger og har ekte tekst –
de teller ikke). Søk etter et ord som bare står i bildet. Se at det finnes,
og at ordene i bildet ikke dukker opp dobbelt når du markerer brødteksten
rundt.

**Passord:** Åpne en låst skann, lukk, åpne igjen: den leses på nytt (ingen
lagring for låste dokumenter – det er meningen).

**Dekket av maskin:** `test:ocr` (ekte motor på bygde skanner, kolonner,
rotasjon, lagring, bildetekst). Håndsjekk: hastighet og følelse på DIN
maskin, æøå på en norsk skann, at merkene ser riktige ut i Edge etterpå.

## 7. Egne farger (v0.71, issue #50) og fargehjulet i verktøylinja

**Gjør:** Marker tekst → «+» i markeringsmenyen → velg en farge i hjulet og
LUKK dialogen. Gjenta med to farger til, så en fjerde. Trykk × på én.
Åpne tusjens meny i verktøylinja: samme «+», samme lagrede farger.
Marker tekst nederst i en lang meny (mange verktøy synlige) og trykk «+».

**Se:** Ordene farges først når dialogen lukkes – ikke underveis (v0.69 farget
ved første bevegelse og fylte plassene med gule nyanser). Tre plasser: ny
farge først, en gjentatt flyttes fremst, den eldste faller ut ved fire, ×
glemmer nøyaktig én. Verktøylinja og markeringsmenyen viser SAMME liste.
Hjulet klippes ikke av menyens rullefelt – det står over «+», eller under
når det ikke er plass over.

**Dekket av maskin:** `test:custom-colors` (reglene). Håndsjekk: selve
dialogen (Electrons egen fargevelger), og plasseringen av poppen.

## 8. Bindersen og lokale filer som kontekst (v0.71)

**Gjør:** Assistenten → bindersen nederst i skrivefeltet. Se lista
(«Vedlegg», «Ingenting vedlagt ennå», tre knapper). «Fil …» → velg en
.md-fil med noen setninger du kjenner igjen. Spør «Hva står i notatene
mine?». Så «Samtale …» → legg ved en samtale fra et annet dokument.
Dra et klipp av figur 1 med klippeverktøyet. Trykk Esc, klikk utenfor.
Send et spørsmål med lista åpen.

**Se:** Bindersen får et tall (1, så 2, så 3); lista åpner seg SELV når klippet
lander. Hver brikke har sitt kryss. Med «Bekreft før deling» på navngir
stripa fila («Vedlagte filer følger med: notater.md») før første sending.
Svaret bruker notatenes innhold, men siterer dokumentet (fila er «notater»,
ikke kilde). Esc og klikk utenfor lukker lista; sending lukker den. En .exe
eller .docx avvises med beskjed («Bare PDF og tekstfiler …»); en sjette fil
avvises («Høyst 5 filer om gangen»); en tom fil sier «har ingen tekst».
Ingen brikker ligger i selve tekstfeltet lenger.

**Dekket av maskin:** `test:file-context`, `test:attach-desktop` § 1–7
(hva som faktisk forlater maskinen, med opptak). Håndsjekk: at en EKTE
modell faktisk bruker notatene og ikke siterer dem som dokumentet – ikke
prøvd mot ekte modeller ennå.

## 9. Nettsøk av/på (v0.71)

**Gjør:** Med Anthropic- eller OpenAI-nøkkel: kloden i skrivefeltet. Av
(standard): spør «Hva er dagens dato?». På: samme spørsmål. På: spør noe
som dokumentet svarer på («Hva er positional encoding her?»).

**Se:** Av = ingen nettsøk, modellen sier den ikke vet. På = den søker og
svarer med nettkilder. På + dokumentspørsmål = den søker IKKE (den har
verktøyet, men spørsmålet ba ikke om det). Bare to tilstander; tooltipen
sier hvilken. Kloden finnes ikke for Gemini/kompat (profilen).

**Dekket av maskin:** `test:ai-chat` (forespørselsform), `test:ai-settings`
(ingen klode for kompat). Håndsjekk: modellens dømmekraft – det er den
dette punktet handler om.

## 10. Ctrl+N og snarveier (v0.71)

**Gjør:** Ctrl+N. Ctrl+Shift+N. Innstillinger → tastatursnarveier → «Åpne
PDF».

**Se:** Ctrl+N åpner fildialogen (som «+» i fanelinja), Ctrl+Shift+N nytt
vindu. Kartet viser Ctrl+O og Ctrl+N på samme rad.

## 11. Skjermbilder og kopi

```bash
npm run check:shots
```

De fire assistentrammene i `docs/screenshots/_auto/` (assistant,
assistant_snip, assistant_figure, search_ai) viser den nye komposisten
(klode, binders, utsnitt, send). Velg hvilke som skal inn i `docs/screenshots/`
og `docs/store-screenshots/` – «Screenshots by hand» er regelen. README,
landingssiden og begge butikklistene er oppdatert for alt over; butikkene har
ikke fått noen versjon siden v0.54.0.

## Står igjen fra RELEASE.md steg 1 (alltid)

- Skriv ut én gang (Print-dialogen – Electron-patchen kan bryte den stille).
- Last utvidelsen på nytt i `edge://extensions` (ext:release har lagt v0.71.0
  i `dist-extension/`), åpne en PDF fra nett og én fra «Nylig lest».
- Dra en fane ut til et annet vindu med mus (den native drag-gaten).
