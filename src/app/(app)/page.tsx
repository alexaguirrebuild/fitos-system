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

  return (
    <main className="page">
      <header>
        <p className="muted small">
          {t.weekday.replace(/^./, (c) => c.toUpperCase())}, {day(t.date)}
          {tr?.plan ? ` · día ${tr.plan.microcycle.day} de ${tr.plan.microcycle.lengthDays}` : ""}
        </p>
        <h1 className="display mt-2 text-[2.5rem]">{a.label}</h1>
        <p className="muted mt-2">{a.detail}</p>
        {a.kind !== "nada" ? (
          <Link href={a.href} className="btn btn-primary btn-lg btn-block mt-5">
            {a.kind === "empezar_sesion" ? "Empezar" : a.kind === "continuar_sesion" ? "Continuar" : a.kind === "checkin" ? "Hacer check-in" : a.kind === "pesaje" ? "Apuntar peso" : a.kind === "comida" ? "Registrar comida" : a.kind === "onboarding" ? "Completar ficha" : "Abrir"}
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

      <section className="rows mt-7" aria-label="Estado de hoy">
        <Row
          href="/bienestar"
          k="Readiness"
          v={t.checkin?.readiness != null ? <span className="fig">{Math.round(t.checkin.readiness)}</span> : "Check-in pendiente"}
          note={t.checkin?.label ?? undefined}
          warn={t.needsCheckin}
        />
        <Row
          href="/bienestar"
          k="Tobillo"
          v={t.ankle?.pain != null ? <span className="fig">{t.ankle.pain}/10</span> : "Sin dato"}
          note={t.ankle ? `${t.ankle.restricted ? "Restringido: sin impacto" : "Sin restricción"}${t.ankle.painDate && t.ankle.painDate !== t.date ? ` · ${ago(t.ankle.painDate, t.date)}` : ""}` : undefined}
          warn={t.ankle?.restricted}
        />
        <Row
          href="/nutricion"
          k={n ? `Día ${n.dayType === "on" ? "On" : "Off"}` : "Comida"}
          v={n?.remaining ? <span className="fig">{int(n.remaining.kcal)} kcal · {int(n.remaining.proteinG)} g P</span> : n ? "Sin objetivos" : "Sin dato"}
          note={n?.remaining ? `restantes${n.dayTypeAssumed ? " · tipo de día supuesto" : ""}` : n ? "Recalcula los objetivos en Comida" : undefined}
        />
        <Row
          href="/cardio"
          k="Pasos"
          v={<span className="fig">{t.activity?.steps.done != null ? int(t.activity.steps.done) : "—"}{t.activity?.steps.goal != null ? ` / ${int(t.activity.steps.goal)}` : ""}</span>}
          note={t.activity?.steps.done == null ? "Sin dato de hoy" : undefined}
        />
        <Row
          href="/progreso"
          k="Peso"
          v={t.weight?.trendKg != null ? <span className="fig">{num(t.weight.trendKg)} kg</span> : t.weight?.lastKg != null ? <span className="fig">{num(t.weight.lastKg)} kg</span> : "Sin pesadas"}
          note={
            t.weight?.lastDate
              ? `${t.weight.trendKg != null ? "tendencia" : "última pesada"}${t.weight.weeklyRatePct != null ? ` · ${signed(t.weight.weeklyRatePct, 2)} %/sem` : ""} · pesada ${t.weight.daysSinceWeighIn === 0 ? "hoy" : `hace ${t.weight.daysSinceWeighIn} d`}`
              : undefined
          }
          warn={(t.weight?.daysSinceWeighIn ?? 0) > 3}
        />
        <Row
          href="/progreso#carga"
          k="Carga"
          v={t.load ? (t.load.acwr.reliable && t.load.acwr.ratio != null ? <span className="fig">{num(t.load.acwr.ratio, 2)}</span> : "Aún sin ratio") : "Sin dato"}
          note={t.load ? `${t.load.acwr.label}${t.load.acwr.reliable ? " · agudo/crónico, es un semáforo" : ""}` : undefined}
          warn={t.load?.acwr.zone === "pico" || t.load?.acwr.zone === "precaucion"}
        />
      </section>

      <Section title="Peso" id="peso" aside={t.weight?.goalKg != null && t.weight.toGoalKg != null ? <span className="fig">{num(Math.abs(t.weight.toGoalKg))} kg al objetivo ({num(t.weight.goalKg)})</span> : undefined}>
        <BodyForm />
      </Section>

      <Section title={session ? session.name : tr ? KIND[tr.todayKind] : "Sesión"} id="sesion" aside={session?.plannedMinutes ? <span className="fig">{session.plannedMinutes} min</span> : undefined}>
        {!tr || tr.todayKind === "sin_plan" ? (
          <p className="muted">
            No hay programa activo. <Link className="link" href="/ajustes#programa">Elige uno</Link> para ver la sesión del día.
          </p>
        ) : tr.inProgress ? (
          <p className="muted">
            En curso: <span className="fig text-bone">{tr.inProgress.exercisesDone}/{tr.inProgress.exercisesTotal}</span> ejercicios, <span className="fig text-bone">{num(tr.inProgress.hardSets)}</span> series efectivas.
          </p>
        ) : null}
        {tr?.doneToday.length ? (
          <ul className="rows">
            {tr.doneToday.map((d) => (
              <li key={d.workoutId}>
                <Row href={`/entreno/${d.workoutId}`} k={d.name ?? "Sesión"} v={<span className="fig">{num(d.hardSets)} series{d.tonnage != null ? ` · ${int(d.tonnage)} kg` : ""}</span>} note="hecha hoy" />
              </li>
            ))}
          </ul>
        ) : null}
        {session && session.exercises.length ? (
          <details className="fold" open={!tr?.trainedToday}>
            <summary>
              {session.exercises.length} ejercicios{session.focus ? ` · ${session.focus}` : ""}
            </summary>
            <ol className="fold-b">
              {session.exercises.map((e) => (
                <li key={e.exerciseId} className="border-b border-line py-2.5 last:border-b-0">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className={e.done ? "text-bone-2" : undefined}>{e.name}</span>
                    <span className="fig small flex-none">
                      {e.suggestion?.kg != null ? `${num(e.suggestion.kg, 2)} kg × ` : `${e.sets} × `}
                      {repRange(e.repMin, e.repMax)}
                      {e.rirTarget != null ? ` · RIR ${num(e.rirTarget)}` : ""}
                    </span>
                  </div>
                  {e.suggestion ? <p className="micro faint mt-0.5">{e.suggestion.why}</p> : null}
                  {e.ankleWarning ? <p className="micro accent mt-0.5">{e.ankleWarning}</p> : null}
                </li>
              ))}
            </ol>
          </details>
        ) : tr && tr.todayKind === "descanso" ? (
          <p className="muted">La rueda marca descanso. Pasos y a dormir.</p>
        ) : null}
      </Section>

      <Section title="Anotaciones" id="notas">
        {t.annotations.length === 0 ? (
          <p className="muted">Nada pendiente. Aquí salen los avisos del motor al cerrar sesiones y registrar datos.</p>
        ) : (
          <ul className="rows">
            {t.annotations.slice(0, 6).map((x) => (
              <li key={x.id} className="row items-start">
                <span className="min-w-0">
                  <span className={`block font-medium ${x.severity !== "info" ? "accent" : ""}`}>{x.title}</span>
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
