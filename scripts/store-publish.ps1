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
  submission -> mark old packages PendingDelete + add the new ones + set release
  notes -> zip the appx files -> upload zip to the SAS URL -> PUT submission ->
  commit -> poll status.

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
  [string] $ReleaseDir = (Join-Path $PSScriptRoot '..' 'release'),

  # "What's new in this version" text. Defaults to the current version string;
  # pass the release-notes block from docs/STORE-LISTING-DESKTOP.md for a proper
  # note. Max 1500 chars per the Store.
  [string] $WhatsNew = '',

  # Delete an existing pending (uncommitted) submission instead of aborting.
  [switch] $ReplacePending,

  # Dry run: authenticate and read the app, then exit WITHOUT creating or
  # touching any submission. Use this to validate the three secrets without
  # disturbing a submission that is already in certification.
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

# Read the app version so we can name the packages and default the release note.
$version = (Get-Content (Join-Path $PSScriptRoot '..' 'package.json') -Raw | ConvertFrom-Json).version
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

# Set "what's new" on every existing listing language.
foreach ($listing in $submission.listings.PSObject.Properties) {
  if ($listing.Value.baseListing) {
    $listing.Value.baseListing.releaseNotes = $WhatsNew
  }
}
# NOTE: full description/screenshot sync is intentionally left to the Partner
# Center UI for now. To automate it later, set
# $submission.listings.<lang>.baseListing.description (and .images) here from a
# structured source (e.g. a JSON mirror of docs/STORE-LISTING-DESKTOP.md).

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
