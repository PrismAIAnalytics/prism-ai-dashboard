#requires -Version 5.1
<#
.SYNOPSIS
    Snapshot live Railway prism.db files via /api/admin/backup-db.

.DESCRIPTION
    Downloads a consistent point-in-time copy of each service's SQLite DB
    (VACUUM INTO on the server side, streamed back as an attachment).
    Saves into ./backups/ with a UTC timestamp.

    Admin keys are read from env vars so they don't end up in shell history:
        $env:DABE_ADMIN_KEY   = "..."
        $env:LEGACY_ADMIN_KEY = "..."

.EXAMPLE
    $env:DABE_ADMIN_KEY   = "pO09..."
    $env:LEGACY_ADMIN_KEY = "<7058a key>"
    .\scripts\backup-prod-dbs.ps1
#>

[CmdletBinding()]
param(
    [string] $BackupDir = (Join-Path $PSScriptRoot '..\backups'),
    [string] $DabeUri   = 'https://dashboard-api-production-dabe.up.railway.app/api/admin/backup-db',
    [string] $LegacyUri = 'https://web-production-7058a.up.railway.app/api/admin/backup-db'
)

$ErrorActionPreference = 'Stop'

function Invoke-Backup {
    param(
        [Parameter(Mandatory)] [string] $Label,
        [Parameter(Mandatory)] [string] $Uri,
        [Parameter(Mandatory)] [string] $AdminKey,
        [Parameter(Mandatory)] [string] $OutFile
    )

    if ([string]::IsNullOrWhiteSpace($AdminKey)) {
        Write-Warning "[$Label] admin key not set; skipping."
        return
    }

    Write-Host "[$Label] downloading -> $OutFile"
    try {
        Invoke-WebRequest -Uri $Uri -Headers @{ 'X-Admin-Key' = $AdminKey } -OutFile $OutFile -UseBasicParsing
        $info = Get-Item $OutFile
        "  OK  {0:N0} bytes" -f $info.Length | Write-Host -ForegroundColor Green
    } catch {
        Write-Warning "[$Label] failed: $($_.Exception.Message)"
    }
}

# Ensure target dir
if (-not (Test-Path $BackupDir)) {
    New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
}
$BackupDir = (Resolve-Path $BackupDir).Path

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

Invoke-Backup -Label 'dabe'   -Uri $DabeUri   -AdminKey $env:DABE_ADMIN_KEY   -OutFile (Join-Path $BackupDir "prism-dabe-$stamp.db")
Invoke-Backup -Label 'legacy' -Uri $LegacyUri -AdminKey $env:LEGACY_ADMIN_KEY -OutFile (Join-Path $BackupDir "prism-7058a-$stamp.db")

Write-Host ''
Write-Host 'Backups on disk:'
Get-ChildItem $BackupDir | Select-Object Name, Length, LastWriteTime | Format-Table
