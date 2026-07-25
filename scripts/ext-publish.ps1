<#
.SYNOPSIS
  Publish the built browser-extension zip to Edge Add-ons and/or the Chrome Web
  Store, programmatically.

.DESCRIPTION
  The extension half of the store pipeline (scripts/store-publish.ps1 is the
  MSIX/desktop half - different API, different artifact, same idioms: env-var
  secrets, -CheckOnly dry run, manual dispatch).

  Both stores take the SAME artifact: release/pdf-scholar-extension-store.zip
  (manifest.json at the zip root - `npm run pack:ext:store`). Neither API can
  touch listing copy, screenshots or permission justifications; those stay
  manual in the dashboards. This script uploads a package and submits it for
  review, nothing else.

  Edge Add-ons API v1.1 (docs: microsoft-edge/extensions/update/api):
    POST /v1/products/$id/submissions/draft/package        (zip body) -> 202 + Location: operationId
    GET  /v1/products/$id/submissions/draft/package/operations/$op    -> InProgress|Succeeded|Failed
    POST /v1/products/$id/submissions                      ({notes})  -> 202 + Location: operationId
    GET  /v1/products/$id/submissions/operations/$op                  -> InProgress|Succeeded|Failed
  Auth is two headers (ApiKey + X-ClientID) - no OAuth dance. v1.1 kept the /v1/
  paths; only the auth scheme changed.

  Chrome Web Store API v2 (docs: developer.chrome.com/docs/webstore/using-api):
    POST https://oauth2.googleapis.com/token                (refresh_token grant)
    POST /upload/v2/publishers/$pub/items/$item:upload      (zip body)
    POST /v2/publishers/$pub/items/$item:publish            ({publishType, skipReview})
    GET  /v2/publishers/$pub/items/$item:fetchStatus

  CHROME CAVEAT (why this cannot be the first submission): the API always
  publishes with the item's existing visibility settings, and refuses until the
  item has been published manually at least once with those settings. Until
  PDF Scholar is live in the Chrome Web Store, -Target chrome only works with
  -CheckOnly.

  Secrets, as env vars (repo secrets of the same name in CI):
    Edge    EDGE_CLIENT_ID, EDGE_API_KEY
            Partner Center -> Microsoft Edge -> Publish API -> Create API
            credentials (the key EXPIRES - the page shows the date). The product
            ID is not a secret and is defaulted below (EDGE_PRODUCT_ID overrides).
    Chrome  CWS_PUBLISHER_ID, CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN
            Publisher ID: Developer Dashboard -> Publisher settings. The OAuth
            client + refresh token come from a Google Cloud project with the
            Chrome Web Store API enabled (see docs/STORE.md).

  Anything missing fails fast, before the network.
#>
param(
  # Which store(s) to push to.
  [ValidateSet('edge', 'chrome', 'all')]
  [string] $Target = 'all',

  # The store-shaped zip. Blank = <repo>/release/pdf-scholar-extension-store.zip
  # (resolved in the body - see the note in store-publish.ps1 about $PSScriptRoot
  # not being available in param defaults).
  [string] $Zip,

  # Notes for the Edge certification team. Blank = a one-liner naming the
  # version. Chrome's API has no equivalent field.
  [string] $Notes = '',

  # Chrome only: ask to skip review. Eligible changes only - and an item that has
  # been warned or rejected for a policy violation is NOT eligible, so leave this
  # off unless you know the change qualifies.
  [switch] $SkipReview,

  # Dry run: verify credentials and the zip, create/submit NOTHING. Safe while a
  # version is in review.
  [switch] $CheckOnly,

  # Per-operation polling budget.
  [int] $TimeoutMinutes = 10
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path $PSScriptRoot -Parent
if (-not $Zip) { $Zip = Join-Path $repoRoot 'release/pdf-scholar-extension-store.zip' }

$edgeApi = 'https://api.addons.microsoftedge.microsoft.com'
$cwsApi = 'https://chromewebstore.googleapis.com'

# --- helpers --------------------------------------------------------------

# 4xx/5xx bodies land in different places in Windows PowerShell 5.1 (exception
# response stream) and pwsh 7 (ErrorDetails). Both carry the reason the store
# rejected us, so dig them both out rather than reporting a bare status code.
function Get-HttpErrorBody($err) {
  if ($err.ErrorDetails -and $err.ErrorDetails.Message) { return $err.ErrorDetails.Message }
  try {
    $stream = $err.Exception.Response.GetResponseStream()
    $reader = New-Object System.IO.StreamReader($stream)
    return $reader.ReadToEnd()
  } catch { return $err.Exception.Message }
}

function Get-HttpStatus($err) {
  try { return [int]$err.Exception.Response.StatusCode } catch { return 0 }
}

# Header values are a plain string in 5.1 and a collection in pwsh 7.
function Get-HeaderValue($response, [string] $name) {
  if (-not $response.Headers.ContainsKey($name)) { return '' }
  $value = $response.Headers[$name]
  if ($value -is [array]) { return $value[0] }
  return $value
}

# Set-StrictMode makes a missing property a hard error, and these APIs omit
# fields freely (no `errors` on success, no `warningInfo` when there are none).
function Get-Prop($object, [string] $name) {
  if ($null -eq $object) { return $null }
  if ($object.PSObject.Properties.Name -contains $name) { return $object.$name }
  return $null
}

function Format-OperationError($state) {
  $parts = @((Get-Prop $state 'message'), (Get-Prop $state 'errorCode'))
  $errors = Get-Prop $state 'errors'
  if ($errors) { $parts += ($errors | ForEach-Object { if ($_ -is [string]) { $_ } else { Get-Prop $_ 'message' } }) }
  return (($parts | Where-Object { $_ }) -join ' | ')
}

# --- 0. the artifact ------------------------------------------------------
# Validate the zip BEFORE authenticating: a folder-wrapped zip, a stale version
# or backslash entry names all cost a full review cycle if they reach a store,
# and all three are invisible in the dashboard until the reviewer trips over
# them. (Windows' built-in zip tools write backslashes - hence scripts/lib/zip.mjs.)
if (-not (Test-Path $Zip)) {
  throw "Zip not found: $Zip. Run 'npm run build:ext; npm run pack:ext:store' first."
}

$appVersion = (Get-Content (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json).version

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path $Zip).Path)
try {
  $manifestEntry = $archive.GetEntry('manifest.json')
  if (-not $manifestEntry) {
    throw "$Zip has no manifest.json at its root - that is the Load-unpacked zip, not the store one. Use 'npm run pack:ext:store'."
  }
  $backslashed = @($archive.Entries | Where-Object { $_.FullName -like '*\*' }).Count
  if ($backslashed -gt 0) {
    throw "$Zip has $backslashed entry name(s) with backslash separators - store uploaders mis-parse those. Rebuild with 'npm run pack:ext:store'."
  }
  $reader = New-Object System.IO.StreamReader($manifestEntry.Open())
  $manifest = $reader.ReadToEnd() | ConvertFrom-Json
  $reader.Close()
  $entryCount = $archive.Entries.Count
} finally {
  $archive.Dispose()
}

if ($manifest.version -ne $appVersion) {
  throw "Version mismatch: zip manifest says $($manifest.version), package.json says $appVersion. Rebuild the extension ('npm run build:ext') so the stamped version matches."
}

$sizeMb = [math]::Round((Get-Item $Zip).Length / 1MB, 2)
Write-Host "Package: $Zip"
Write-Host "  v$($manifest.version), $entryCount files, $sizeMb MB"
Write-Host "  permissions: $((Get-Prop $manifest 'permissions') -join ', ')"
Write-Host "  host_permissions: $((Get-Prop $manifest 'host_permissions') -join ', ')"
Write-Host ''

if (-not $Notes) { $Notes = "PDF Scholar $appVersion" }

$doEdge = $Target -in @('edge', 'all')
$doChrome = $Target -in @('chrome', 'all')
$summary = [ordered]@{}

# --- 1. Edge Add-ons ------------------------------------------------------
if ($doEdge) {
  # The product ID is an identifier, not a credential (Partner Center shows it in
  # the dashboard URL), so it lives here rather than in a secret - same call as
  # the Chrome item ID below. EDGE_PRODUCT_ID overrides it.
  $productId = if ($env:EDGE_PRODUCT_ID) { $env:EDGE_PRODUCT_ID } else { '2d23581d-291e-4953-aaf1-0db8715d42ad' }
  $clientId = $env:EDGE_CLIENT_ID
  $apiKey = $env:EDGE_API_KEY
  if (-not $clientId -or -not $apiKey) {
    throw 'Missing EDGE_CLIENT_ID / EDGE_API_KEY env vars (Partner Center -> Microsoft Edge -> Publish API). See docs/STORE.md -> "Automated extension publishing".'
  }

  $edgeHeaders = @{ Authorization = "ApiKey $apiKey"; 'X-ClientID' = $clientId }

  if ($CheckOnly) {
    # There is no "read the product" endpoint - every GET needs an operation ID
    # from a POST we are deliberately not making. So probe with a nil operation
    # ID and read the status code: 404 means the credentials were accepted and
    # only the operation is unknown; 401/403 means the credentials are wrong.
    Write-Host 'Edge: checking credentials (nil-operation probe, nothing submitted)...'
    $probe = "$edgeApi/v1/products/$productId/submissions/draft/package/operations/00000000-0000-0000-0000-000000000000"
    try {
      Invoke-WebRequest -Method Get -Uri $probe -Headers $edgeHeaders -UseBasicParsing | Out-Null
      $summary['Edge'] = 'credentials OK (probe unexpectedly succeeded)'
    } catch {
      $status = Get-HttpStatus $_
      if ($status -eq 404) {
        $summary['Edge'] = 'credentials OK (404 on the nil operation, as expected)'
      } elseif ($status -in @(401, 403)) {
        throw "Edge credentials rejected (HTTP $status). Renew the API key in Partner Center -> Publish API. Body: $(Get-HttpErrorBody $_)"
      } else {
        throw "Edge probe failed (HTTP $status): $(Get-HttpErrorBody $_). EDGE_PRODUCT_ID and EDGE_CLIENT_ID are both GUIDs - check they are not swapped or truncated."
      }
    }
    Write-Host "  $($summary['Edge'])"
  } else {
    Write-Host 'Edge: uploading package to the draft submission...'
    try {
      $response = Invoke-WebRequest -Method Post -Uri "$edgeApi/v1/products/$productId/submissions/draft/package" `
        -Headers $edgeHeaders -ContentType 'application/zip' -InFile $Zip -UseBasicParsing
    } catch {
      throw "Edge package upload failed (HTTP $(Get-HttpStatus $_)): $(Get-HttpErrorBody $_)"
    }
    $operationId = Get-HeaderValue $response 'Location'
    if (-not $operationId) { throw 'Edge upload returned no Location header (no operation id to poll).' }
    Write-Host "  accepted, operation $operationId"

    # The upload is processed asynchronously: validation failures (bad manifest,
    # version not incremented) surface HERE, not in the 202 above.
    $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
    $status = 'InProgress'
    while ($status -eq 'InProgress') {
      if ((Get-Date) -gt $deadline) { throw "Edge upload still InProgress after $TimeoutMinutes min (operation $operationId)." }
      Start-Sleep -Seconds 10
      $state = Invoke-RestMethod -Method Get -Headers $edgeHeaders `
        -Uri "$edgeApi/v1/products/$productId/submissions/draft/package/operations/$operationId"
      $status = Get-Prop $state 'status'
      Write-Host "  upload status: $status"
    }
    if ($status -ne 'Succeeded') { throw "Edge upload $status : $(Format-OperationError $state)" }

    Write-Host 'Edge: publishing the draft submission...'
    try {
      $response = Invoke-WebRequest -Method Post -Uri "$edgeApi/v1/products/$productId/submissions" `
        -Headers $edgeHeaders -ContentType 'application/json' `
        -Body (@{ notes = $Notes } | ConvertTo-Json -Compress) -UseBasicParsing
    } catch {
      throw "Edge publish failed (HTTP $(Get-HttpStatus $_)): $(Get-HttpErrorBody $_)"
    }
    $publishOp = Get-HeaderValue $response 'Location'
    $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
    $status = 'InProgress'
    while ($status -eq 'InProgress') {
      if ((Get-Date) -gt $deadline) { throw "Edge publish still InProgress after $TimeoutMinutes min (operation $publishOp)." }
      Start-Sleep -Seconds 10
      $state = Invoke-RestMethod -Method Get -Headers $edgeHeaders `
        -Uri "$edgeApi/v1/products/$productId/submissions/operations/$publishOp"
      $status = Get-Prop $state 'status'
      Write-Host "  publish status: $status"
    }
    # A publish can legitimately fail for reasons worth reading rather than
    # retrying: InProgressSubmission (something is already in review),
    # NoModulesUpdated (nothing changed), SubmissionValidationError.
    if ($status -ne 'Succeeded') { throw "Edge publish $status : $(Format-OperationError $state)" }
    $summary['Edge'] = "submitted for certification - $(Get-Prop $state 'message')"
  }
}

# --- 2. Chrome Web Store --------------------------------------------------
if ($doChrome) {
  $publisherId = $env:CWS_PUBLISHER_ID
  $itemId = if ($env:CWS_ITEM_ID) { $env:CWS_ITEM_ID } else { 'jhhlaaiegmdmjeeiopmdmoiidnbbhbmd' }
  $clientId = $env:CWS_CLIENT_ID
  $clientSecret = $env:CWS_CLIENT_SECRET
  $refreshToken = $env:CWS_REFRESH_TOKEN
  if (-not $publisherId -or -not $clientId -or -not $clientSecret -or -not $refreshToken) {
    throw 'Missing CWS_PUBLISHER_ID / CWS_CLIENT_ID / CWS_CLIENT_SECRET / CWS_REFRESH_TOKEN env vars. See docs/STORE.md -> "Automated extension publishing".'
  }

  Write-Host 'Chrome: refreshing the access token...'
  try {
    $token = (Invoke-RestMethod -Method Post -Uri 'https://oauth2.googleapis.com/token' `
      -ContentType 'application/x-www-form-urlencoded' `
      -Body @{
        client_id     = $clientId
        client_secret = $clientSecret
        refresh_token = $refreshToken
        grant_type    = 'refresh_token'
      }).access_token
  } catch {
    $body = Get-HttpErrorBody $_
    # invalid_grant is the expiry case worth calling out; invalid_client is just
    # a wrong client id/secret, and the 7-day note would only mislead there.
    $hint = if ($body -match 'invalid_grant') {
      ' A refresh token issued while the OAuth consent screen was in Testing mode expires after 7 days - set the app to In production and re-issue the token.'
    } else { '' }
    throw "Chrome token refresh failed (HTTP $(Get-HttpStatus $_)): $body$hint"
  }
  $cwsHeaders = @{ Authorization = "Bearer $token" }
  $item = "publishers/$publisherId/items/$itemId"

  Write-Host "Chrome: reading item status ($itemId)..."
  try {
    $state = Invoke-RestMethod -Method Get -Headers $cwsHeaders -Uri "$cwsApi/v2/${item}:fetchStatus"
  } catch {
    throw "Chrome fetchStatus failed (HTTP $(Get-HttpStatus $_)): $(Get-HttpErrorBody $_)"
  }
  Write-Host "  state: $($state | ConvertTo-Json -Compress -Depth 4)"

  if ($CheckOnly) {
    $summary['Chrome'] = "credentials OK - item state $($state | ConvertTo-Json -Compress -Depth 4)"
  } else {
    Write-Host 'Chrome: uploading package...'
    try {
      Invoke-RestMethod -Method Post -Uri "$cwsApi/upload/v2/${item}:upload" `
        -Headers $cwsHeaders -ContentType 'application/zip' -InFile $Zip | Out-Null
    } catch {
      throw "Chrome upload failed (HTTP $(Get-HttpStatus $_)): $(Get-HttpErrorBody $_)"
    }

    Write-Host "Chrome: publishing (skipReview: $([bool]$SkipReview))..."
    try {
      $published = Invoke-RestMethod -Method Post -Uri "$cwsApi/v2/${item}:publish" `
        -Headers $cwsHeaders -ContentType 'application/json' `
        -Body (@{ publishType = 'DEFAULT_PUBLISH'; skipReview = [bool]$SkipReview } | ConvertTo-Json -Compress)
    } catch {
      # The usual first-time failure: the API refuses to publish an item that has
      # never been published manually with its current visibility settings.
      throw "Chrome publish failed (HTTP $(Get-HttpStatus $_)): $(Get-HttpErrorBody $_)"
    }
    foreach ($warning in @(Get-Prop (Get-Prop $published 'warningInfo') 'warnings')) {
      if ($warning) { Write-Host "  warning: $(Get-Prop $warning 'reason') - $(Get-Prop $warning 'description')" }
    }
    $summary['Chrome'] = "submitted for review - state $(Get-Prop $published 'state')"
  }
}

# --- 3. summary -----------------------------------------------------------
Write-Host ''
Write-Host "=== $(if ($CheckOnly) { 'Dry run (nothing submitted)' } else { "Submitted v$appVersion" }) ==="
foreach ($key in $summary.Keys) { Write-Host "  ${key}: $($summary[$key])" }
if (-not $CheckOnly) {
  Write-Host ''
  Write-Host 'Listing copy, screenshots and permission justifications are NOT part of'
  Write-Host 'either API - check them in the dashboards if this version changed them.'
}
