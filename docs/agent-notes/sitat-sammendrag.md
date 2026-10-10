# Sammendrag bak en henvisning (issue #31, del 2) — forskningsnotat 2026-10-10

Spørsmål: kan et hover over en sitering i en PDF vise den siterte artikkelens
sammendrag, uten API-nøkler og uten løpende kostnader? Del 1 (forhåndsvisning
av lenkemålet) er bygget (`src/renderer/src/link-preview.ts`,
`components/LinkPreview.tsx`) og viser allerede referanseoppføringen lokalt.
Dette notatet gjelder bare sammendraget.

## Målt pipeline (12 OA-PDF-er, 106 siterte oppføringer, 572 forespørsler)

Kjeden er: lenke → oppføringens tekst → identifisere verket → hente sammendraget.

1. **Hente ut oppføringen fra referanselisten (offline): ~95 % rene.**
   Oppføringen går fra destinasjonens y-verdi til neste navngitte destinasjon
   i samme familie (`cite.*`, `bm_CR*`, `bib*` …) på siden. Brukes med et tak
   på 10 linjer, og med layoutheuristikk (ny `[n]`/innrykk) som reserve.
   Feilkilder:
   - Springer Nature har FitR-mål på helsidebredde med invertert rektangel.
     Kolonnen må utledes av sekvensen.
   - PLOS-målene er forskjøvet ~172 pt. Treff på den trykte etiketten
     (`refNNN` = nr. NNN) redder alle.
   - Frontiers har generiske «Anchor N»-navn, så der må sideregelen brukes.
2. **Identifisere verket: 82 % riktig, 1 % feil, 17 % ingen.**
   - DOI står i oppføringen i 39 % av tilfellene, arXiv-id i 6 %.
   - Ellers brukes Crossref `query.bibliographic` (keyless). Treffet godtas
     bare etter lokal verifisering: hele normalisert tittel finnes i
     oppføringen og året ligger innen −6/+4, eller ≥ 85 % av tittelordene
     finnes og året er ±1. Treff som er «Commentary/Reply/Review» avvises.
   - Crossref-score alene er ikke trygg: ≥ 60 gir fortsatt 4 % feiltreff.
   - Fysikkreferanser har ikke tittel og trenger en sjekk på volum og
     førsteside. Humaniora og bøker gir nesten ingenting.
3. **Hente sammendrag (79 % av identifiserte med alle kilder).**

   | Kilde | Treff | Merknad |
   |---|---|---|
   | arXiv | 100 % | når id er kjent |
   | Europe PMC | 72 % | biomedisin |
   | OpenAlex | 78 % | |
   | Semantic Scholar | 65 % | |
   | Crossref | 26 % | Elsevier og T&F deponerer ingen sammendrag |

   - Uten Semantic Scholar og OpenAlex (Crossref + Europe PMC + arXiv) faller
     treffraten til 62 %.
   - Elsevier ble i hovedsak reddet av S2 og Europe PMC.
   - **Etterfylt 2026-10-10:** OpenAlex slått opp på DOI for alle 86
     riktig identifiserte verk. DOI-oppslag er gratis uten nøkkel og gikk
     gjennom selv med tomt søkebudsjett. Resultat: arXiv + Europe PMC +
     Crossref + OpenAlex-på-DOI gir **80 %** av identifiserte (66 % ende til
     ende). Med Semantic Scholar i tillegg blir det 85 %.
4. **Ende til ende: 68 %** (72 av 106) får et sammendrag med alle kilder.
   Median ~1,1 s, p90 1,7 s.

## Kildene i dag (verifisert 2026-10-10)

- **Crossref:** ingen nøkkel, CORS `*`.
  - Offentlig pool: 5 oppslag/s per post og 1 søk/s.
  - Mailto-pool: 10/s og 3/s.
  - Ber om caching og User-Agent med mailto.
  - Hovedmotoren for å matche referansetekst.
- **OpenAlex:** API-nøkkel påkrevd siden 2026-02-24. Uten nøkkel er det
  «demo» med $0,10/dag per IP.
  - Oppslag på DOI er gratis. Et søk koster 0,001.
  - Budsjettet gikk tomt etter ~93 søk i testen, og en hel institusjon bak
    én IP deler det.
  - Lukkede Springer- og Elsevier-sammendrag er fjernet (2022/2024).
  - Bruk bare DOI-oppslag, aldri søk.
- **Semantic Scholar:** delt anonym pool med 429 på 60–80 % av kallene.
  Lisensen krever attribusjon, og deler av dataene er CC BY-NC. Ikke en
  avhengighet; ikke uten Emils vurdering av lisensen.
- **arXiv-API:** CC0, 1 forespørsel per 3 s. Må køes i appen.
- **Europe PMC:** ingen nøkkel, CORS `*`, rask (median 112 ms).
- **DataCite:** sammendrag for `10.48550` (arXiv) og Zenodo.

Plattform: main (Electron) har ingen CORS. Utvidelsen har `host_permissions`
for alt http(s). Samme mønster som DOI-reserven (`src/shared/doi.ts`:
injisert fetch, delt klient, cache for suksess).

## Bygget 2026-10-10 (Emil: klikk, de fire nøkkelfrie kildene)

Koden ligger i `src/renderer/src/link-preview.ts` (`citationEntryText`, `entryFromLines`), `src/shared/abstract.ts` og `components/LinkPreview.tsx`.

**Uttrekk** av oppføringen, kjørt mot de samme 12 PDF-ene: 666 oppføringer, og alle utenom en håndfull er strukturelt rene. Det krevde fem regler:

- **Hevet anker:** hyperref hever ankeret én linje, så linjen i ankerhøyde er *forrige* oppførings hale. Starten flyttes ned når neste linje begynner lenger til venstre, har etikett, eller er «Etternavn,».
- **Neste anker:** neste oppførings anker står i høyde med denne oppføringens siste linje. Kutt først en halv linje under det.
- **PLOS:** etiketten («12.») vinner når ankeret peker på en annen nummerert linje. «10.1186/…» er en DOI, ikke etikett 10.
- **Springer Nature:** FitR-mål på helsidebredde gir ingen kolonne. Kolonnen utledes av listens rekkefølge (lista «klatrer» opp ved kolonneskiftet).
- **Back matter:** kutt ved «Acknowledgements» og annen back matter.

Navnefamilier som nå kjennes igjen: `bm_CR`, eLife `:R29:`, REVTeX `intralink-c`, og PLOS `L…ref` som tilbakelenke (ikke sitering). Frontiers' generiske «Anchor N» gjenkjennes ikke, så der vises ingen knapp.

**Rekkefølge endret etter live-test:**
- arXiv-API-et svarte 429, eller brukte 10–15 s, i flere kall på rad.
- Et arXiv-papir slås derfor først opp i OpenAlex på `10.48550/arXiv.<id>`, og arXiv-API-et brukes bare når OpenAlex mangler sammendraget.

**Live-sjekk av den ferdige koden:** 55 siteringer, 5 per PDF, gav **36 sammendrag (65 %)**. Ingen synlige feiltreff. Typisk tid var 0,2–0,7 s.
- Fysikk ble 0/5 (referanser uten tittel).
- Arabisk humaniora ble 1/5.
- Bom ellers: et par arbeidsnotater og konferansebidrag uten Crossref-post.

## Anbefalt design (besluttet 2026-10-10, se over)

- **Kaskade:**
  1. DOI/arXiv i teksten.
  2. Ellers Crossref bibliographic med verifiseringen over.
  3. Sammendrag: arXiv → Europe PMC → Crossref → OpenAlex på DOI (gratis
     oppslag, en 401/429 regnes som bom).
- **Tilstand uten sammendrag:** et vanlig utfall (~1 av 3), ikke en feil.
  Oppføringen står allerede i vinduet.
- **Nettverk:** klikk, ikke automatisk. Lovnaden er «offline med mindre du
  spør», og DOI-reserven er et klikk av samme grunn. Valgfritt: en innstilling
  for å hente automatisk ved hover.
- **Cache:** per DOI, også for bom, slik Crossref ber om.
