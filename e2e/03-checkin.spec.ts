import { expect, test } from "@playwright/test";

test("check-in y peso del día se ven en Hoy", async ({ page }) => {
  await page.goto("/bienestar");
  for (const name of ["Sueño", "Ganas de entrenar"]) {
    const s = page.getByRole("slider", { name, exact: true });
    await s.focus();
    await s.press("ArrowRight");
    await s.press("ArrowRight");
  }
  await page.getByRole("button", { name: "Guardar check-in" }).click();
  await expect(page.getByText(/Readiness \d+/).first()).toBeVisible();

  // Hoy: el readiness sale con su número y desaparece el aviso de check-in.
  await page.goto("/");
  await expect(page.getByRole("link", { name: /^Readiness \d+ de 100$/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "Hacer check-in" })).toHaveCount(0);

  // Peso: la tendencia baja de los 80 kg del alta al apuntar 79,4.
  const tile = page.getByRole("link", { name: /^Peso [\d,]+ kg/ });
  await expect(tile).toHaveAccessibleName(/^Peso 80 kg/);
  await page.getByRole("textbox", { name: /Peso de hoy/ }).fill("79,4");
  await page.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(tile).toHaveAccessibleName(/^Peso 79,\d kg/);
});
