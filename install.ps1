# dsh-bash-terminal - one-click install/uninstall for the web profile.
# Usage:  powershell -ExecutionPolicy Bypass -File install.ps1 [install|uninstall]

param([ValidateSet("install", "uninstall")][string]$Action = "install")

$ErrorActionPreference = "Stop"
$pluginDir = "D:\WorkSpace\projects\dsh-bash-terminal"
$profileDir = Join-Path $env:USERPROFILE ".dsh\profiles\web"
$pluginLink = Join-Path $profileDir "node_modules\dsh-bash-terminal"
$depLink = Join-Path $pluginDir "node_modules\@deepseek-ai"
$patchFile = Join-Path $profileDir "cordis.patch.yml"
$patchBlock = @'
# ================= dsh-bash-terminal =================
- insert:
    - id: tool-bash-terminal
      name: 'dsh-bash-terminal'
'@

function New-Junction($path, $target) {
  if (Test-Path $path) { Remove-Item $path -Force -Recurse }
  New-Item -ItemType Junction -Path $path -Target $target | Out-Null
  Write-Host "  linked: $path -> $target"
}

# DSH's settings UI keeps a hard-coded namespace allowlist in
# dsh-host-apiproxy; third-party settings namespaces are refused with
# settings-not-exposed unless listed. install patches that allowlist.
$apiproxy = Join-Path $profileDir "..\node_modules\@deepseek-ai\dsh-host-apiproxy\lib\index.js"
$apiproxyBak = "$apiproxy.dsh-bash-terminal.bak"

function Set-ApiProxyAllowlist {
  if (-not (Test-Path $apiproxy)) {
    Write-Host "  WARN: dsh-host-apiproxy not found at $apiproxy" -ForegroundColor Yellow
    return
  }
  $content = Get-Content $apiproxy -Raw
  if ($content -match '"bash-terminal"') {
    Write-Host "  apiproxy allowlist already patched."
    return
  }
  Copy-Item $apiproxy $apiproxyBak -Force
  $replacement = @"
"web-search-deepseek",
	"bash-terminal" // dsh-bash-terminal: user-chosen default terminal
];
"@
  $content = $content -replace '"web-search-deepseek"\r?\n\];', $replacement
  Set-Content -Path $apiproxy -Value $content -Encoding UTF8
  Write-Host "  patched dsh-host-apiproxy allowlist (backup saved)."
}

function Restore-ApiProxyAllowlist {
  if (Test-Path $apiproxyBak) {
    $content = Get-Content $apiproxy -Raw
    if ($content -match '"bash-terminal"') {
      Copy-Item $apiproxyBak $apiproxy -Force
      Write-Host "  restored apiproxy allowlist from backup."
    }
  }
}

if ($Action -eq "install") {
  Write-Host "[1/4] link plugin into profile node_modules ..."
  New-Junction $pluginLink $pluginDir

  Write-Host "[2/4] link @deepseek-ai deps into plugin node_modules ..."
  New-Junction $depLink (Join-Path $profileDir "..\node_modules\@deepseek-ai")

  Write-Host "[3/4] patch dsh-host-apiproxy settings allowlist ..."
  Set-ApiProxyAllowlist

  Write-Host "[4/5] migrate to official bundle install (dsh.bundle) ..."
  $profilePkg = Join-Path $profileDir "package.json"
  if (Test-Path $profilePkg) {
    $pkg = Get-Content $profilePkg -Raw | ConvertFrom-Json
    $bundles = @($pkg.dsh.profile.bundles)
    if ($bundles -contains "dsh-bash-terminal") {
      Write-Host "  profile already lists dsh-bash-terminal bundle."
    } else {
      $bundles += "dsh-bash-terminal"
      $pkg.dsh.profile.bundles = @($bundles | Sort-Object -Unique)
      # PS 5.1 Set-Content -Encoding UTF8 writes a BOM, which breaks JSON.parse;
      # write without BOM via .NET.
      $json = $pkg | ConvertTo-Json -Depth 6
      [System.IO.File]::WriteAllText($profilePkg, $json, (New-Object System.Text.UTF8Encoding($false)))
      Write-Host "  added dsh-bash-terminal to dsh.profile.bundles (no BOM)."
    }
  } else {
    Write-Host "  WARN: $profilePkg not found; add dsh-bash-terminal to dsh.profile.bundles manually." -ForegroundColor Yellow
  }

  Write-Host "[5/5] append mount row to cordis.patch.yml (legacy fallback) ..."
  if (Test-Path $patchFile) {
    $content = Get-Content $patchFile -Raw
    if ($content -notmatch "dsh-bash-terminal") {
      Add-Content -Path $patchFile -Value ($patchBlock -replace "\r?\n$", "") -Encoding UTF8
      Write-Host "  patch appended: $patchFile"
    } else {
      Write-Host "  patch already contains dsh-bash-terminal, skip."
    }
  } else {
    Write-Host "  WARN: $patchFile not found - add the mount row manually." -ForegroundColor Yellow
  }

  Write-Host ""
  Write-Host "Done! Restart dsh web for the plugin to take effect:"
  Write-Host "  1) close the running dsh web (Ctrl+C or kill the process)"
  Write-Host "  2) run:  dsh web"
  Write-Host "After restart, open Settings -> General: a 'Default terminal' dropdown"
  Write-Host "(PowerShell / Git Bash / WSL) appears; the shell tool obeys it."
} else {
  Write-Host "[1/3] remove links ..."
  if (Test-Path $pluginLink) { Remove-Item $pluginLink -Force -Recurse; Write-Host "  removed: $pluginLink" }
  if (Test-Path $depLink) { Remove-Item $depLink -Force -Recurse; Write-Host "  removed: $depLink" }

  Write-Host "[2/3] restore dsh-host-apiproxy allowlist ..."
  Restore-ApiProxyAllowlist

  Write-Host "[3/3] remove mount block from cordis.patch.yml ..."
  if (Test-Path $patchFile) {
    $content = Get-Content $patchFile -Raw
    $pattern = "(?s)[ \t]*# =+ dsh-bash-terminal =+.*?\n- insert:\n    - id: tool-bash-terminal\n      name: 'dsh-bash-terminal'\n*"
    if ($content -match $pattern) {
      $content = $content -replace $pattern, ""
      Set-Content -Path $patchFile -Value $content -Encoding UTF8
      Write-Host "  patch block removed."
    } else {
      Write-Host "  no dsh-bash-terminal block found in patch."
    }
  }
  Write-Host "Uninstalled. Restart dsh web; the shell tool disappears."
}
