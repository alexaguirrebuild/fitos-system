import { expect, test } from "@playwright/test";

test("entra en modo dev y Hoy enseña la sesión que toca", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL("/"); // sin pasar por /login ni por el onboarding
  await expect(page.getByRole("link", { name: "día 1 de 7" })).toBeVisible();
  await expect(page.getByText("Torso A").first()).toBeVisible();
  await expect(page.getByText("Press banca").first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Hacer check-in" })).toBeVisible();
});
