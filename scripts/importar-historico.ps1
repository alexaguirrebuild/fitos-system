# Importa en producción el histórico de la app antigua (SISTEMA-ALEX-APP): sesiones, series y check-ins.
# Pide la contraseña de la base sin mostrarla y no la guarda en ningún sitio. Es idempotente: repetirlo no duplica.
$ErrorActionPreference = "Stop"
Set-Location "$HOME\Documents\sistema-fisico-wt-hc"

$export = "$HOME\Documents\VIDA\_datos\supabase-2026-11-15"
if (-not (Test-Path "$export\entrenos.json")) { throw "No encuentro $export\entrenos.json" }
$email = Read-Host "Tu email de la app (el mismo con el que entras)"

$sec = Read-Host "Contraseña de la base de datos de Supabase" -AsSecureString
$pw = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
$env:DATABASE_URL = "postgresql://postgres.gmxzktvjuwtohuarztvn:$pw@aws-1-eu-west-1.pooler.supabase.com:6543/postgres"
$env:DATABASE_CA_CERT = Get-Content "$HOME\Downloads\prod-ca-2021.crt" -Raw
try {
  npm run import:legacy -- "$export" "$email"
} finally {
  Remove-Item Env:DATABASE_URL, Env:DATABASE_CA_CERT -ErrorAction SilentlyContinue
}
Write-Host "Listo. Mira Progreso y Entreno en https://fitos-system.vercel.app"
