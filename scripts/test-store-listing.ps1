# Check that the Store listing copy still parses out of the doc, with no
# credentials and no network.
#
#   npm run test:listing
#
# store-publish.ps1 sends whatever this returns straight to a live Store
# listing, and a submission created through the API must not be corrected in the
# Partner Center UI afterwards - so a parse that silently returns the wrong text
# is expensive. This runs the real parser (scripts/lib/store-listing.ps1) against
# the real doc and asserts the shape, not just that it didn't throw.
[CmdletBinding()]
param(
  [string] $ListingDoc,
  [string] $PackageJson
)

$ErrorActionPreference = 'Stop'
# Resolved in the body, not as a param default: Windows PowerShell evaluates
# defaults before $PSScriptRoot is set, so a default built from it is empty.
$root = Split-Path $PSScriptRoot -Parent
if (-not $ListingDoc)  { $ListingDoc  = Join-Path $root 'docs\STORE-LISTING-DESKTOP.md' }
if (-not $PackageJson) { $PackageJson = Join-Path $root 'package.json' }
. (Join-Path $PSScriptRoot 'lib\store-listing.ps1')

$script:failures = 0
function Check {
  param([string] $Label, [bool] $Ok, [string] $Detail = '')
  $tag = 'PASS'
  if (-not $Ok) { $tag = 'FAIL'; $script:failures++ }
  $suffix = ''
  if ($Detail) { $suffix = "  ($Detail)" }
  Write-Host "$tag  $Label$suffix"
}

$version = (Get-Content $PackageJson -Raw | ConvertFrom-Json).version
Write-Host "Listing doc: $(Split-Path $ListingDoc -Leaf), package version $version`n"

# 1. the doc parses for the version we would actually publish
$copy = $null
try {
  $copy = Get-StoreListingCopy -ListingDoc $ListingDoc -Version $version
  Check "parses for v$version" $true
} catch {
  Check "parses for v$version" $false $_.Exception.Message
}

if ($copy) {
  foreach ($lang in @('EN', 'NO')) {
    $c = $copy[$lang]
    Check "$lang description present" ($c.description.Length -gt 500) "$($c.description.Length) chars"
    Check "$lang description has no markdown fence left in it" (-not $c.description.Contains('```'))
    Check "$lang short description within 250" ($c.shortDescription.Length -le 250) "$($c.shortDescription.Length) chars"
    Check "$lang release notes present" ($c.releaseNotes.Length -gt 50) "$($c.releaseNotes.Length) chars"
    Check "$lang features parsed as separate items" ($c.features.Count -ge 10) "$($c.features.Count) items"
    $longest = ($c.features | Measure-Object -Property Length -Maximum).Maximum
    Check "$lang longest feature within 200" ($longest -le 200) "$longest chars"
    # A bullet character surviving into features means the fenced block was
    # mis-sliced: the description uses bullets, the feature list does not.
    # (Written as a char code, not a literal - see the ASCII note in the lib.)
    Check "$lang features are not description bullets" (-not ($c.features | Where-Object { $_.StartsWith(([char]0x2022)) }))
  }
  # The two languages must be genuinely different text, not the same block
  # matched twice by a too-greedy regex - the failure mode that would publish
  # English copy into a Norwegian listing.
  Check 'EN and NO are different text' ($copy['EN'].description -ne $copy['NO'].description)
  Check 'NO description is actually Norwegian' ($copy['NO'].description -match 'kildekode|dokument|leser')
  Check 'EN description is actually English' ($copy['EN'].description -match 'open source|document|reader')
}

# 2. the version stamp guard actually fires (this is the guard that stops last
#    version's release notes going out with this version's packages)
try {
  Get-StoreListingCopy -ListingDoc $ListingDoc -Version '99.99.0' | Out-Null
  Check 'stale release notes are rejected' $false 'no error thrown for v99.99.0'
} catch {
  Check 'stale release notes are rejected' ($_.Exception.Message -match "release notes are for")
}

# 3. ...and can be overridden when the caller supplies its own notes
try {
  Get-StoreListingCopy -ListingDoc $ListingDoc -Version '99.99.0' -AllowStaleNotes | Out-Null
  Check '-AllowStaleNotes bypasses the version stamp' $true
} catch {
  Check '-AllowStaleNotes bypasses the version stamp' $false $_.Exception.Message
}

# 4. language mapping used to pick copy per Store listing
Check 'en-us maps to EN' ((Get-CopyLang 'en-us') -eq 'EN')
Check 'nb-no maps to NO' ((Get-CopyLang 'nb-no') -eq 'NO')
Check 'de-de falls back to EN' ((Get-CopyLang 'de-de') -eq 'EN')

Write-Host ''
if ($script:failures) {
  Write-Host "$($script:failures) check(s) failed."
  exit 1
}
Write-Host 'All checks passed.'
