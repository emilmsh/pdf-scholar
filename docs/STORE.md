# Store distribution guide

Three store tracks, all without recurring costs. Account registration and the
one-time fees are personal steps Emil does himself; everything technical is
prepared in the repo. Status lives in the checklists below — tick them off as
they happen.

## Why stores at all

- **Microsoft Store** solves the two real problems with the GitHub exe: no more
  SmartScreen "unknown publisher" scare (the Store signs the package on
  ingestion) and updates handled by the Store. SmartScreen reputation for the
  unsigned GitHub exe builds per-file and resets with every release, so it will
  keep warning users — the Store listing is the proper fix, and registration is
  now free.
- **Edge Add-ons / Chrome Web Store** turn the extension's four-step
  "Load unpacked" install into one click, and stores auto-update extensions.

---

## Track A — Microsoft Store (desktop app, MSIX)

**Cost: FREE.** Microsoft dropped the individual-developer registration fee — an
Individual account now costs nothing.

> **Don't start from `partner.microsoft.com`'s generic dashboard.** That lands
> you in the Cloud Partner Program (for companies with Entra admin roles) — it
> looks empty and says you have no admin access. That is the WRONG program.
> Use the dedicated Microsoft Store enrollment door below.

1. **[Emil]** Enroll via **<https://developer.microsoft.com/microsoft-store/register>**
   (Microsoft Learn walkthrough:
   <https://learn.microsoft.com/windows/apps/publish/partner-center/open-a-developer-account>).
   Choose the **Individual** account type (for non-commercial / personal apps —
   fits a free open-source project). It **requires a personal Microsoft account
   (MSA)**, not a work/Entra account; a Gmail address works as long as it's
   registered as a Microsoft account. Individual enrollment now includes
   **identity verification** (government-issued ID + a selfie). Note: an
   Individual account can't later be converted to Company — but Individual is
   the right choice here.
2. **[Emil]** Once enrolled, open the Microsoft Store dashboard: **Apps and
   games → New product → MSIX or PWA app**, reserve the name **PDF Scholar**.
3. **DONE** — the three identity values are filled into
   `config/electron-builder.store.yml` (Store ID `9N75CPC0G9M2`, PFN
   `EmilMathiasStrmHalseth.PDFScholar_9ddn91dy4x8sa`).
4. Run `npm run dist:store` → `release/PDF-Scholar-<version>-x64.appx` and
   `…-arm64.appx` (both **unsigned** — the Store signs on ingestion; the log
   line "AppX is not signed — reason=Windows Store only build" is expected). A
   NSIS `.exe` is also emitted as a byproduct — ignore it; only the `.appx`
   files go to the Store.
5. **[Emil]** In the submission's **Packages** step, upload **both** `.appx`
   files (same version, different architecture — the Store serves the right one
   per device). Fill in the listing (screenshots under `docs/screenshots/`),
   set the privacy policy URL to
   `https://github.com/emilmsh/pdf-scholar/blob/master/docs/PRIVACY.md`, and submit
   for certification (typically 1–3 days).
5b. **[Emil]** In the submission's **Properties → Product declarations**, tick
   **"This product incorporates generative AI features…"** — the app ships an AI
   assistant that generates text, so Store policy **11.16** requires the
   declaration. (Certification of v0.17.1 failed on this; it's a checkbox, not a
   code change.)
6. Notes already handled in code/config: electron-updater disables itself in
   Store installs (`process.windowsStore`); the `.pdf` file association rides
   along in the MSIX manifest via `fileAssociations`; the MSIX tile + logo
   assets live in `build/appx/` (regenerate with `npm run icons:appx` after any
   icon change — WITHOUT them electron-builder ships its default placeholder
   logo, which fails Store policy **10.1.1.11**, as v0.17.1's certification did).

Version bumps (manual): run `dist:store` again and add the new packages to a
new submission in Partner Center. Listing copy to paste lives in
`docs/STORE-LISTING-DESKTOP.md` (keep its "What's new" block current).

### Automated Store publishing (optional)

Publishing can be automated with the **`.github/workflows/store-publish.yml`**
workflow (manual trigger), which builds the MSIX and runs
`scripts/store-publish.ps1` against the **legacy** Microsoft Store submission
API — the only one that accepts MSIX/appx (the newer "Store submission API" is
MSI/EXE only). It works with this **Individual** account; the account just needs
an associated Azure AD directory (free) and an Azure AD app with the Manager
role.

> **API rule:** once a submission is created/edited via the API, do **not** edit
> it in the Partner Center UI — that severs API control of it. It's API **or**
> UI per submission, never both.

**[Emil] One-time setup** (produces three values, then never again):

1. Partner Center → **Account settings → Tenants**: associate an Azure AD
   directory. If you have none, "Create new Azure AD" there — free.
   (<https://learn.microsoft.com/windows/apps/publish/partner-center/associate-azure-ad-with-partner-center>)
2. **Account settings → User management → Azure AD applications** → **Add Azure
   AD application** → create one, assign it the **Manager** role.
3. Open the app, copy the **Tenant ID** and **Client ID**, then **Add new key**
   and copy the **key** (shown once).
4. In the GitHub repo → **Settings → Secrets and variables → Actions**, add:
   `STORE_TENANT_ID`, `STORE_CLIENT_ID`, `STORE_CLIENT_SECRET`.

Then run the **Store publish** workflow from the Actions tab. The **first real
run is a validation run** — the legacy API's field names may need a tweak in
`store-publish.ps1` against the live responses, which it logs on failure.
Age-ratings must have been answered once in the UI before the API can commit
(already done, since the app is live).

**The listing copy is pushed too, from the doc.** A new submission is a *clone of
the last published one*, so anything not overwritten silently re-publishes the
text that was live when it was created — and the API rule above means it cannot
be corrected in the UI afterwards. So `store-publish.ps1` parses
`docs/STORE-LISTING-DESKTOP.md` and sets, per listing language, the
**description**, **short description**, **product features** and **release
notes** (`scripts/lib/store-listing.ps1` does the parsing; EN copy goes to every
language except `nb`/`nn`/`no`, which get the NO copy). Consequences worth
knowing:

- **Edit the doc, not Partner Center.** The doc is the source of truth for those
  four fields; a UI edit to them is overwritten by the next API run.
- **Screenshots are not synced** — they carry over from the cloned submission.
  Upload new ones by hand from `docs/store-screenshots/` when they change.
- **The "What's new" heading is version-stamped** (`— v0.27.x`). If it does not
  match the version being published the run **fails**, rather than shipping last
  version's notes with this version's packages. Update the section, or pass a
  `whats_new` input to override.
- `npm run test:listing` checks the parse offline, with no credentials — it also
  runs in the workflow before the MSIX build. `check_only: true` prints the exact
  copy it would send, and creates nothing.
- `skip_listing_sync: true` falls back to the old behaviour: packages and release
  notes only, live description untouched.

## Track B — Edge Add-ons (extension)

**Cost: free.** Uses the same Partner Center account (the Edge program is a
separate, free enrollment).

1. **[Emil]** Enroll: <https://partner.microsoft.com/dashboard/microsoftedge/> —
   free.
2. Build the store zip: it is produced by the release workflow as
   `pdf-scholar-extension-store.zip` (manifest at the zip root — the
   folder-wrapped `pdf-scholar-extension.zip` is for Load-unpacked and will be
   REJECTED by store uploaders).
3. **[Emil]** New extension → upload the store zip → listing (Norwegian +
   English descriptions), privacy policy URL as above.
4. Permission justifications the reviewer will ask about (copy-paste ready):
   - `<all_urls>` + `declarativeNetRequest`: "Detects navigations to PDF files
     and opens them in the extension's viewer instead of the browser's built-in
     one. No page content on non-PDF sites is read or modified."
   - `file:///*`: "Lets users open local PDF files in the viewer (users must
     additionally enable 'Allow access to file URLs' themselves)."
   - The install opens ONE tab (the extension's own viewer page, no network
     call) to tell the user about that toggle, and only when the browser reports
     it is off — a store install cannot be asked for it any other way. Never on
     an update. See `docs/BROWSER-EXTENSION.md`.
5. Review typically takes up to ~7 days.

## Track C — Chrome Web Store (extension)

**One-time cost: USD 5** (developer registration).

1. **[Emil]** Register:
   <https://chrome.google.com/webstore/devconsole> with a Google account, pay
   the one-time USD 5 fee.
2. Upload the same `pdf-scholar-extension-store.zip`.
3. **[Emil]** Fill the **Privacy practices** tab: single purpose ("Open and
   annotate PDF files in a custom viewer"), the permission justifications from
   Track B, privacy policy URL, and "no remote code" / data-usage declarations
   (the extension collects nothing — see `docs/PRIVACY.md`).
4. Broad host permissions (`<all_urls>`) usually route the review to the slower
   queue — expect days to a few weeks on first submission.

> **Never declare a permission the code does not call.** v0.17.1 was rejected
> (violation ref "Purple Potassium") for declaring `tabs`, which
> `chrome.tabs.create` does not need. A rejection also disqualifies the item from
> expedited review for a while. Permission changes re-trigger deep review — see
> the note in `docs/STORE-LISTING.md`.

## Automated extension publishing (Edge + Chrome)

`scripts/ext-publish.ps1` + the **Extension publish** workflow
(`.github/workflows/ext-publish.yml`) are the extension half of the pipeline;
Track A's "Automated Store publishing" is the MSIX half. Same idioms: env-var
secrets, `-CheckOnly` dry run, manual dispatch only.

Both stores take the same artifact — `release/pdf-scholar-extension-store.zip`
(`npm run pack:ext:store`, manifest at the zip root). Before touching the
network the script checks the zip shape, rejects the folder-wrapped variant and
backslash entry names, and refuses a manifest version that does not match
`package.json`. Local dry run: `npm run test:ext-publish`.

**Neither API can change listing copy, screenshots or permission
justifications.** Those stay manual in the dashboards — the APIs upload a
package and submit it, nothing more.

### Edge (free, ~5 minutes of setup)

1. **[Emil]** Partner Center → **Microsoft Edge** → **Publish API** → click
   **Enable** next to "enable the new experience" (that is the v1.1, API-key
   UI), then **Create API credentials**.
2. Copy the **Client ID** and the **API key**. The key has an **expiry date** —
   a 401 later means "renew it", not "the script broke".
3. Repo secrets: `EDGE_CLIENT_ID`, `EDGE_API_KEY`. The product ID
   (`2d23581d-291e-4953-aaf1-0db8715d42ad`, from **Microsoft Edge → Overview →**
   the extension **→ Extension identity**) is an identifier, not a credential —
   it is the script's default, overridable with `EDGE_PRODUCT_ID`.

The dry run has no "read the product" endpoint to lean on (the API has none), so
it probes a nil operation ID: **404 means the credentials work**, 401/403 means
they do not.

### Chrome (one-time Google Cloud setup)

1. Google Cloud Console → new (or existing) project → enable the **Chrome Web
   Store API**.
2. Configure the OAuth consent screen (**External**), then create an OAuth
   client of type **Web application** with
   `https://developers.google.com/oauthplayground` as an authorised redirect URI.
3. Mint a refresh token in the OAuth Playground with scope
   `https://www.googleapis.com/auth/chromewebstore`. Set the consent screen to
   **In production** first — a token issued in Testing mode expires after 7 days.
4. Publisher ID: Developer Dashboard → **Publisher settings**.
5. Repo secrets: `CWS_PUBLISHER_ID`, `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`,
   `CWS_REFRESH_TOKEN` (item ID defaults to
   `jhhlaaiegmdmjeeiopmdmoiidnbbhbmd`; override with `CWS_ITEM_ID`).

**The Chrome API cannot make the first submission.** It always publishes with
the item's existing visibility settings and refuses until the item has been
published manually once with those settings — so `-Target chrome` only works
with `-CheckOnly` until PDF Scholar is live in the Chrome Web Store. Set the
secrets up when it is; the workflow is ready.

Two more Chrome rules the script surfaces as errors rather than guesses:
`skipReview` covers only eligible changes (and never an item that has been
warned), and the manifest version must increase on every upload. To pull a
pending submission back, `:cancelSubmission` is the endpoint — the dashboard's
own cancel does the same thing.

---

## Listing assets checklist (shared)

- [x] Screenshots 1280×800: `docs/store-screenshots/` (built by `npm run shoot:store`)
- [x] Extension logo 300×300 + small promo tile 440×280: `docs/store-assets/`
  (regenerate with `npm run icons:store` after any icon change — these are
  uploaded by hand in the dashboards, which is how the Edge listing kept the
  pre-v0.25.4 scroll logo long after the shipped icons moved on)
- [x] Store icon: `build/icon.png` (512×512) works everywhere
- [x] Short description (NO + EN): `docs/STORE-LISTING.md`
