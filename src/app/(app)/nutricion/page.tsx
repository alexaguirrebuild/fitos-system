import type { Metadata } from "next";
import { Empty, Meter, PageHeader, Section } from "@/components/ui";
import { sessionOrLogin } from "@/app/_server/session";
import { day, int } from "@/lib/format";
import { MEALS, getNutritionDay, getTargets, listMealTemplates, type Meal } from "@/server/services/nutrition";
import { addDays } from "@/server/time";
import { AddFood } from "./add";
import { Caffeine, DayTypeSwitch, LogRow, Shopping, Targets } from "./controls";

export const metadata: Metadata = { title: "Comida" };

const MEAL_LABEL: Record<Meal, string> = { desayuno: "Desayuno", comida: "Comida", cena: "Cena", pre: "Pre-entreno", intra: "Intra-entreno", post: "Post-entreno", snack: "Snack" };
const PHASE: Record<string, string> = { calibracion: "Calibración", deficit: "Déficit", mantenimiento: "Mantenimiento", superavit: "Superávit" };

export default async function NutricionPage() {
  const userId = await sessionOrLogin("/nutricion");
  const d = await getNutritionDay(userId);
  const [yesterday, templates, targets] = await Promise.all([
    getNutritionDay(userId, { date: addDays(d.date, -1) }), listMealTemplates(userId, { dayType: d.dayType }), getTargets(userId, { date: d.date }),
  ]);
  const yMeals = MEALS.filter((m) => yesterday.byMeal[m]).map((m) => ({ meal: m, label: MEAL_LABEL[m], kcal: Math.round(yesterday.byMeal[m]!.kcal), items: yesterday.byMeal[m]!.items }));
  const t = d.target;

  return (
    <main className="page">
      <PageHeader title="Comida" sub={`${day(d.date)} · ${d.phase ? PHASE[d.phase] : "sin objetivos"}`} />

      <DayTypeSwitch dayType={d.dayType} forced={d.dayTypeForced} assumed={d.dayTypeAssumed} />

      {t && d.remaining ? (
        <div className="mt-6 grid gap-5">
          <div>
            <div className="flex items-baseline justify-between gap-3">
              <p>
                <span className="display text-[2.5rem]">{int(Math.max(0, d.remaining.kcal))}</span> <span className="muted">kcal {d.remaining.kcal < 0 ? `· ${int(-d.remaining.kcal)} de más` : "restantes"}</span>
              </p>
              <p className="fig small muted">{int(d.totals.kcal)} / {int(t.kcal)}</p>
            </div>
            <div className="mt-2"><Meter label="Calorías del día" value={d.totals.kcal} max={t.kcal} accent={d.remaining.kcal < 0} /></div>
          </div>
          <div>
            <div className="flex items-baseline justify-between gap-3">
              <p>
                <span className="display text-[2rem]">{int(Math.max(0, d.remaining.proteinG))}</span> <span className="muted">g de proteína {d.remaining.proteinG <= 0 ? "· cubierta" : "restantes"}</span>
              </p>
              <p className="fig small muted">{int(d.totals.proteinG)} / {int(t.proteinG)} g</p>
            </div>
            <div className="mt-2"><Meter label="Proteína del día" value={d.totals.proteinG} max={t.proteinG} /></div>
          </div>
          <p className="fig small muted">Hidratos {int(d.totals.carbsG)} / {int(t.carbsG)} g · Grasa {int(d.totals.fatG)} / {int(t.fatG)} g</p>
        </div>
      ) : (
        <div className="mt-6">
          <Empty title="Aún no hay objetivos de calorías">Hace falta peso, altura y fecha de nacimiento. Calcúlalos en «Objetivos», más abajo. Lo que comas se registra igual.</Empty>
          <p className="fig small muted mt-3">Hoy: {int(d.totals.kcal)} kcal · {int(d.totals.proteinG)} g P</p>
        </div>
      )}

      <AddFood today={d.date} templates={templates.map((x) => ({ id: x.id, name: x.name, kcal: x.kcal, proteinG: x.proteinG }))} yesterday={yMeals} yesterdayDate={yesterday.date} />

      <Section title="Hoy" id="hoy" aside={<span className="fig">{d.logs.length} {d.logs.length === 1 ? "apunte" : "apuntes"}</span>}>
        {d.logs.length === 0 ? (
          <Empty title="Nada registrado hoy">Escanea, busca o repite una comida. Tres toques como mucho.</Empty>
        ) : (
          MEALS.filter((m) => d.byMeal[m]).map((m) => (
            <div key={m} className="mb-4">
              <div className="flex items-baseline justify-between border-b border-line-strong pb-1.5">
                <h3 className="font-medium">{MEAL_LABEL[m]}</h3>
                <span className="fig small muted">{int(d.byMeal[m]!.kcal)} kcal · {int(d.byMeal[m]!.proteinG)} g P</span>
              </div>
              <ul>
                {d.logs.filter((l) => l.meal === m).map((l) => (
                  <LogRow key={l.id} log={{ id: l.id, name: l.foodName ?? l.description ?? "Apunte", grams: l.grams, kcal: l.kcal, proteinG: l.proteinG, estimated: l.estimated }} />
                ))}
              </ul>
            </div>
          ))
        )}
      </Section>

      <Section title="Cafeína" id="cafeina" aside={d.caffeine.cutoff ? <span className="fig">corte {d.caffeine.cutoff}</span> : "sin hora de acostarte"}>
        <Caffeine todayMg={d.caffeine.todayMg} maxMg={d.caffeine.maxMg} lateDoses={d.caffeine.lateDoses} note={d.caffeine.note ?? null} />
      </Section>

      <Section title="Objetivos" id="objetivos">
        <Targets phase={d.phase ? PHASE[d.phase] : null} current={targets} />
      </Section>

      <Section title="Compra" id="compra">
        <Shopping />
      </Section>
    </main>
  );
}
