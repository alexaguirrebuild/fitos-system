import { defineConfig, devices } from "@playwright/test";

/**
 * E2E de los flujos diarios contra la app compilada y una PGlite nueva en .data/e2e.
 * Seguridad: DATABASE_URL vacía en el entorno hace que Next ignore la de cualquier .env (process.env manda)
 * y, aunque se colara, sin ella no hay modo dev: la app pediría contraseña y las pruebas no escribirían nada.
 * Las credenciales de Drive también se vacían: ninguna prueba sube nada al Drive real.
 * `npm run e2e` no compila: arranca `next start` sobre el `.next` que haya. Antes, `npm run build`.
 * Los ficheros dependen del orden (01 → 04, un worker): 01 espera Hoy sin check-in y 02 comparte la sesión entre sus dos tests.
 */
const PORT = 3100;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1, // una sola base compartida: los flujos van en fila
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    ...devices["Pixel 7"],
    baseURL: `http://localhost:${PORT}`,
    locale: "es-ES",
    timezoneId: "Europe/Madrid",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `npx tsx e2e/fixture.mts && npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}/login`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      DATABASE_URL: "",
      AUTH_MODE: "dev",
      PGLITE_DIR: ".data/e2e",
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
      GOOGLE_REFRESH_TOKEN: "",
      DRIVE_ROOT_FOLDER_ID: "",
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
});
