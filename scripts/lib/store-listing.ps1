# Parse the paste-ready Store listing copy out of docs/STORE-LISTING-DESKTOP.md.
#
# Dot-sourced by scripts/store-publish.ps1, and by scripts/test-store-listing.ps1
# which checks it without any credentials or network. Kept in its own file for
# exactly that reason: the parsing is the part most likely to break (someone
# edits the doc's shape) and the part least able to be tested through the API.
#
# Deliberately Windows-PowerShell-compatible (no 3-arg Join-Path, no ternary, no
# ??) so the test runs anywhere, even though store-publish.ps1 itself needs PS7.
#
# The doc's shape: a heading, then '**EN:**' / '**NO:**' either followed by a
# fenced block (multi-line fields) or with the text inline on the same line (the
# short description). We parse instead of mirroring into JSON - a mirror is a
# second copy of the copy, and the two would drift.

function Get-DocSection {
  param(
    [Parameter(Mandatory)] [string] $Markdown,
    [Parameter(Mandatory)] [string] $HeadingStartsWith
  )
  # Everything from that heading up to the next heading of any level
  $rx = '(?m)^#{2,3} ' + [regex]::Escape($HeadingStartsWith) + '[^\r\n]*[\r\n]+(?<body>.*?)(?=[\r\n]#{2,3} |\z)'
  $m = [regex]::Match($Markdown, $rx, 'Singleline')
  if (-not $m.Success) { throw "Listing doc: no section starting '$HeadingStartsWith'" }
  return $m.Groups['body'].Value
}

function Get-FencedBlock {
  param(
    [Parameter(Mandatory)] [string] $Section,
    [Parameter(Mandatory)] [string] $Lang
  )
  $rx = '\*\*' + $Lang + ':\*\*\s*[\r\n]+```[\r\n]+(?<body>.*?)[\r\n]+```'
  $m = [regex]::Match($Section, $rx, 'Singleline')
  if (-not $m.Success) { throw "Listing doc: no fenced $Lang block in section" }
  return $m.Groups['body'].Value.Trim()
}

function Get-InlineValue {
  param(
    [Parameter(Mandatory)] [string] $Section,
    [Parameter(Mandatory)] [string] $Lang
  )
  $m = [regex]::Match($Section, '\*\*' + $Lang + ':\*\*[ \t]*(?<body>[^\r\n]+)')
  if (-not $m.Success) { throw "Listing doc: no inline $Lang value in section" }
  return $m.Groups['body'].Value.Trim()
}

<#
.SYNOPSIS
  Parse and validate the listing copy. Returns a hashtable keyed 'EN' / 'NO',
  each with description / releaseNotes / shortDescription / features.
.PARAMETER Version
  The package version being published. The doc's "What's new" heading is
  version-stamped, and a mismatch throws: shipping last version's release notes
  is the easiest mistake to make here and the hardest to notice afterwards.
.PARAMETER AllowStaleNotes
  Caller is supplying its own release notes, so the version stamp is moot.
#>
function Get-StoreListingCopy {
  param(
    [Parameter(Mandatory)] [string] $ListingDoc,
    [Parameter(Mandatory)] [string] $Version,
    [switch] $AllowStaleNotes
  )
  if (-not (Test-Path $ListingDoc)) { throw "Listing doc not found: $ListingDoc" }
  # -Encoding UTF8 explicitly: PowerShell 7 defaults to it, Windows PowerShell
  # defaults to ANSI. Without this the offline test (which runs under Windows
  # PowerShell) validated a mis-decoded copy, counting every aa/oe/ae and dash as
  # two characters - conservative, but not the text the API would receive.
  $md = Get-Content $ListingDoc -Raw -Encoding UTF8

  $notesHeading = [regex]::Match($md, '(?m)^## What''s new in this version[^\r\n]*?v(?<ver>\d+\.\d+)')
  if (-not $notesHeading.Success) {
    throw "Listing doc: the ""What's new"" heading must end with the version it describes (e.g. '- v$Version')."
  }
  $docMinor = $notesHeading.Groups['ver'].Value
  $pkgMinor = ($Version -split '\.')[0..1] -join '.'
  if ($docMinor -ne $pkgMinor -and -not $AllowStaleNotes) {
    throw "Listing doc's release notes are for v$docMinor.x but this build is $Version. Update the ""What's new"" section (and its heading), or pass -WhatsNew."
  }

  $descSection  = Get-DocSection -Markdown $md -HeadingStartsWith 'Description'
  $notesSection = Get-DocSection -Markdown $md -HeadingStartsWith "What's new in this version"
  $featSection  = Get-DocSection -Markdown $md -HeadingStartsWith 'Product features'
  $shortSection = Get-DocSection -Markdown $md -HeadingStartsWith 'Short / summary description'

  $copy = @{}
  foreach ($lang in @('EN', 'NO')) {
    $features = @()
    foreach ($line in ((Get-FencedBlock -Section $featSection -Lang $lang) -split '\r?\n')) {
      $trimmed = $line.Trim()
      if ($trimmed) { $features += $trimmed }
    }
    $copy[$lang] = @{
      description      = Get-FencedBlock -Section $descSection -Lang $lang
      releaseNotes     = Get-FencedBlock -Section $notesSection -Lang $lang
      shortDescription = Get-InlineValue -Section $shortSection -Lang $lang
      features         = $features
    }
  }

  # The Store's own limits. Better to fail here than to have the API reject a
  # submission whose packages are already uploaded.
  foreach ($lang in @($copy.Keys)) {
    $c = $copy[$lang]
    if ($c.description.Length -gt 10000) { throw "$lang description is $($c.description.Length) chars (max 10000)." }
    if ($c.releaseNotes.Length -gt 1500) { throw "$lang release notes are $($c.releaseNotes.Length) chars (max 1500)." }
    if ($c.features.Count -gt 20) { throw "$lang has $($c.features.Count) product features (max 20)." }
    foreach ($f in $c.features) {
      if ($f.Length -gt 200) { throw "$lang product feature over 200 chars: $f" }
    }
  }
  return $copy
}

# Store listing languages are BCP-47 ('en-us', 'nb-no'); the doc holds EN + NO.
function Get-CopyLang {
  param([Parameter(Mandatory)] [string] $StoreLang)
  if ($StoreLang -match '^(nb|nn|no)') { return 'NO' }
  return 'EN'
}
