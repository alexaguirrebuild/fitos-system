# Enlaza en producción las series del histórico que quedaron sin ejercicio, con el mapa aprobado (en VIDA).
# 1) Simulacro: lista lo que haría, sin escribir nada.  2) Pide confirmación.
# 3) Aplica el seed (da de alta los 7 ejercicios nuevos; idempotente).  4) Enlaza.  Repetirlo no hace nada.
# Pide la contraseña de la base sin mostrarla y no la guarda en ningún sitio.
param(
  [string]$Email,
  [string]$Mapa = "$HOME\Documents\VIDA\entrenamiento\mapa-huerfanos-2026-11-22.md"
)
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

if (-not (Test-Path $Mapa)) { throw "No encuentro el mapa en $Mapa" }
$ca = "$HOME\Downloads\prod-ca-2021.crt"
if (-not (Test-Path $ca)) { throw "No encuentro el certificado de Supabase en $ca" }
$email = if ($Email) { $Email } else { Read-Host "Tu email de la app (el mismo con el que entras)" }

$sec = Read-Host "Contraseña de la base de datos de Supabase" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
$pw = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
$env:DATABASE_URL = "postgresql://postgres.gmxzktvjuwtohuarztvn:$([Uri]::EscapeDataString($pw))@aws-1-eu-west-1.pooler.supabase.com:6543/postgres"
$env:DATABASE_CA_CERT = Get-Content $ca -Raw
Remove-Variable pw

try {
  Write-Host "`n== 1/3 Simulacro (no escribe nada) ==" -ForegroundColor Cyan
  npm run --silent enlazar:huerfanos -- "$Mapa" "$email" --dry-run
  if ($LASTEXITCODE -ne 0) { throw "El simulacro falló. No se ha escrito nada." }
  Write-Host "`nLas filas con 'slug sin dar de alta' son los 7 ejercicios nuevos: el seed del paso 2 los crea." -ForegroundColor Yellow

  $ok = Read-Host "`n¿Aplico el seed y enlazo en producción? Escribe SI para seguir"
  if ($ok -cne "SI") { Write-Host "Cancelado. No se ha escrito nada."; return }

  Write-Host "`n== 2/3 Seed del catálogo (idempotente) ==" -ForegroundColor Cyan
  npm run --silent db:seed
  if ($LASTEXITCODE -ne 0) { throw "El seed falló. No se ha enlazado nada." }

  Write-Host "`n== 3/3 Enlace ==" -ForegroundColor Cyan
  npm run --silent enlazar:huerfanos -- "$Mapa" "$email"
  if ($LASTEXITCODE -ne 0) { throw "El enlace terminó con errores (arriba). Lo enlazado se queda; repetir el script sigue donde se quedó." }
} finally {
  Remove-Item Env:DATABASE_URL, Env:DATABASE_CA_CERT -ErrorAction SilentlyContinue
}
Write-Host "`nListo. Mira Progreso y Entreno en https://fitos-system.vercel.app"
