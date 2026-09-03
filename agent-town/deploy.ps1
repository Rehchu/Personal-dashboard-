# deploy.ps1 — one-command Dyer Town -> Fly.io.
#
# Two things only YOU can do first:
#   1) Have a Fly.io account with a card on file.
#   2) On THIS PC (already logged in to Claude), run:  claude setup-token
#      and copy the token it prints.
#
# Then, from the agent-town folder:   .\deploy.ps1
# It does everything else: installs the Fly CLI, logs you in, creates the app +
# volume, sets your secrets (read hidden, never written to disk), and deploys.

#Requires -Version 5
$ErrorActionPreference = 'Stop'

function Say($m) { Write-Host $m -ForegroundColor Cyan }

# 1) Fly CLI ------------------------------------------------------------------
if (-not (Get-Command fly -ErrorAction SilentlyContinue)) {
  Say "Installing the Fly CLI..."
  Invoke-WebRequest https://fly.io/install.ps1 -UseBasicParsing | Invoke-Expression
  $env:Path = "$env:USERPROFILE\.fly\bin;$env:Path"
}
if (-not (Get-Command fly -ErrorAction SilentlyContinue)) {
  Write-Error "Fly CLI still not on PATH. Close and reopen PowerShell, then re-run."; exit 1
}

# 2) Logged in? ---------------------------------------------------------------
try { fly auth whoami 2>$null | Out-Null } catch {
  Say "Logging you in to Fly (a browser will open)..."
  fly auth login
}

# 3) App name + region --------------------------------------------------------
$app = Read-Host "App name (globally unique, letters/numbers/dashes, e.g. dyer-town-bradly)"
if ([string]::IsNullOrWhiteSpace($app)) { Write-Error "An app name is required."; exit 1 }
$region = Read-Host "Fly region nearest you [iad]"
if ([string]::IsNullOrWhiteSpace($region)) { $region = 'iad' }

# 4) Create the app if it isn't there yet -------------------------------------
$exists = $true
try { fly status --app $app 2>$null | Out-Null } catch { $exists = $false }
if (-not $exists) { Say "Creating app $app..."; fly apps create $app }

# 5) Bake the name + region into fly.toml -------------------------------------
(Get-Content fly.toml) `
  -replace '^app = ".*"', ('app = "' + $app + '"') `
  -replace '^primary_region = ".*"', ('primary_region = "' + $region + '"') |
  Set-Content fly.toml
Say "fly.toml set to app=$app region=$region."

# 6) Persistent volume (create once) ------------------------------------------
$hasVol = $false
try { if ((fly volumes list --app $app 2>$null | Out-String) -match 'town_data') { $hasVol = $true } } catch {}
if (-not $hasVol) {
  Say "Creating the 5 GB persistent volume..."
  fly volumes create town_data --size 5 --region $region --app $app --yes
}

# 7) Secrets (read hidden; never written to disk) -----------------------------
Say "`nSecrets — typed hidden, sent straight to Fly."
function Plain($s) {
  if (-not $s -or $s.Length -eq 0) { return '' }
  [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
}
$claude  = Plain (Read-Host "CLAUDE_CODE_OAUTH_TOKEN (from 'claude setup-token')" -AsSecureString)
$townkey = Plain (Read-Host "TOWN_KEY (your dashboard sync passphrase)"           -AsSecureString)
if (-not $claude -or -not $townkey) { Write-Error "Both CLAUDE_CODE_OAUTH_TOKEN and TOWN_KEY are required."; exit 1 }
$cf = Plain (Read-Host "CF_TOKEN (optional Cloudflare deploy token; Enter to skip)"        -AsSecureString)
$gh = Plain (Read-Host "GITHUB_TOKEN (optional fine-grained PAT for pushes; Enter to skip)" -AsSecureString)

$pairs = @("CLAUDE_CODE_OAUTH_TOKEN=$claude", "TOWN_KEY=$townkey")
if ($cf) { $pairs += "CF_TOKEN=$cf" }
if ($gh) { $pairs += "GITHUB_TOKEN=$gh" }
Say "Staging secrets..."
fly secrets set @pairs --app $app --stage

# 8) Deploy -------------------------------------------------------------------
Say "Deploying (this builds the image and starts the machine)..."
fly deploy --app $app

Write-Host "`nDone." -ForegroundColor Green
Write-Host "Watch it boot:   fly logs --app $app"        -ForegroundColor Green
Write-Host "Then open your dashboard's Dyer Town tile — and STOP the PC town so only one runs." -ForegroundColor Yellow
