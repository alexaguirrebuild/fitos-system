import type { Metadata } from "next";
import { sessionOrLogin } from "@/app/_server/session";
import { getAthlete, getOnboardingStatus, listInjuries, listSchedule } from "@/server/services/athlete";
import { getActivePlan, listProgramTemplates } from "@/server/services/plan";
import { listBodyMetrics } from "@/server/services/wellness";
import { todayIn } from "@/server/time";
import { Wizard, type WizardInitial } from "./wizard";

export const metadata: Metadata = { title: "Tu ficha" };

export default async function OnboardingPage() {
  const userId = await sessionOrLogin("/onboarding");
  const [athlete, status, schedule, injuries, metrics, plan] = await Promise.all([
    getAthlete(userId),
    getOnboardingStatus(userId),
    listSchedule(userId),
    listInjuries(userId),
    listBodyMetrics(userId, { days: 1830 }),
    getActivePlan(userId),
  ]);
  const { templates } = listProgramTemplates();
  const lastWeight = metrics.find((m) => m.weightKg != null);
  const lastWaist = metrics.find((m) => m.waistCm != null);
  const lastNeck = metrics.find((m) => m.neckCm != null);
  const ankle = injuries.find((i) => i.zone === "tobillo") ?? null;

  const initial: WizardInitial = {
    today: todayIn(athlete.timezone),
    heightCm: athlete.heightCm,
    heightConfirmed: athlete.heightConfirmed,
    birthDate: athlete.birthDate,
    hrRest: athlete.hrRest,
    bedtime: athlete.bedtime ? athlete.bedtime.slice(0, 5) : null,
    adhdMedication: athlete.adhdMedication,
    weeklyFoodBudgetEur: athlete.weeklyFoodBudgetEur,
    stores: athlete.stores,
    lastWeight: lastWeight ? { value: lastWeight.weightKg!, date: lastWeight.date } : null,
    lastWaist: lastWaist ? { value: lastWaist.waistCm!, date: lastWaist.date } : null,
    lastNeck: lastNeck ? { value: lastNeck.neckCm!, date: lastNeck.date } : null,
    ankle: ankle ? { status: ankle.status, lastPain: ankle.lastPain, lastPainDate: ankle.lastPainDate, limits: ankle.limits } : null,
    classes: schedule.filter((b) => b.kind === "clase" && b.weekday != null && b.start && b.end).map((b) => ({ title: b.title, weekday: b.weekday!, start: b.start!, end: b.end! })),
    exams: schedule.filter((b) => b.kind === "examen" && b.from && b.to).map((b) => ({ title: b.title, from: b.from!, to: b.to! })),
    templates: templates.map((t) => ({
      slug: t.slug,
      name: t.name,
      weeks: t.weeks,
      source: t.source,
      microcycleDays: t.mesocycles[0]?.microcycleDays ?? 7,
      sessions: t.mesocycles[0]?.sessions ?? [],
    })),
    activeProgram: plan ? plan.macrocycle.name : null,
    contradictions: status.contradictions,
    missing: status.missing,
  };

  return <Wizard initial={initial} />;
}
