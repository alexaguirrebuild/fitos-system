import { defineConfig, devices } from "@playwright/test";

/**
 * E2E de los flujos diarios contra la app compilada y una PGlite nueva en .data/e2e.
 * Seguridad: DATABASE_URL vacía en el entorno hace que Next ignore la de cualquier .env (process.env manda)
 * y, aunque se colara, sin ella no hay modo dev: la app pediría contraseña y las pruebas no escribirían nada.
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
    env: { DATABASE_URL: "", AUTH_MODE: "dev", PGLITE_DIR: ".data/e2e", NEXT_TELEMETRY_DISABLED: "1" },
  },
});
