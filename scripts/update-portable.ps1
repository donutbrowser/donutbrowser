<#
.SYNOPSIS
Updates a portable Donut Browser folder to the newest release.

.DESCRIPTION
Finds the version in the folder, downloads the newest portable ZIP of the same
channel, checks it against the release's SHA256SUMS.txt and replaces the
program files. The data, cache and logs folders (profiles, logins, settings)
do not change. When a file cannot be replaced, the old files are put back.

.PARAMETER Path
The portable folder: the one with Donut.exe and the .portable file, or the
folder that holds Donut-Portable. Without it, the script uses its own folder
when that is a portable folder, else it asks.

.PARAMETER Channel
stable or nightly. By default, the channel of the installed version.

.PARAMETER Force
Installs the newest release also when the folder already has it.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File update-portable.ps1 -Path "D:\Donut-Portable"
#>
[CmdletBinding()]
param(
  [string]$Path,
  [ValidateSet('stable', 'nightly')]
  [string]$Channel,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Releases = @('https://api.donutbrowser.com/api/app-releases', 'https://api.github.com/repos/donutbrowser/donutbrowser/releases?per_page=20')
$Sidecars = @('donut-proxy.exe', 'xray.exe', 'donut-daemon.exe')
$Kept = @('data', 'cache', 'logs', '.update')

# What the run did, for the end of the script.
$State = @{ Asked = $false; KeepWork = $false }

# Ends the run with a message. `exit` would also close the window of a person
# who ran the script from a pasted command.
function Fail([string]$Message) {
  throw $Message
}

function Find-PortableFolder([string]$Candidate) {
  if (-not $Candidate) { return $null }
  $Candidate = $Candidate.Trim().Trim('"')
  foreach ($dir in @($Candidate, (Join-Path $Candidate 'Donut-Portable'))) {
    if (Test-Path -LiteralPath (Join-Path $dir '.portable') -PathType Leaf) {
      return (Resolve-Path -LiteralPath $dir).ProviderPath
    }
  }
  return $null
}

function Read-Folder {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = 'Select the portable Donut Browser folder (the one with Donut.exe)'
    if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { return $dialog.SelectedPath }
    return $null
  } catch {
    return Read-Host 'Portable Donut Browser folder'
  }
}

# The newest "Donut started version=..." line of the app's own log.
function Get-LoggedVersion([string]$Folder) {
  $logs = Get-ChildItem -LiteralPath (Join-Path $Folder 'logs') -Filter 'DonutBrowser*.log' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending
  foreach ($log in $logs) {
    $found = Select-String -LiteralPath $log.FullName -Pattern 'Donut started version=(\S+)' | Select-Object -Last 1
    if ($found) { return $found.Matches[0].Groups[1].Value }
  }
  return $null
}

function Get-Releases {
  foreach ($url in $Releases) {
    try {
      $list = Invoke-RestMethod -Uri $url -UseBasicParsing -TimeoutSec 30 -Headers @{ 'User-Agent' = 'donut-portable-update' }
      if ($list) { return @($list) }
    } catch {
      Write-Host "Could not read $url : $($_.Exception.Message)"
    }
  }
  return @()
}

function ConvertTo-Version([string]$Tag) {
  $parsed = $null
  if ([version]::TryParse(($Tag -replace '^v', '' -replace '[-+].*$', ''), [ref]$parsed)) { return $parsed }
  return $null
}

function Move-WithRetry([string]$From, [string]$To) {
  for ($attempt = 1; ; $attempt++) {
    try {
      Move-Item -LiteralPath $From -Destination $To -Force
      return
    } catch {
      if ($attempt -ge 20) { throw }
      Start-Sleep -Milliseconds 250
    }
  }
}

function Update-PortableFolder {
  # --- the folder -------------------------------------------------------------

  $folder = Find-PortableFolder $Path
  if (-not $folder -and -not $Path -and $PSScriptRoot) { $folder = Find-PortableFolder $PSScriptRoot }
  if (-not $folder -and -not $Path) {
    $State.Asked = $true
    $Path = Read-Folder
    $folder = Find-PortableFolder $Path
  }
  if (-not $folder) { Fail "No portable Donut Browser folder at '$Path'. Select the folder with Donut.exe and the .portable file." }

  $exe = Join-Path $folder 'Donut.exe'
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    $others = @(Get-ChildItem -LiteralPath $folder -Filter '*.exe' | Where-Object { $Sidecars -notcontains $_.Name.ToLower() })
    if ($others.Count -ne 1) { Fail "Donut.exe is not in '$folder'." }
    $exe = $others[0].FullName
  }

  $running = @(Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($folder + '\', [StringComparison]::OrdinalIgnoreCase) })
  if ($running.Count -gt 0) {
    $names = ($running | Select-Object -ExpandProperty ProcessName -Unique) -join ', '
    Fail "Programs from this folder are running ($names). Stop all profiles and quit Donut Browser, then run this script again."
  }

  # --- the versions -----------------------------------------------------------

  $installed = Get-LoggedVersion $folder
  if (-not $installed) {
    $productVersion = (Get-Item -LiteralPath $exe).VersionInfo.ProductVersion
    if ($productVersion) { $installed = 'v' + $productVersion.Trim() }
  }
  if (-not $Channel) {
    if ($installed -like 'nightly-*') { $Channel = 'nightly' } else { $Channel = 'stable' }
  }
  $display = $installed
  if (-not $display) { $display = 'unknown' }
  Write-Host "Folder:    $folder"
  Write-Host "Installed: $display ($Channel)"

  $pattern = '^v\d'
  if ($Channel -eq 'nightly') { $pattern = '^nightly-\d' }
  $release = Get-Releases |
    Where-Object { $_.tag_name -match $pattern -and ($_.assets | Where-Object { $_.name -like '*_x64-portable.zip' }) } |
    Sort-Object { if ($_.published_at) { [datetime]$_.published_at } else { [datetime]::MinValue } } -Descending |
    Select-Object -First 1
  if (-not $release) { Fail "No $Channel release with a portable ZIP was found. Try again later." }
  $latest = $release.tag_name
  Write-Host "Newest:    $latest"

  if (-not $Force -and $installed) {
    if ($Channel -eq 'stable') {
      $current = ConvertTo-Version $installed
      $newest = ConvertTo-Version $latest
      $upToDate = $current -and $newest -and $current -ge $newest
    } else {
      $upToDate = $installed -eq $latest
    }
    if ($upToDate) {
      Write-Host 'This folder has the newest version. Nothing to do.' -ForegroundColor Green
      return
    }
  }

  $zipAsset = $release.assets | Where-Object { $_.name -like '*_x64-portable.zip' } | Select-Object -First 1
  $sumsAsset = $release.assets | Where-Object { $_.name -eq 'SHA256SUMS.txt' } | Select-Object -First 1
  if (-not $sumsAsset) { Fail "$latest has no SHA256SUMS.txt yet. Try again in a few minutes." }

  # --- download and check -----------------------------------------------------

  $work = Join-Path $folder '.update'
  if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
  New-Item -ItemType Directory -Path $work | Out-Null

  try {
    $zip = Join-Path $work $zipAsset.name
    Write-Host "Downloading $($zipAsset.name)..."
    Invoke-WebRequest -Uri $zipAsset.browser_download_url -OutFile $zip -UseBasicParsing
    $sums = (Invoke-WebRequest -Uri $sumsAsset.browser_download_url -UseBasicParsing).Content
    if ($sums -is [byte[]]) { $sums = [Text.Encoding]::UTF8.GetString($sums) }

    $expected = $null
    foreach ($line in ($sums -split "`r?`n")) {
      $parts = $line.Trim() -split '\s+\*?', 2
      if ($parts.Count -eq 2 -and $parts[1] -eq $zipAsset.name) { $expected = $parts[0].ToLower() }
    }
    if (-not $expected) { Fail "SHA256SUMS.txt of $latest does not list $($zipAsset.name)." }
    $actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $expected) { Fail "The download does not match SHA256SUMS.txt (expected $expected, got $actual). Nothing was changed." }

    $staged = Join-Path $work 'staged'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($zip, $staged)
    $package = $staged
    if (-not (Test-Path -LiteralPath (Join-Path $package 'Donut.exe'))) { $package = Join-Path $staged 'Donut-Portable' }
    if (-not (Test-Path -LiteralPath (Join-Path $package 'Donut.exe'))) { Fail "$($zipAsset.name) has no Donut.exe. Nothing was changed." }

    # --- replace the program files --------------------------------------------

    $old = Join-Path $work 'old'
    $done = New-Object System.Collections.ArrayList
    $files = Get-ChildItem -LiteralPath $package -Recurse -File -Force |
      ForEach-Object { $_.FullName.Substring($package.Length + 1) } |
      Where-Object { $Kept -notcontains ($_ -split '\\')[0] } |
      Sort-Object
    try {
      foreach ($relative in $files) {
        $targetRelative = $relative
        if ($relative -eq 'Donut.exe') { $targetRelative = Split-Path -Leaf $exe }
        $target = Join-Path $folder $targetRelative
        $aside = $null
        if (Test-Path -LiteralPath $target) {
          $aside = Join-Path $old $targetRelative
          New-Item -ItemType Directory -Path (Split-Path -Parent $aside) -Force | Out-Null
          Move-WithRetry $target $aside
        }
        [void]$done.Add(@($target, $aside))
        New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
        Move-WithRetry (Join-Path $package $relative) $target
      }
    } catch {
      $reason = $_.Exception.Message.TrimEnd(".")
      for ($i = $done.Count - 1; $i -ge 0; $i--) {
        $target, $aside = $done[$i]
        try {
          if ($aside) { Move-WithRetry $aside $target }
          elseif (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }
        } catch {
          $State.KeepWork = $true
          Write-Host "Could not put back $target : $($_.Exception.Message)" -ForegroundColor Red
        }
      }
      if ($State.KeepWork) { Fail "Could not replace the program files: $reason. Some old files are still in $old; move them back by hand." }
      Fail "Could not replace the program files: $reason. The old version was put back."
    }
  } finally {
    if (-not $State.KeepWork -and (Test-Path -LiteralPath $work)) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
  }

  Write-Host "Donut Browser updated from $display to $latest. The data, cache and logs folders did not change." -ForegroundColor Green
  Write-Host "Start it with $exe"
}

$failed = $false
try {
  Update-PortableFolder
} catch {
  Write-Host $_.Exception.Message -ForegroundColor Red
  $failed = $true
}
if ($State.Asked) { Read-Host 'Press Enter to close' | Out-Null }
if ($failed -and $PSCommandPath) { exit 1 }
