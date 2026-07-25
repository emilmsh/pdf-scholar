<#
.SYNOPSIS
  Publish the built MSIX packages to the Microsoft Store, programmatically.

.DESCRIPTION
  Drives the (legacy) Microsoft Store submission API - the ONLY submission API
  that accepts MSIX/appx packages (the newer "Store submission API" is MSI/EXE
  only). Works with an Individual Partner Center account: the account just needs
  an associated Azure AD directory (free to create in Partner Center) and an
  Azure AD app with the Manager role. See docs/STORE.md -> "Automated Store
  publishing" for the one-time setup that produces the three secrets below.

  Flow: token -> read app -> (delete stale pending submission) -> create
  submission -> mark old packages PendingDelete + add the new ones + sync the
  listing copy (description, features, short description, release notes) from
  docs/STORE-LISTING-DESKTOP.md -> zip the appx files -> upload zip to the SAS
  URL -> PUT submission -> commit -> poll status.

  The listing doc is the single source of truth for the copy: a new submission
  clones the LAST PUBLISHED one, so without this sync every API submission
  would silently re-publish whatever text was live when it was created, and
  editing it afterwards in the UI is forbidden (see below). Screenshots are NOT
  synced - they carry over from the cloned submission untouched.

  IMPORTANT (API rule): once a submission is created/edited through this API, do
  NOT edit it in the Partner Center UI - that severs API control of it. It's API
  OR UI per submission, never both.

  STATUS: UNTESTED end-to-end - it cannot run until the Azure AD app + secrets
  exist. Treat the FIRST real run as a validation run and expect to adjust field
  names against the live API responses (they are logged on failure).

.NOTES
  Requires: PowerShell 7+ (uses ConvertTo-Json -Depth and Invoke-RestMethod).
  Secrets are read from env vars so nothing sensitive is passed on the command
  line or written to disk.
#>
[CmdletBinding()]
param(
  # 12-char Store ID (Partner Center -> Product identity). This is the
  # applicationId the API expects. Matches config/electron-builder.store.yml.
  [string] $AppId = '9N75CPC0G9M2',

  # Folder holding the freshly built appx files (npm run dist:store output).
  # Blank = <repo>/release (resolved in the body - see the note there).
  [string] $ReleaseDir,

  # "What's new in this version" text. Blank = the release-notes block for this
  # version from the listing doc. Max 1500 chars per the Store.
  [string] $WhatsNew = '',

  # Paste-ready listing copy. Parsed, not mirrored into JSON, so there is one
  # place to edit and no second copy to drift. Blank = the desktop listing doc.
  [string] $ListingDoc,

  # Push packages and release notes only, leaving the live description, features
  # and short description exactly as the cloned submission had them.
  [switch] $SkipListingSync,

  # Delete an existing pending (uncommitted) submission instead of aborting.
  [switch] $ReplacePending,

  # Dry run: authenticate, read the app and parse the listing doc, then exit
  # WITHOUT creating or touching any submission. Validates both the three
  # secrets and the copy that would be sent, without disturbing a submission
  # that is already in certification.
  [switch] $CheckOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# --- secrets (env) --------------------------------------------------------
$tenantId     = $env:STORE_TENANT_ID
$clientId     = $env:STORE_CLIENT_ID
$clientSecret = $env:STORE_CLIENT_SECRET
if (-not $tenantId -or -not $clientId -or -not $clientSecret) {
  throw 'Missing STORE_TENANT_ID / STORE_CLIENT_ID / STORE_CLIENT_SECRET env vars. See docs/STORE.md.'
}

$apiBase = 'https://manage.devcenter.microsoft.com/v1.0/my'

# Paths are resolved here rather than as param defaults: PowerShell evaluates
# defaults before $PSScriptRoot is set, so a default built from it comes out
# empty (silently, in the case of Join-Path with a real second component).
$repoRoot = Split-Path $PSScriptRoot -Parent
if (-not $ReleaseDir)  { $ReleaseDir  = Join-Path $repoRoot 'release' }
if (-not $ListingDoc)  { $ListingDoc  = Join-Path $repoRoot 'docs/STORE-LISTING-DESKTOP.md' }

# Read the app version so we can name the packages and default the release note.
$version = (Get-Content (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json).version

# --- 0. listing copy from docs/STORE-LISTING-DESKTOP.md -------------------
# Parsed FIRST, before secrets and before the network: bad copy should fail
# instantly and locally, not after authenticating. scripts/test-store-listing.ps1
# checks this same code with no credentials at all.
. (Join-Path $PSScriptRoot 'lib' 'store-listing.ps1')

# Did the caller hand us one explicit note? Then it applies to every language,
# because that is what they asked for. Otherwise each listing gets the release
# notes in ITS OWN language from the doc - the live listing has both en-us and
# no, and sending the English block to both would silently replace the
# Norwegian notes with English ones.
$whatsNewExplicit = [bool]$WhatsNew

$listingCopy = $null
if (-not $SkipListingSync) {
  $listingCopy = Get-StoreListingCopy -ListingDoc $ListingDoc -Version $version `
    -AllowStaleNotes:$whatsNewExplicit
  if (-not $WhatsNew) { $WhatsNew = $listingCopy['EN'].releaseNotes }
}
if (-not $WhatsNew) { $WhatsNew = "PDF Scholar $version" }

# Locate the two appx files for this version (not needed for a -CheckOnly run).
if (-not $CheckOnly) {
  $appxFiles = Get-ChildItem -Path $ReleaseDir -Filter "PDF-Scholar-$version-*.appx" -ErrorAction SilentlyContinue
  if ($appxFiles.Count -lt 1) {
    throw "No PDF-Scholar-$version-*.appx found in $ReleaseDir. Run 'npm run dist:store' first."
  }
  Write-Host "Found $($appxFiles.Count) package(s) for v${version}: $($appxFiles.Name -join ', ')"
}

# --- 1. access token ------------------------------------------------------
Write-Host 'Requesting Azure AD access token...'
$token = (Invoke-RestMethod -Method Post `
  -Uri "https://login.microsoftonline.com/$tenantId/oauth2/token" `
  -ContentType 'application/x-www-form-urlencoded' `
  -Body @{
    grant_type    = 'client_credentials'
    client_id     = $clientId
    client_secret = $clientSecret
    resource      = 'https://manage.devcenter.microsoft.com'
  }).access_token
$headers = @{ Authorization = "Bearer $token" }

# --- 2. read the app ------------------------------------------------------
Write-Host "Reading application $AppId..."
$app = Invoke-RestMethod -Method Get -Uri "$apiBase/applications/$AppId" -Headers $headers

if ($CheckOnly) {
  $hasPending = ($app.PSObject.Properties.Name -contains 'pendingApplicationSubmission' -and $app.pendingApplicationSubmission)
  Write-Host ''
  Write-Host '=== Auth + app check (dry run - no submission created) ==='
  Write-Host "  App name:  $($app.primaryName)"
  Write-Host "  App id:    $($app.id)"
  Write-Host "  Pending submission: $(if ($hasPending) { $app.pendingApplicationSubmission.id } else { 'none' })"
  if ($app.PSObject.Properties.Name -contains 'lastPublishedApplicationSubmission' -and $app.lastPublishedApplicationSubmission) {
    Write-Host "  Last published submission: $($app.lastPublishedApplicationSubmission.id)"
  }
  Write-Host ''
  if ($listingCopy) {
    Write-Host '=== Listing copy that WOULD be sent (parsed, not sent) ==='
    foreach ($lang in ($listingCopy.Keys | Sort-Object)) {
      $c = $listingCopy[$lang]
      Write-Host "  [$lang] description $($c.description.Length) chars, first line:"
      Write-Host "        $(($c.description -split '\r?\n')[0])"
      Write-Host "  [$lang] short ($($c.shortDescription.Length) chars): $($c.shortDescription)"
      Write-Host "  [$lang] release notes $($c.releaseNotes.Length) chars, $(($c.releaseNotes -split '\r?\n').Count) bullets"
      Write-Host "  [$lang] $($c.features.Count) product features, longest $(($c.features | Measure-Object -Property Length -Maximum).Maximum) chars"
    }
    Write-Host ''
  } else {
    Write-Host '  Listing sync: SKIPPED (-SkipListingSync)'
    Write-Host ''
  }

  # Read the LAST PUBLISHED submission (a GET - it creates nothing) to see the
  # live listing as the API models it. Two things this answers that guessing
  # cannot: the exact shape of the images array (screenshots are not synced yet,
  # and the schema for doing so is right here rather than in the docs), and
  # whether the copy we would send actually DIFFERS from what is live - i.e.
  # whether a submission would change anything at all.
  if ($app.PSObject.Properties.Name -contains 'lastPublishedApplicationSubmission' -and $app.lastPublishedApplicationSubmission) {
    $lastId = $app.lastPublishedApplicationSubmission.id
    Write-Host "=== Live listing, read from published submission $lastId ==="
    $live = Invoke-RestMethod -Method Get -Headers $headers `
      -Uri "$apiBase/applications/$AppId/submissions/$lastId"

    $norm = { param($s) if ($null -eq $s) { '' } else { ($s -replace "`r", '').Trim() } }
    foreach ($listing in $live.listings.PSObject.Properties) {
      $base = $listing.Value.baseListing
      if (-not $base) { continue }
      Write-Host "  listing '$($listing.Name)'"
      Write-Host "    baseListing fields: $(($base.PSObject.Properties.Name | Sort-Object) -join ', ')"

      # Screenshots: what is live, and the property names we would have to set
      $images = @()
      if ($base.PSObject.Properties.Name -contains 'images' -and $base.images) { $images = @($base.images) }
      Write-Host "    images: $($images.Count)"
      if ($images.Count -gt 0) {
        Write-Host "    image fields: $(($images[0].PSObject.Properties.Name | Sort-Object) -join ', ')"
        foreach ($img in $images) {
          $type = '?'; $file = '?'; $desc = ''
          if ($img.PSObject.Properties.Name -contains 'imageType') { $type = $img.imageType }
          if ($img.PSObject.Properties.Name -contains 'fileName') { $file = $img.fileName }
          if ($img.PSObject.Properties.Name -contains 'description') { $desc = $img.description }
          Write-Host "      - $type  $file  $desc"
        }
      }

      # Would a sync change anything? Compare field by field, ignoring line
      # endings (the doc is checked out with CRLF on Windows, LF in CI).
      if ($listingCopy) {
        $c = $listingCopy[(Get-CopyLang $listing.Name)]
        $notes = $c.releaseNotes
        if ($whatsNewExplicit) { $notes = $WhatsNew }
        foreach ($pair in @(
          @{ name = 'description';      new = $c.description },
          @{ name = 'shortDescription'; new = $c.shortDescription },
          @{ name = 'releaseNotes';     new = $notes }
        )) {
          if ($base.PSObject.Properties.Name -notcontains $pair.name) {
            Write-Host "    $($pair.name): NOT MODELLED by the API here"
            continue
          }
          $before = & $norm $base.($pair.name)
          $after  = & $norm $pair.new
          if ($before -eq $after) { Write-Host "    $($pair.name): unchanged" }
          else { Write-Host "    $($pair.name): WOULD CHANGE ($($before.Length) -> $($after.Length) chars)" }
        }
        $liveFeat = @()
        if ($base.PSObject.Properties.Name -contains 'features' -and $base.features) { $liveFeat = @($base.features) }
        if (($liveFeat -join "`n") -eq ($c.features -join "`n")) { Write-Host '    features: unchanged' }
        else { Write-Host "    features: WOULD CHANGE ($($liveFeat.Count) -> $($c.features.Count) items)" }
      }
    }
    Write-Host ''
  }
  Write-Host 'Credentials work end-to-end. Exiting without any changes.'
  return
}

# --- 3. clear any stale pending submission --------------------------------
if ($app.PSObject.Properties.Name -contains 'pendingApplicationSubmission' -and $app.pendingApplicationSubmission) {
  $pendingId = $app.pendingApplicationSubmission.id
  if (-not $ReplacePending) {
    throw "A pending submission ($pendingId) already exists. Commit/discard it in Partner Center, or re-run with -ReplacePending."
  }
  Write-Host "Deleting stale pending submission $pendingId..."
  Invoke-RestMethod -Method Delete -Uri "$apiBase/applications/$AppId/submissions/$pendingId" -Headers $headers | Out-Null
}

# --- 4. create a new submission (clones the last published one) -----------
Write-Host 'Creating a new submission...'
$submission = Invoke-RestMethod -Method Post -Uri "$apiBase/applications/$AppId/submissions" -Headers $headers
$submissionId = $submission.id
$uploadUrl    = $submission.fileUploadUrl
Write-Host "Submission $submissionId created."

# --- 5. edit the submission payload ---------------------------------------
# Retire every package carried over from the previous submission...
foreach ($pkg in $submission.applicationPackages) { $pkg.fileStatus = 'PendingDelete' }

# ...and add the new appx files (the Store reads arch/version from the manifest).
$submission.applicationPackages = @($submission.applicationPackages) + @(
  $appxFiles | ForEach-Object {
    [pscustomobject]@{ fileName = $_.Name; fileStatus = 'PendingUpload' }
  }
)

# Sync the copy onto every existing listing language. Only fields the cloned
# submission already carries are written: the legacy API silently ignores
# unknown members, so assigning a field it does not model would look like it
# worked and change nothing. A missing one is reported instead.
#
# NOTE: screenshots (.images) are deliberately NOT synced - they carry over from
# the cloned submission, and Partner Center is a better place to judge them than
# a script. docs/store-screenshots/ holds the 1280x800 files to upload by hand.
foreach ($listing in $submission.listings.PSObject.Properties) {
  $base = $listing.Value.baseListing
  if (-not $base) { continue }
  $fields = @{ releaseNotes = $WhatsNew }
  if ($listingCopy) {
    $c = $listingCopy[(Get-CopyLang $listing.Name)]
    $notes = $c.releaseNotes
    if ($whatsNewExplicit) { $notes = $WhatsNew }
    $fields = @{
      description      = $c.description
      releaseNotes     = $notes
      shortDescription = $c.shortDescription
      features         = $c.features
    }
  }
  foreach ($name in $fields.Keys) {
    if ($base.PSObject.Properties.Name -contains $name) {
      $base.$name = $fields[$name]
    } else {
      Write-Warning "Listing '$($listing.Name)' has no '$name' field - left unset (API model differs from expectation)."
    }
  }
  Write-Host "  listing $($listing.Name): synced $($fields.Keys.Count) field(s) from $(Split-Path $ListingDoc -Leaf)"
}

# --- 6. zip the appx files (flat, names must match fileName above) --------
$zipPath = Join-Path $ReleaseDir 'store-upload.zip'
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Write-Host "Zipping packages -> $zipPath"
Compress-Archive -Path ($appxFiles.FullName) -DestinationPath $zipPath -Force

# --- 7. upload the zip to the SAS URL -------------------------------------
Write-Host 'Uploading package zip to the Store blob...'
Invoke-RestMethod -Method Put -Uri $uploadUrl `
  -Headers @{ 'x-ms-blob-type' = 'BlockBlob' } `
  -InFile $zipPath -ContentType 'application/zip' | Out-Null

# --- 8. PUT the updated submission ----------------------------------------
Write-Host 'Saving submission changes...'
$body = $submission | ConvertTo-Json -Depth 30
Invoke-RestMethod -Method Put -Uri "$apiBase/applications/$AppId/submissions/$submissionId" `
  -Headers $headers -ContentType 'application/json' -Body $body | Out-Null

# --- 9. commit ------------------------------------------------------------
Write-Host 'Committing submission...'
Invoke-RestMethod -Method Post -Uri "$apiBase/applications/$AppId/submissions/$submissionId/commit" -Headers $headers | Out-Null

# --- 10. poll status ------------------------------------------------------
Write-Host 'Waiting for commit to finish...'
do {
  Start-Sleep -Seconds 30
  $status = Invoke-RestMethod -Method Get `
    -Uri "$apiBase/applications/$AppId/submissions/$submissionId/status" -Headers $headers
  Write-Host "  status: $($status.status)"
} while ($status.status -eq 'CommitStarted')

if ($status.status -eq 'CommitFailed' -or $status.status -eq 'PreProcessingFailed') {
  $status | ConvertTo-Json -Depth 20 | Write-Host
  throw "Store commit failed: $($status.status)"
}

Write-Host "Done. Submission $submissionId is now '$($status.status)' - certification proceeds in Partner Center (1-3 days)."
