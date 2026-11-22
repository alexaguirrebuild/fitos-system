import { expect, test, type Page } from "@playwright/test";

/** Kcal comidas hoy, del marcador «consumidas / objetivo» (p. ej. «375 / 2.868»). */
const kcalHoy = async (page: Page): Promise<number> => {
  const t = await page.getByText(/^[\d.]+ \/ [\d.]+$/).first().innerText();
  return Number(t.split("/")[0].trim().replace(/\./g, ""));
};

test("añadir un alimento buscando y otro tecleando el código de barras", async ({ page }) => {
  await page.goto("/nutricion");
  const start = await kcalHoy(page);

  // Buscar
  await page.getByRole("button", { name: "Buscar", exact: true }).click();
  await page.getByPlaceholder("pollo, avena, yogur…").fill("avena");
  await page.getByRole("button", { name: /Copos de avena extra suaves/ }).click();
  await page.getByRole("button", { name: "Añadir", exact: true }).click();
  await expect.poll(() => kcalHoy(page)).toBe(start + 375); // 100 g a 375 kcal/100 g

  // Código de barras a mano (la cámara no se prueba)
  await page.getByRole("button", { name: "Escanear" }).click();
  await page.getByRole("textbox", { name: "Código de barras" }).fill("8480000057105");
  await page.getByRole("dialog").getByRole("button", { name: "Buscar", exact: true }).click();
  await expect(page.getByText(/Pechuga de pavo cocida/).first()).toBeVisible();
  await page.getByRole("button", { name: "Añadir", exact: true }).click();
  await expect.poll(() => kcalHoy(page)).toBeGreaterThan(start + 375);
  await expect(page.getByText("2 apuntes")).toBeVisible();
});
