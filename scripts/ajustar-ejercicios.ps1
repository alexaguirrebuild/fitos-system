# Ajustes del 22-nov en producción, con el OK de Alex:
#  - fusiona «Remo con pecho apoyado en banco en multipower» en «Remo ancho apoyado en MP» y borra el vacío;
#  - pone mancuernas a la elevación frontal (en tu copia; el seed cambia la común);
#  - quita los alias que eran notas (lista en VIDA, columna «quitar»).
# 1/3 Simulacro, sin escribir (y pide confirmación).  2/3 Seed (idempotente).  3/3 Ajustes.  Repetirlo no hace nada.
# Pide la contraseña de la base sin mostrarla y no la guarda en ningún sitio.
param(
  [string]$Email,
  [string]$Alias = (Join-Path $HOME "Documents/VIDA/entrenamiento/alias-a-quitar-2026-11-22.md")
)
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

if (-not (Test-Path $Alias)) { throw "No encuentro la lista de alias en $Alias" }
$ca = Join-Path $HOME "Downloads/prod-ca-2021.crt"
if (-not (Test-Path $ca)) { throw "No encuentro el certificado de Supabase en $ca" }
$email = if ($Email) { $Email } else { Read-Host "Tu email de la app (el mismo con el que entras)" }
$ajustes = @("--alias", $Alias, "--fusionar", "remo-pecho-apoyado-banco-multipower:remo-ancho-apoyado-en-mp", "--equipo", "elevacion-frontal-banco-inclinado=mancuernas")

$sec = Read-Host "Contraseña de la base de datos de Supabase" -AsSecureString

# Todo lo que toca la contraseña va dentro del try: si algo falla o pulsas Ctrl+C, el finally la borra de la sesión.
try {
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  try { $pw = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  $env:DATABASE_URL = "postgresql://postgres.gmxzktvjuwtohuarztvn:$([Uri]::EscapeDataString($pw))@aws-1-eu-west-1.pooler.supabase.com:6543/postgres"
  Remove-Variable pw
  $env:DATABASE_CA_CERT = Get-Content $ca -Raw

  # El simulacro también para aquí si db:seed fuera a aplicar migraciones o si el plan no cuadra con el seed.
  Write-Host "`n== 1/3 Simulacro (no escribe nada) ==" -ForegroundColor Cyan
  npm run --silent ajustar:ejercicios -- "$email" @ajustes --dry-run
  if ($LASTEXITCODE -ne 0) { throw "El simulacro falló. No se ha escrito nada." }

  $ok = Read-Host "`n¿Aplico el seed y los ajustes en producción? Escribe SI para seguir"
  if ($ok -cne "SI") { Write-Host "Cancelado. No se ha escrito nada."; return }

  Write-Host "`n== 2/3 Seed del catálogo (idempotente) ==" -ForegroundColor Cyan
  npm run --silent db:seed
  if ($LASTEXITCODE -ne 0) { throw "El seed falló. No se ha ajustado nada." }

  Write-Host "`n== 3/3 Ajustes ==" -ForegroundColor Cyan
  npm run --silent ajustar:ejercicios -- "$email" @ajustes
  if ($LASTEXITCODE -ne 0) { throw "Los ajustes fallaron (arriba). Repetir el script es seguro: lo ya hecho no se repite." }
} finally {
  Remove-Item Env:DATABASE_URL, Env:DATABASE_CA_CERT -ErrorAction SilentlyContinue
  Remove-Variable pw, sec -ErrorAction SilentlyContinue
}
Write-Host "`nListo. Mira el remo ancho en Librería y su historial en https://fitos-system.vercel.app"
