#Requires -Version 5.1
<#
.SYNOPSIS
  Windows NSIS install/upgrade E2E for QianNing Agent.

.DESCRIPTION
  Discovers the newest stable GitHub Releases, verifies every downloaded
  installer against its published electron-updater feed, then installs the
  oldest tested release and upgrades it in place through the next stable
  releases to the candidate build from this release run.

  Every step asserts:
    * the installer bytes match latest.yml (size + base64 SHA-512);
    * the installed executable and the single HKCU uninstall entry report the
      feed's version;
    * the user data directory and %APPDATA% markers are byte-identical;
    * an optional launch probe leaves the candidate process running.

  The candidate is installed fresh once after the chain, so the gate covers
  both an upgrade and a clean install of the bytes about to be published.

.PARAMETER CurrentTag
  Candidate tag, e.g. v2.4.3.

.PARAMETER CurrentSetup
  The NSIS installer built by this run.

.PARAMETER CurrentFeed
  latest.yml built by this run; defaults to latest.yml beside CurrentSetup.

.PARAMETER PreviousCount
  Number of stable releases before the candidate to include. Default 3.

.PARAMETER PlanOnly
  Verify the candidate feed/hash and the previous stable discovery, print the
  chain, download no previous installer, install nothing. Safe locally.

.PARAMETER VerifyInstallers
  Download and hash-verify every previous installer in the chain, then stop
  before installing anything. Proves the published inputs, not the NSIS path.

.PARAMETER SkipLaunch
  Skip the final process launch probe. Install/upgrade assertions still run.

.PARAMETER Proxy
  Optional HTTP proxy for GitHub API and downloads, e.g.
  http://127.0.0.1:7890.

.EXAMPLE
  pwsh -File scripts/e2e/windows-install-upgrade.ps1 `
    -Repo Qian-Ning/QianNing-Agent -CurrentTag v2.4.3 `
    -CurrentSetup dist/QianNing-Agent-Setup-2.4.3.exe `
    -CurrentFeed dist/latest.yml -WorkDir C:\qn-upgrade
#>
[CmdletBinding()]
param(
  [string]$Repo = $env:GITHUB_REPOSITORY,
  [Parameter(Mandatory)][string]$CurrentTag,
  [Parameter(Mandatory)][string]$CurrentSetup,
  [string]$CurrentFeed,
  [string]$WorkDir,
  [int]$PreviousCount = 3,
  [switch]$PlanOnly,
  [switch]$VerifyInstallers,
  [switch]$SkipLaunch,
  [string]$Proxy
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$ProgressPreference = 'SilentlyContinue'

if (-not $Repo) { throw 'Repo is required (or set GITHUB_REPOSITORY).' }
if (-not $CurrentTag.StartsWith('v')) { $CurrentTag = "v$CurrentTag" }
if (-not $CurrentFeed) { $CurrentFeed = Join-Path (Split-Path -Parent $CurrentSetup) 'latest.yml' }
if (-not $WorkDir) {
  $WorkDir = Join-Path ([IO.Path]::GetTempPath()) ("qn-upgrade-e2e-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
}

$CurrentSetup = (Resolve-Path -LiteralPath $CurrentSetup).Path
$CurrentFeed = (Resolve-Path -LiteralPath $CurrentFeed).Path
if (-not (Test-Path -LiteralPath $WorkDir)) {
  New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null
}
$WorkDir = (Resolve-Path -LiteralPath $WorkDir).Path
$InstallDir = Join-Path $WorkDir 'install'
$ReportPath = Join-Path $WorkDir 'windows-upgrade-report.json'

if ($InstallDir -match ' ') {
  # NSIS /D= is deliberately unquoted and must be the last argument.
  throw "WorkDir must not contain spaces: $WorkDir"
}

$AppName = 'QianNing Agent'
$AppExe = Join-Path $InstallDir 'QianNing Agent.exe'
$DataDir = Join-Path $HOME '.qianning-agent'
$UserDataDir = Join-Path $env:APPDATA $AppName
$RunId = [Guid]::NewGuid().ToString('N').Substring(0, 8)
$DataMarker = Join-Path $DataDir "e2e-upgrade-$RunId.json"
$UserDataMarker = Join-Path $UserDataDir "e2e-upgrade-$RunId.json"

$ApiHeaders = @{
  Accept = 'application/vnd.github+json'
  'User-Agent' = 'qianning-agent-windows-upgrade-e2e'
  'X-GitHub-Api-Version' = '2022-11-28'
}
if ($env:GH_TOKEN) { $ApiHeaders['Authorization'] = "Bearer $env:GH_TOKEN" }

$WebArgs = @{ UseBasicParsing = $true }
if ($Proxy) { $WebArgs['Proxy'] = $Proxy }
$CurlProxy = @()
if ($Proxy) { $CurlProxy = @('--proxy', $Proxy) }

function Write-Step([string]$Message) {
  Write-Host ''
  Write-Host "== $Message"
}

function Assert-True([bool]$Condition, [string]$Message, [string]$Detail = '') {
  if (-not $Condition) {
    $suffix = if ($Detail) { " ($Detail)" } else { '' }
    throw "assertion failed: $Message$suffix"
  }
}

function Read-UpdateFeed {
  param([Parameter(Mandatory)][string]$Path)

  Assert-True (Test-Path -LiteralPath $Path) 'update feed is missing' $Path
  $text = Get-Content -LiteralPath $Path -Raw
  $versionMatch = [regex]::Match($text, '(?m)^version:\s*(?<value>[^\r\n]+?)\s*$')
  Assert-True $versionMatch.Success 'update feed has no version:' $Path
  $version = $versionMatch.Groups['value'].Value.Trim().Trim('"').Trim("'")

  $filesMatch = [regex]::Match($text, '(?ms)^files:\s*\r?\n(?<body>.*?)(?=^[A-Za-z][A-Za-z0-9_-]*:|\z)')
  Assert-True $filesMatch.Success 'update feed has no files: block' $Path
  $body = $filesMatch.Groups['body'].Value

  $urlMatch = [regex]::Match($body, '(?m)^\s{2}-\s+url:\s*(?<value>[^\r\n]+?)\s*$')
  $shaMatch = [regex]::Match($body, '(?m)^\s{4}sha512:\s*(?<value>[^\r\n]+?)\s*$')
  $sizeMatch = [regex]::Match($body, '(?m)^\s{4}size:\s*(?<value>\d+)\s*$')
  Assert-True $urlMatch.Success 'update feed files[0] has no url' $Path
  Assert-True $shaMatch.Success 'update feed files[0] has no sha512' $Path
  Assert-True $sizeMatch.Success 'update feed files[0] has no size' $Path

  $fileName = [IO.Path]::GetFileName($urlMatch.Groups['value'].Value.Trim().Trim('"'))
  $sha512 = $shaMatch.Groups['value'].Value.Trim().Trim('"').Trim("'")
  try {
    Assert-True ([Convert]::FromBase64String($sha512).Length -eq 64) 'update feed sha512 is not a 64-byte base64 digest' $sha512
  } catch {
    throw "update feed sha512 is invalid: $sha512"
  }

  $pathMatch = [regex]::Match($text, '(?m)^path:\s*(?<value>[^\r\n]+?)\s*$')
  $pathName = if ($pathMatch.Success) { [IO.Path]::GetFileName($pathMatch.Groups['value'].Value.Trim().Trim('"')) } else { $fileName }
  Assert-True ($pathName -eq $fileName) 'update feed path does not name files[0].url' "$pathName != $fileName"

  [pscustomobject]@{
    Version  = $version
    FileName = $fileName
    Sha512   = $sha512
    Size     = [int64]$sizeMatch.Groups['value'].Value
  }
}

function Get-Sha512Base64 {
  param([Parameter(Mandatory)][string]$Path)
  $sha = [Security.Cryptography.SHA512]::Create()
  $stream = $null
  try {
    $stream = [IO.File]::OpenRead($Path)
    return [Convert]::ToBase64String($sha.ComputeHash($stream))
  } finally {
    if ($stream) { $stream.Dispose() }
    $sha.Dispose()
  }
}

function Assert-InstallerMatchesFeed {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)]$Feed
  )
  Assert-True (Test-Path -LiteralPath $Path) 'installer is missing' $Path
  $size = (Get-Item -LiteralPath $Path).Length
  Assert-True ($size -eq $Feed.Size) 'installer size does not match latest.yml' "$Path size=$size feed=$($Feed.Size)"
  $hash = Get-Sha512Base64 -Path $Path
  # Base64 is case-sensitive; -eq would silently accept a wrong digest.
  Assert-True ($hash -ceq $Feed.Sha512) 'installer SHA-512 does not match latest.yml' $Path
  Write-Host ("   verified {0} ({1:N0} bytes, sha512 {2}...)" -f $Feed.FileName, $size, $hash.Substring(0, 12))
}

function Save-GitHubFile {
  param(
    [Parameter(Mandatory)][string]$Uri,
    [Parameter(Mandatory)][string]$Path
  )
  $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
  if ($curl) {
    $arguments = @('--fail', '--location', '--silent', '--show-error', '--retry', '3', '--retry-delay', '2', '--output', $Path) + $CurlProxy + @($Uri)
    & $curl.Source @arguments
    if ($LASTEXITCODE -ne 0) { throw "curl.exe failed with exit $LASTEXITCODE for $Uri" }
  } else {
    Invoke-WebRequest @WebArgs -Uri $Uri -OutFile $Path -MaximumRedirection 5
  }
}

function Get-GitHubJson {
  param([Parameter(Mandatory)][string]$Uri)
  $request = @{ Uri = $Uri; Headers = $ApiHeaders; Method = 'Get' }
  if ($Proxy) { $request['Proxy'] = $Proxy }
  Invoke-RestMethod @request
}

function Get-StableReleaseChain {
  $uri = "https://api.github.com/repos/$Repo/releases?per_page=30"
  # Invoke-RestMethod writes a JSON array as one pipeline object; @(...) would
  # wrap that array again shrink-wrapped. Assign first, then enumerate it.
  $releases = Get-GitHubJson -Uri $uri
  $currentVersion = [version](($CurrentTag.TrimStart('v')) -replace '-.*$', '')

  $candidates = @($releases | Where-Object {
    -not $_.draft -and
    -not $_.prerelease -and
    $_.tag_name -match '^v\d+\.\d+\.\d+$' -and
    $_.tag_name -ne $CurrentTag -and
    ([version]$_.tag_name.Substring(1)) -lt $currentVersion -and
    @($_.assets | Where-Object { $_.name -eq 'latest.yml' }).Count -eq 1 -and
    @($_.assets | Where-Object { $_.name -match '^QianNing-Agent-Setup-.+\.exe$' }).Count -eq 1
  })

  Assert-True ($candidates.Count -ge $PreviousCount) `
    "need $PreviousCount previous stable Windows releases before $CurrentTag, found $($candidates.Count)"

  $selected = @($candidates |
    Sort-Object { [version]$_.tag_name.Substring(1) } -Descending |
    Select-Object -First $PreviousCount)

  # Oldest first: each selected release is the upgrade the next one must replace.
  @($selected | Sort-Object { [version]$_.tag_name.Substring(1) } | ForEach-Object { $_ })
}

function Get-InstalledVersion {
  if (-not (Test-Path -LiteralPath $AppExe)) { return $null }
  $info = (Get-Item -LiteralPath $AppExe).VersionInfo
  if ($info.ProductVersion) { return $info.ProductVersion.Trim() }
  if ($info.FileVersion) { return $info.FileVersion.Trim() }
  return $null
}

function Test-VersionMatch {
  param([string]$Actual, [string]$Expected)
  if (-not $Actual) { return $false }
  if ($Actual -eq $Expected) { return $true }
  # Electron stamps a stable base (2.4.2) even when the feed names a
  # prerelease; the registry entry remains the exact feed version.
  $base = $Expected -replace '-.*$', ''
  return ($Actual -eq $base -or $Actual.StartsWith("$base."))
}

function Get-UninstallEntries {
  $keys = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  @(Get-ItemProperty -Path $keys -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -eq $AppName } |
    Select-Object DisplayName, DisplayVersion, InstallLocation, UninstallString, PSChildName)
}

function Stop-QianNingAgent {
  foreach ($name in @('QianNing Agent', 'QianNing Agent Helper', 'QianNing-Agent-Host-Core')) {
    $processes = @(Get-Process -Name $name -ErrorAction SilentlyContinue)
    if ($processes.Count -gt 0) {
      $processes | Stop-Process -Force -ErrorAction SilentlyContinue
    }
  }
  Start-Sleep -Seconds 2
}

function Wait-ForInstall {
  param([string]$ExpectedVersion, [int]$Seconds = 90)
  for ($i = 0; $i -lt $Seconds; $i++) {
    $exeVersion = Get-InstalledVersion
    $entries = @(Get-UninstallEntries)
    if ($exeVersion -and (Test-VersionMatch -Actual $exeVersion -Expected $ExpectedVersion) -and $entries.Count -eq 1) {
      return [pscustomobject]@{ ExeVersion = $exeVersion; Entries = $entries }
    }
    Start-Sleep -Seconds 1
  }
  $actual = if (Get-InstalledVersion) { Get-InstalledVersion } else { '<missing>' }
  throw "installer did not settle at $ExpectedVersion within $Seconds s (exe=$actual, uninstall entries=$((Get-UninstallEntries).Count))"
}

function Invoke-Installer {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$ExpectedVersion,
    [Parameter(Mandatory)][string]$Label
  )
  Stop-QianNingAgent
  Write-Step "Installing $Label ($ExpectedVersion)"
  $process = Start-Process -FilePath $Path -ArgumentList @('/S', "/D=$InstallDir") -PassThru -Wait -WindowStyle Hidden
  Assert-True ($process.ExitCode -eq 0) "$Label installer exited non-zero" "exit=$($process.ExitCode)"

  $settled = Wait-ForInstall -ExpectedVersion $ExpectedVersion
  Assert-True ($settled.Entries.Count -eq 1) "$Label left more than one uninstall entry" "count=$($settled.Entries.Count)"
  $entry = $settled.Entries[0]
  Assert-True ($entry.DisplayVersion -eq $ExpectedVersion) `
    "$Label uninstall DisplayVersion is wrong" "display=$($entry.DisplayVersion) expected=$ExpectedVersion"
  if ($entry.InstallLocation) {
    $actualLocation = $entry.InstallLocation.TrimEnd('\')
    $expectedLocation = $InstallDir.TrimEnd('\')
    Assert-True ($actualLocation -ieq $expectedLocation) `
      "$Label uninstall entry points at another install" "$actualLocation != $expectedLocation"
  }

  [pscustomobject]@{
    Label = $Label
    ExpectedVersion = $ExpectedVersion
    ExeVersion = $settled.ExeVersion
    DisplayVersion = $entry.DisplayVersion
    UninstallEntries = $settled.Entries.Count
  }
}

function Uninstall-QianNingAgent {
  Stop-QianNingAgent
  $entry = @(Get-UninstallEntries) | Select-Object -First 1
  if ($entry) {
    $uninstaller = Get-ChildItem -LiteralPath $InstallDir -Filter 'Uninstall*.exe' -File -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($uninstaller) {
      Write-Step "Uninstalling $AppName"
      $process = Start-Process -FilePath $uninstaller.FullName -ArgumentList '/S' -PassThru -Wait -WindowStyle Hidden
      if ($process.ExitCode -ne 0) {
        Write-Warning "uninstaller exited $($process.ExitCode)"
      }
    } else {
      Write-Warning "uninstall entry exists but no Uninstall*.exe is in $InstallDir"
    }
  }

  for ($i = 0; $i -lt 60; $i++) {
    if (-not (Get-UninstallEntries) -and -not (Test-Path -LiteralPath (Join-Path $InstallDir 'QianNing Agent.exe'))) {
      break
    }
    Start-Sleep -Seconds 1
  }

  if (Test-Path -LiteralPath $InstallDir) {
    for ($i = 0; $i -lt 10; $i++) {
      Remove-Item -LiteralPath $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
      if (-not (Test-Path -LiteralPath $InstallDir)) { break }
      Start-Sleep -Seconds 1
    }
  }
  Assert-True (@(Get-UninstallEntries).Count -eq 0) 'uninstall left an Add/Remove Programs entry'
}

function Get-FileHashSha256 {
  param([Parameter(Mandatory)][string]$Path)
  (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

try {
  Write-Step "Windows install/upgrade E2E: $CurrentTag"
  Write-Host "repo:    $Repo"
  Write-Host "setup:   $CurrentSetup"
  Write-Host "feed:    $CurrentFeed"
  Write-Host "workdir: $WorkDir"
  $mode = if ($PlanOnly) { 'plan only' } elseif ($VerifyInstallers) { 'verify installers only' } else { 'install + upgrade' }
  Write-Host "mode:    $mode"

  $candidateFeed = Read-UpdateFeed -Path $CurrentFeed
  Assert-True ("v" + $candidateFeed.Version -eq $CurrentTag) `
    'candidate latest.yml version does not match the tag' "$($candidateFeed.Version) != $CurrentTag"
  Assert-True ([IO.Path]::GetFileName($CurrentSetup) -eq $candidateFeed.FileName) `
    'candidate installer filename does not match latest.yml' "$(Split-Path -Leaf $CurrentSetup) != $($candidateFeed.FileName)"
  Assert-InstallerMatchesFeed -Path $CurrentSetup -Feed $candidateFeed

  $previous = @(Get-StableReleaseChain)
  $chain = @()
  foreach ($release in $previous) {
    $feedAsset = $release.assets | Where-Object { $_.name -eq 'latest.yml' } | Select-Object -First 1
    $setupAsset = $release.assets | Where-Object { $_.name -match '^QianNing-Agent-Setup-.+\.exe$' } | Select-Object -First 1
    $chain += [pscustomobject]@{
      Tag = $release.tag_name
      FeedUrl = $feedAsset.browser_download_url
      SetupUrl = $setupAsset.browser_download_url
      SetupName = $setupAsset.name
    }
  }
  $chain += [pscustomobject]@{
    Tag = $CurrentTag
    FeedUrl = $null
    SetupUrl = $null
    SetupName = [IO.Path]::GetFileName($CurrentSetup)
  }

  if ($PlanOnly) {
    Write-Step 'Plan (no installers downloaded or executed)'
    foreach ($step in $chain) {
      if ($step.Tag -eq $CurrentTag) {
        Write-Host ("  {0}  {1}  {2:N0} bytes  local candidate" -f $step.Tag, $candidateFeed.Version, $candidateFeed.Size)
      } else {
        $name = $step.Tag.TrimStart('v')
        Write-Host ("  {0}  {1}  {2}  feed={3}" -f $step.Tag, $name, $step.SetupName, $step.FeedUrl)
      }
    }
    $plan = [ordered]@{
      schema = 1
      mode = 'plan'
      repo = $Repo
      currentTag = $CurrentTag
      currentVersion = $candidateFeed.Version
      currentSha512 = $candidateFeed.Sha512
      currentSize = $candidateFeed.Size
      previousCount = $previous.Count
      chain = @($chain | ForEach-Object { [ordered]@{ tag = $_.Tag; setup = $_.SetupName; feedUrl = $_.FeedUrl; setupUrl = $_.SetupUrl } })
    }
    $plan | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $ReportPath -Encoding UTF8
    Write-Host "plan: $ReportPath"
    return
  }

  # Verify every previous release's installer before touching this machine.
  $verified = @()
  foreach ($step in $chain) {
    if ($step.Tag -eq $CurrentTag) {
      $verified += [pscustomobject]@{
        Tag = $step.Tag
        Version = $candidateFeed.Version
        Setup = $CurrentSetup
        Sha512 = $candidateFeed.Sha512
        Size = $candidateFeed.Size
      }
      continue
    }
    $tagDir = Join-Path $WorkDir ("release-" + $step.Tag)
    New-Item -ItemType Directory -Path $tagDir -Force | Out-Null
    $feedPath = Join-Path $tagDir 'latest.yml'
    $setupPath = Join-Path $tagDir $step.SetupName
    Write-Step "Downloading $($step.Tag)"
    Save-GitHubFile -Uri $step.FeedUrl -Path $feedPath
    $feed = Read-UpdateFeed -Path $feedPath
    Assert-True ("v" + $feed.Version -eq $step.Tag) `
      "$($step.Tag) feed names another release" "$($feed.Version) != $($step.Tag)"
    Assert-True ($feed.FileName -eq $step.SetupName) `
      "$($step.Tag) feed names another installer" "$($feed.FileName) != $($step.SetupName)"
    Save-GitHubFile -Uri $step.SetupUrl -Path $setupPath
    Assert-InstallerMatchesFeed -Path $setupPath -Feed $feed
    $verified += [pscustomobject]@{
      Tag = $step.Tag
      Version = $feed.Version
      Setup = $setupPath
      Sha512 = $feed.Sha512
      Size = $feed.Size
    }
  }

  if ($VerifyInstallers) {
    Write-Step 'Verified installers (nothing installed)'
    $verifyReport = [ordered]@{
      schema = 1
      mode = 'verify-installers'
      repo = $Repo
      currentTag = $CurrentTag
      chain = @($verified | ForEach-Object {
        [ordered]@{
          tag = $_.Tag
          version = $_.Version
          setup = Split-Path -Leaf $_.Setup
          sha512 = $_.Sha512
          size = $_.Size
        }
      })
      result = 'pass'
    }
    $verifyReport | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $ReportPath -Encoding UTF8
    Write-Host "verified $($verified.Count) installers; report: $ReportPath"
    return
  }

  if (Test-Path -LiteralPath $InstallDir) {
    Remove-Item -LiteralPath $InstallDir -Recurse -Force
  }
  New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
  New-Item -ItemType Directory -Path $UserDataDir -Force | Out-Null
  $marker = [ordered]@{
    schema = 1
    runId = $RunId
    createdAt = (Get-Date).ToUniversalTime().ToString('o')
    sentinel = [Guid]::NewGuid().ToString('N')
  }
  $markerText = $marker | ConvertTo-Json -Compress
  Set-Content -LiteralPath $DataMarker -Value $markerText -Encoding UTF8 -NoNewline
  Set-Content -LiteralPath $UserDataMarker -Value $markerText -Encoding UTF8 -NoNewline
  $dataHash = Get-FileHashSha256 -Path $DataMarker
  $userDataHash = Get-FileHashSha256 -Path $UserDataMarker

  $steps = @()
  foreach ($item in $verified) {
    $result = Invoke-Installer -Path $item.Setup -ExpectedVersion $item.Version -Label $item.Tag
    Assert-True ((Get-FileHashSha256 -Path $DataMarker) -eq $dataHash) `
      "$($item.Tag) changed the user data marker" $DataMarker
    Assert-True ((Get-FileHashSha256 -Path $UserDataMarker) -eq $userDataHash) `
      "$($item.Tag) changed %%APPDATA%% marker" $UserDataMarker
    $steps += [pscustomobject]@{
      Tag = $result.Label
      ExpectedVersion = $result.ExpectedVersion
      ExeVersion = $result.ExeVersion
      DisplayVersion = $result.DisplayVersion
      UninstallEntries = $result.UninstallEntries
      DataDirPreserved = $true
      UserDataPreserved = $true
      Result = 'pass'
    }
  }

  if (-not $SkipLaunch) {
    Write-Step "Launching $AppName $($candidateFeed.Version)"
    Stop-QianNingAgent
    $launch = Start-Process -FilePath $AppExe -ArgumentList '--disable-gpu' -PassThru
    Start-Sleep -Seconds 20
    $launch.Refresh()
    Assert-True (-not $launch.HasExited) 'app exited during the launch probe' "pid=$($launch.Id)"
    Stop-QianNingAgent
    Write-Host "   app stayed up for 20 s; stopped"
  }

  Uninstall-QianNingAgent

  Write-Step 'Fresh install of the candidate'
  $fresh = Invoke-Installer -Path $CurrentSetup -ExpectedVersion $candidateFeed.Version -Label "$CurrentTag (fresh)"
  Uninstall-QianNingAgent

  if (Test-Path -LiteralPath $DataMarker) { Remove-Item -LiteralPath $DataMarker -Force }
  if (Test-Path -LiteralPath $UserDataMarker) { Remove-Item -LiteralPath $UserDataMarker -Force }

  $report = [ordered]@{
    schema = 1
    mode = 'install-upgrade'
    repo = $Repo
    currentTag = $CurrentTag
    currentVersion = $candidateFeed.Version
    currentSha512 = $candidateFeed.Sha512
    currentSize = $candidateFeed.Size
    installDir = $InstallDir
    launchProbe = -not $SkipLaunch
    steps = @($steps)
    freshInstall = [ordered]@{
      tag = $fresh.Label
      expectedVersion = $fresh.ExpectedVersion
      exeVersion = $fresh.ExeVersion
      displayVersion = $fresh.DisplayVersion
      uninstallEntries = $fresh.UninstallEntries
      result = 'pass'
    }
    result = 'pass'
  }
  $reportJson = $report | ConvertTo-Json -Depth 8
  Set-Content -LiteralPath $ReportPath -Value $reportJson -Encoding UTF8
  Write-Host $reportJson

  if ($env:GITHUB_STEP_SUMMARY) {
    $lines = @(
      '### Windows install -> upgrade E2E',
      '',
      "| Step | Expected | EXE | Uninstall | Data | Result |",
      '| --- | --- | --- | --- | --- | --- |'
    )
    foreach ($step in $steps) {
      $lines += "| $($step.Tag) | $($step.ExpectedVersion) | $($step.ExeVersion) | $($step.DisplayVersion) | preserved | pass |"
    }
    $lines += "| $($fresh.Label) | $($fresh.ExpectedVersion) | $($fresh.ExeVersion) | $($fresh.DisplayVersion) | n/a | pass |"
    $lines += ''
    $lines += "Candidate: ``$($candidateFeed.Version)`` / ``$($candidateFeed.Sha512)``"
    $lines | Out-File -LiteralPath $env:GITHUB_STEP_SUMMARY -Append -Encoding utf8
  }

  Write-Step 'PASS'
  $chainTags = @($chain | ForEach-Object { $_.Tag })
  Write-Host "chain: $($chainTags -join ' -> ')"
  Write-Host "report: $ReportPath"
} finally {
  Stop-QianNingAgent
  foreach ($markerPath in @($DataMarker, $UserDataMarker)) {
    if ($markerPath -and (Test-Path -LiteralPath $markerPath)) {
      Remove-Item -LiteralPath $markerPath -Force -ErrorAction SilentlyContinue
    }
  }
}
