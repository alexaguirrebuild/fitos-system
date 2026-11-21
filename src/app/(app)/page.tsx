import Link from "next/link";
import { BodyForm } from "@/components/body-form";
import { DismissButton } from "@/components/dismiss";
import { Row, Section } from "@/components/ui";
import { sessionOrLogin } from "@/app/_server/session";
import { ago, day, int, num, repRange, signed } from "@/lib/format";
import { getToday } from "@/server/services/today";

const KIND: Record<string, string> = { entreno: "Entreno", cardio: "Cardio", descanso: "Descanso", hecho: "Entreno hecho", sin_plan: "Sin programa" };

export default async function HoyPage() {
  const userId = await sessionOrLogin("/");
  const t = await getToday(userId);
  const a = t.nextAction;
  const tr = t.training;
  const n = t.nutrition;
  const session = tr?.next ?? null;

  const cta = a.kind === "empezar_sesion" ? "Empezar sesión" : a.kind === "continuar_sesion" ? "Continuar sesión" : a.kind === "checkin" ? "Hacer check-in" : a.kind === "pesaje" ? "Apuntar peso" : a.kind === "comida" ? "Registrar comida" : a.kind === "onboarding" ? "Completar ficha" : "Abrir";
  const kg = t.weight?.trendKg ?? t.weight?.lastKg ?? null;

  return (
    <main className="page">
      <header>
        <p className="small muted">
          {t.weekday.replace(/^./, (c) => c.toUpperCase())}, {day(t.date)}
          {tr?.plan ? <> · <Link className="link" href="/programa">día {tr.plan.microcycle.day} de {tr.plan.microcycle.lengthDays}</Link></> : ""}
        </p>
        <h1 className="display mt-3 text-[3rem]">{a.label}</h1>
        <p className="muted mt-3 max-w-[34ch]">{a.detail}</p>
        {a.kind !== "nada" ? (
          <Link href={a.href} className="btn btn-primary btn-lg btn-block mt-6">
            {cta}
          </Link>
        ) : null}
      </header>

      {t.load?.deload.deload ? (
        <div className="notice notice-warn mt-5" role="alert">
          <p className="notice-t">Toca descarga</p>
          <p className="muted small mt-1">{t.load.deload.signals.join(" · ")}</p>
          {t.load.deload.plan ? <p className="small mt-1">{t.load.deload.plan}</p> : null}
        </div>
      ) : t.load?.deload.maintenance ? (
        <p className="notice mt-5 small">Periodo de exámenes: semana de mantenimiento, sin subir volumen.</p>
      ) : null}
      {t.ankle?.restricted ? <p className="notice notice-warn mt-3 small">Tobillo restringido hoy: sin impacto.</p> : null}

      <section className="mt-8 grid grid-cols-3 gap-x-3 border-y border-line py-5" aria-label="Cifras de hoy">
        <Link href="/bienestar" className="min-w-0">
          <span className="small muted block">Readiness</span>
          <span className={`display mt-1 block text-[2.75rem] ${t.needsCheckin ? "faint" : ""}`}>{t.checkin?.readiness != null ? Math.round(t.checkin.readiness) : "—"}</span>
          <span className="micro faint mt-1 block truncate">{t.checkin?.readiness != null ? "de 100" : "sin check-in"}</span>
        </Link>
        <Link href="/progreso" className="min-w-0 border-l border-line pl-3">
          <span className="small muted block">Peso</span>
          <span className="display mt-1 block text-[2.75rem]">{kg != null ? num(kg) : "—"}</span>
          <span className={`micro mt-1 block truncate ${(t.weight?.daysSinceWeighIn ?? 0) > 3 ? "accent" : "faint"}`}>
            {t.weight?.weeklyRatePct != null ? `${signed(t.weight.weeklyRatePct, 2)} %/sem` : t.weight?.lastDate ? (t.weight.trendKg != null ? "kg, tendencia" : "kg, última") : "sin pesadas"}
          </span>
        </Link>
        <Link href="/nutricion" className="min-w-0 border-l border-line pl-3">
          <span className="small muted block">Proteína</span>
          <span className="display mt-1 block text-[2.75rem]">{n?.remaining ? int(Math.max(0, n.remaining.proteinG)) : "—"}</span>
          <span className="micro faint mt-1 block truncate">{n?.remaining ? "g restantes" : "sin objetivos"}</span>
        </Link>
      </section>

      <section className="rows mt-2" aria-label="Más estado">
        <Row
          href="/nutricion"
          k={n ? `Calorías · día ${n.dayType === "on" ? "On" : "Off"}` : "Comida"}
          v={n?.remaining ? <span className="fig">{int(n.remaining.kcal)} kcal</span> : n ? "Sin objetivos" : "Sin dato"}
          note={n?.remaining ? `restantes${n.dayTypeAssumed ? " · tipo de día supuesto" : ""}` : undefined}
        />
        <Row
          href="/cardio"
          k="Pasos"
          v={<span className="fig">{t.activity?.steps.done != null ? int(t.activity.steps.done) : "—"}{t.activity?.steps.goal != null ? ` / ${int(t.activity.steps.goal)}` : ""}</span>}
          note={t.activity?.steps.done == null ? "sin dato de hoy" : undefined}
        />
        <Row
          href="/progreso#carga"
          k="Carga"
          v={t.load ? (t.load.acwr.reliable && t.load.acwr.ratio != null ? <span className="fig">{num(t.load.acwr.ratio, 2)}</span> : "Aún sin ratio") : "Sin dato"}
          note={t.load ? t.load.acwr.label : undefined}
          warn={t.load?.acwr.zone === "pico" || t.load?.acwr.zone === "precaucion"}
        />
      </section>

      <section className="sec" id="sesion" aria-labelledby="sesion-t">
        <div className="mb-3 flex items-baseline justify-between gap-4">
          <h2 className="h-sec" id="sesion-t">{session ? session.name : tr ? KIND[tr.todayKind] : "Sesión"}</h2>
          {session?.plannedMinutes ? <span className="fig small muted">{session.plannedMinutes} min</span> : null}
        </div>
        {!tr || tr.todayKind === "sin_plan" ? (
          <p className="muted">
            No hay programa activo. <Link className="link" href="/ajustes#programa">Elige uno</Link> para ver la sesión del día.
          </p>
        ) : tr.inProgress ? (
          <p className="muted mb-3">
            En curso: <span className="fig text-fg">{tr.inProgress.exercisesDone}/{tr.inProgress.exercisesTotal}</span> ejercicios, <span className="fig text-fg">{num(tr.inProgress.hardSets)}</span> series efectivas.
          </p>
        ) : null}
        {tr?.doneToday.length ? (
          <ul className="rows mb-3">
            {tr.doneToday.map((d) => (
              <li key={d.workoutId}>
                <Row href={`/entreno/${d.workoutId}`} k={d.name ?? "Sesión"} v={<span className="fig">{num(d.hardSets)} series{d.tonnage != null ? ` · ${int(d.tonnage)} kg` : ""}</span>} note="hecha hoy" />
              </li>
            ))}
          </ul>
        ) : null}
        {session && session.exercises.length ? (
          <ol className="slab divide-y divide-line px-4">
            {session.exercises.map((e, k) => (
              <li key={e.exerciseId} className="flex items-center gap-3 py-3.5">
                <span className={`fig w-5 flex-none text-sm ${e.done ? "faint" : "muted"}`}>{k + 1}</span>
                <span className="min-w-0 flex-1">
                  <span className={`block font-semibold leading-snug ${e.done ? "faint line-through" : ""}`}>{e.name}</span>
                  {e.suggestion?.kg != null ? <span className="micro faint mt-0.5 block">{e.suggestion.why}</span> : null}
                </span>
                <span className="flex-none text-right">
                  <span className="display block text-[1.625rem]">
                    {e.suggestion?.kg != null ? <>{num(e.suggestion.kg, 2)}<span className="unit">kg</span></> : <>{e.sets}<span className="unit">series</span></>}
                  </span>
                  <span className="fig micro muted block">
                    × {repRange(e.repMin, e.repMax)}
                    {e.rirTarget != null ? ` · RIR ${num(e.rirTarget)}` : ""}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        ) : tr && tr.todayKind === "descanso" ? (
          <p className="muted">La rueda marca descanso. Pasos y a dormir.</p>
        ) : null}
      </section>

      <Section title="Peso" id="peso" aside={t.weight?.goalKg != null && t.weight.toGoalKg != null ? <span className="fig">{num(Math.abs(t.weight.toGoalKg))} kg al objetivo ({num(t.weight.goalKg)})</span> : undefined}>
        <BodyForm />
      </Section>

      <Section title="Anotaciones" id="notas">
        {t.annotations.length === 0 ? (
          <p className="muted">Nada pendiente. Aquí salen los avisos del motor al cerrar sesiones y registrar datos.</p>
        ) : (
          <ul className="rows">
            {t.annotations.slice(0, 6).map((x) => (
              <li key={x.id} className="row items-start">
                <span className="min-w-0">
                  <span className={`block font-semibold ${x.severity !== "info" ? "accent" : ""}`}>{x.title}</span>
                  {x.body ? <span className="small muted block">{x.body}</span> : null}
                  <span className="fig micro faint">{ago(x.date, t.date)} · {x.scope}</span>
                </span>
                <DismissButton id={x.id} title={x.title} />
              </li>
            ))}
          </ul>
        )}
      </Section>
    </main>
  );
}
