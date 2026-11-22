import { expect, test, type Locator, type Page } from "@playwright/test";

/** Los dos tests comparten la sesión: el primero la abre y cambia un ejercicio, el segundo apunta y cierra. */
test.describe.configure({ mode: "serial" });
let sessionUrl = "";

const PLAN = [
  "Press banca",
  "Press inclinado con mancuernas",
  "Press militar en máquina",
  "Fondos en máquina",
  "Elevaciones laterales en polea",
  "Extensión de tríceps katana en polea",
  "Tríceps en polea con cuerda",
];

const items = (page: Page) => page.getByRole("main").getByRole("list").first().getByRole("listitem");
const item = (page: Page, name: string): Locator => items(page).filter({ has: page.getByText(name, { exact: true }) });

/** Nombre de cada ejercicio de la lista, en orden. */
async function order(page: Page): Promise<string[]> {
  const names: string[] = [];
  for (const li of await items(page).all()) names.push((await li.innerText()).split("\n")[0].trim());
  return names;
}

test("empezar la sesión de hoy y cambiar un ejercicio sin que se descoloque", async ({ page }) => {
  await page.goto("/entreno");
  await page.getByRole("button", { name: "Empezar Torso A" }).click();
  await expect(page).toHaveURL(/\/entreno\/[0-9a-f-]{36}$/);
  sessionUrl = page.url();
  await expect(page.getByRole("heading", { name: "Torso A" })).toBeVisible();
  await expect.poll(() => order(page)).toEqual(PLAN);

  // Abrir el tercero y cambiarlo por la variante Hammer.
  await item(page, "Press militar en máquina").getByRole("button").first().click();
  await item(page, "Press militar en máquina").getByRole("button", { name: "Cambiar ejercicio" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(/La pauta \(series, rango y RIR\) se conserva/)).toBeVisible();
  await dialog.getByRole("button", { name: /^Press militar en máquina Hammer/ }).click();
  await expect(dialog).toBeHidden();

  // Misma posición y misma pauta: 3 series de 8-10 a RIR 2.
  const expected = PLAN.map((n) => (n === "Press militar en máquina" ? "Press militar en máquina Hammer" : n));
  const checkSwap = async () => {
    const hammer = item(page, "Press militar en máquina Hammer");
    await expect(hammer.getByText("En lugar de Press militar en máquina")).toBeVisible();
    await expect(hammer.getByText("0/3")).toBeVisible();
    await expect(hammer.getByText(/^8-10\s*reps$/)).toBeVisible();
    await expect(hammer.getByText("· RIR 2")).toBeVisible();
    await expect.poll(() => order(page)).toEqual(expected);
  };
  await checkSwap();

  // Tras recargar sigue igual: el cambio está guardado, no solo en pantalla.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Torso A" })).toBeVisible();
  await item(page, "Press militar en máquina Hammer").getByRole("button").first().click();
  await checkSwap();
});

test("apuntar dos series, cerrar la sesión y verla en el historial", async ({ page }) => {
  expect(sessionUrl, "el test anterior abre la sesión").not.toBe("");
  await page.goto(sessionUrl);
  const banca = item(page, "Press banca");
  // Al abrir, la fila activa es la del siguiente ejercicio con series pendientes: el press banca.
  await expect(banca.getByRole("button", { name: "Hecha" })).toBeVisible();

  // Reps distintas: una serie idéntica en menos de 20 s se toma por doble toque y no se guarda (logSetTx).
  for (const [n, reps] of [[1, "5"], [2, "4"]] as const) {
    await banca.getByRole("textbox", { name: "Carga" }).fill("60");
    await banca.getByRole("textbox", { name: "Reps" }).fill(reps);
    await banca.getByRole("button", { name: "Hecha" }).click();
    await expect(banca.getByText(`${n}/4`)).toBeVisible();
    await page.getByRole("button", { name: "Saltar" }).click(); // el descanso
  }

  await page.getByRole("button", { name: "Cerrar sesión" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "8", exact: true }).click();
  await dialog.getByRole("button", { name: "Guardar y cerrar" }).click();
  await expect(page.getByText("Torso A cerrada")).toBeVisible();
  await expect(page.getByText("540 kg")).toBeVisible(); // 60 × 5 + 60 × 4

  await page.goto("/entreno");
  await expect(page.locator("#ultimas").getByText("Torso A")).toBeVisible();
});
