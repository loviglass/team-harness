# team-harness installer for Windows (PowerShell 5.1+):
#   irm https://raw.githubusercontent.com/loviglass/team-harness/main/install.ps1 | iex
# Re-running it is safe (repairs/updates the install).
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$RepoUrl = if ($env:TEAM_HARNESS_REPO) { $env:TEAM_HARNESS_REPO } else { 'https://github.com/loviglass/team-harness.git' }
$Base = if ($env:TEAM_HARNESS_HOME) { $env:TEAM_HARNESS_HOME } else { Join-Path $env:LOCALAPPDATA 'team-harness' }

function Update-SessionPath {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ';'
}

# Git for Windows (also provides the Bash that OpenCode uses for shell commands).
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host '==> Installing Git for Windows (winget)'
    winget install --id Git.Git -e --source winget --silent --accept-package-agreements --accept-source-agreements | Out-Null
    Update-SessionPath
  }
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw 'Git for Windows is required: https://git-scm.com/download/win  (install it, then re-run this command)'
  }
}

Write-Host "==> Installing team-harness into $Base"
New-Item -ItemType Directory -Force -Path (Join-Path $Base 'engine') | Out-Null
$Repo = Join-Path $Base 'repo'
if (Test-Path (Join-Path $Repo '.git')) {
  git -C $Repo fetch --quiet --tags --force origin
} else {
  git clone --quiet $RepoUrl $Repo
}
if ($LASTEXITCODE -ne 0) { throw 'git clone/fetch failed' }
$Tag = git -C $Repo tag --list 'v*' --sort=-v:refname | Select-Object -First 1
if ($Tag) { git -C $Repo checkout --quiet --force $Tag }

# Pinned OpenCode engine (official release, checksum-verified).
$V = @{}
Get-Content (Join-Path $Repo 'versions.env') | ForEach-Object {
  if ($_ -match '^([A-Za-z0-9_]+)=(.*)$') { $V[$Matches[1]] = $Matches[2].Trim() }
}
$Cpu = switch ($env:PROCESSOR_ARCHITECTURE) { 'AMD64' { 'x64' } 'ARM64' { 'arm64' } default { throw "Unsupported CPU: $env:PROCESSOR_ARCHITECTURE" } }
$Sha = $V["OPENCODE_SHA256_windows_$Cpu"]
$Version = $V['OPENCODE_VERSION']
$Asset = if ($Cpu -eq 'x64') { 'opencode-windows-x64-baseline.zip' } else { 'opencode-windows-arm64.zip' }
$EngineDir = Join-Path $Base "engine\opencode-$Version"
$Engine = Join-Path $EngineDir 'opencode.exe'
if (-not (Test-Path $Engine)) {
  Write-Host "==> Downloading OpenCode $Version"
  $Tmp = Join-Path $Base ("engine\.dl-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $Tmp | Out-Null
  try {
    $Zip = Join-Path $Tmp $Asset
    Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/anomalyco/opencode/releases/download/v$Version/$Asset" -OutFile $Zip
    $Got = (Get-FileHash -Algorithm SHA256 $Zip).Hash.ToLower()
    if ($Got -ne $Sha) { throw "checksum mismatch for $Asset" }
    Expand-Archive -Path $Zip -DestinationPath $Tmp -Force
    New-Item -ItemType Directory -Force -Path $EngineDir | Out-Null
    Move-Item -Force (Join-Path $Tmp 'opencode.exe') $Engine
  } finally {
    Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
  }
}
Set-Content -NoNewline -Encoding ASCII -Path (Join-Path $Base 'engine\current') -Value $Engine

# Command on PATH (user scope, no admin rights).
$Bin = Join-Path $Base 'bin'
New-Item -ItemType Directory -Force -Path $Bin | Out-Null
Copy-Item -Force (Join-Path $Repo 'bin\team-harness.cmd') (Join-Path $Bin 'team-harness.cmd')
$UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not (($UserPath -split ';') -contains $Bin)) {
  $NewPath = if ($UserPath) { "$UserPath;$Bin" } else { $Bin }
  [Environment]::SetEnvironmentVariable('Path', $NewPath, 'User')
}
Update-SessionPath

# Logins and checks (interactive).
& (Join-Path $Bin 'team-harness.cmd') setup
if ($LASTEXITCODE -ne 0) { throw 'setup failed' }
