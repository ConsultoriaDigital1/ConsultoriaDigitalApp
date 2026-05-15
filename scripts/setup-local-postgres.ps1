$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$version = "16.14-1"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$localDir = Join-Path $root ".local"
$postgresDir = Join-Path $localDir "postgres"
$archive = Join-Path $localDir "postgresql-$version-windows-x64-binaries.zip"
$postgresExe = Join-Path $postgresDir "pgsql\bin\postgres.exe"
$url = "https://get.enterprisedb.com/postgresql/postgresql-$version-windows-x64-binaries.zip"

New-Item -ItemType Directory -Force -Path $localDir | Out-Null

if (Test-Path $postgresExe) {
  Write-Host "PostgreSQL portable ya esta descargado."
  exit 0
}

if (-not (Test-Path $archive)) {
  Write-Host "Descargando PostgreSQL portable $version..."
  Invoke-WebRequest -Uri $url -OutFile $archive
}

if (Test-Path $postgresDir) {
  Remove-Item -Recurse -Force $postgresDir
}

Write-Host "Extrayendo PostgreSQL portable..."
Expand-Archive -Path $archive -DestinationPath $postgresDir -Force

if (-not (Test-Path $postgresExe)) {
  throw "No se encontro postgres.exe despues de extraer el ZIP."
}

Write-Host "PostgreSQL portable listo."
