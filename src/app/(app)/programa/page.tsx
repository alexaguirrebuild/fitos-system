import type { Metadata } from "next";
import Link from "next/link";
import { Empty } from "@/components/ui";
import { sessionOrLogin } from "@/app/_server/session";
import { day, num, repRange } from "@/lib/format";
import { getActivePlan } from "@/server/services/plan";
import { todayIn } from "@/server/time";

export const metadata: Metadata = { title: "Programa" };

const GOAL: Record<string, string> = { definicion: "definición", volumen: "volumen", recomposicion: "recomposición", mantenimiento: "mantenimiento", fuerza: "fuerza" };

/**
 * Programación por bloques: macrociclo → mesociclos → microciclos → sesiones. Pensada para escritorio (1280 px),
 * se apila en móvil. `getActivePlan` solo trae microciclos y sesiones del mesociclo en curso: los demás bloques
 * se enseñan con lo que hay (nombre, tipo, semanas) y sin inventar su contenido.
 */
export default async function ProgramaPage() {
  const userId = await sessionOrLogin("/programa");
  const plan = await getActivePlan(userId);
  const today = todayIn();

  if (!plan) {
    return (
      <main className="page">
        <h1 className="h-page mb-6">Programa</h1>
        <Empty title="No hay programa activo" action={<Link href="/ajustes#programa" className="btn btn-primary">Elegir programa</Link>}>
          Al activar uno aparecen aquí sus bloques, sus semanas y cada sesión con sus ejercicios.
        </Empty>
      </main>
    );
  }

  const { macrocycle: mac, mesocycles, mesocycle: cur, microcycles, microcycle: micro, sessions } = plan;
  const totalWeeks = mesocycles.reduce((a, m) => a + m.microcyclesPlanned, 0) || 1;

  return (
    <main className="page-wide">
      <header className="flex flex-wrap items-end justify-between gap-x-10 gap-y-4">
        <div className="min-w-0">
          <p className="small muted">Macrociclo · {GOAL[mac.goal] ?? mac.goal}</p>
          <h1 className="display mt-2 text-[3.25rem] lg:text-[4.5rem]">{mac.name}</h1>
        </div>
        <dl className="grid grid-cols-3 gap-x-8 gap-y-1">
          <div>
            <dt className="small muted">Inicio</dt>
            <dd className="fig font-semibold">{day(mac.startDate)}</dd>
          </div>
          <div>
            <dt className="small muted">Fin</dt>
            <dd className="fig font-semibold">{mac.endDate ? day(mac.endDate) : "abierto"}</dd>
          </div>
          <div>
            <dt className="small muted">Peso</dt>
            <dd className="fig font-semibold">
              {mac.startWeightKg != null ? num(mac.startWeightKg) : "—"} → {mac.targetWeightKg != null ? `${num(mac.targetWeightKg)} kg` : "—"}
            </dd>
          </div>
        </dl>
      </header>

      <section className="mt-8" aria-label="Mesociclos">
        <ol className="flex flex-col gap-2 lg:flex-row">
          {mesocycles.map((m) => {
            const isCur = m.id === cur.id;
            return (
              <li
                key={m.id}
                className={`rounded-[var(--radius-lg)] border p-4 ${isCur ? "border-transparent bg-accent text-on-accent" : "border-line bg-surface"}`}
                style={{ flexGrow: Math.max(1, m.microcyclesPlanned), flexBasis: 0 }}
                aria-current={isCur ? "step" : undefined}
              >
                <p className={`small ${isCur ? "" : "muted"}`}>
                  Bloque {m.position} · {m.blockType}
                </p>
                <p className="mt-1 text-lg font-bold leading-tight">{m.name}</p>
                <p className={`fig small mt-2 ${isCur ? "" : "muted"}`}>
                  {m.microcyclesPlanned} {m.microcyclesPlanned === 1 ? "semana" : "semanas"} · {m.microcycleDays} días{m.startDate ? ` · desde ${day(m.startDate)}` : ""}
                </p>
                {m.focus ? <p className={`small mt-1 ${isCur ? "" : "faint"}`}>{m.focus}</p> : null}
              </li>
            );
          })}
        </ol>
        <p className="micro faint mt-2">
          {totalWeeks} semanas en total. El ancho de cada bloque es proporcional a sus semanas.
          {plan.beyondEnd ? " La fecha de hoy ya pasa del último microciclo previsto: se sigue en el último." : ""}
        </p>
      </section>

      <section className="sec" aria-labelledby="micro-t">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="h-sec" id="micro-t">Microciclos de «{cur.name}»</h2>
          <span className="small muted">Semana {micro.position} de {microcycles.length}</span>
        </div>
        <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
          {microcycles.map((w) => {
            const isCur = w.id === micro.id;
            const past = w.endDate < today;
            return (
              <li key={w.id} className={`rounded-[var(--radius)] border px-3 py-2.5 ${isCur ? "border-fg" : "border-line"} ${past ? "opacity-60" : ""}`} aria-current={isCur ? "step" : undefined}>
                <p className="flex items-baseline justify-between gap-2">
                  <span className="display text-[1.75rem]">S{w.position}</span>
                  {w.isDeload ? <span className="micro accent font-semibold">descarga</span> : null}
                </p>
                <p className="fig micro muted mt-1">
                  {day(w.startDate)} → {day(w.endDate)}
                </p>
                {w.objective ? <p className="micro faint mt-1">{w.objective}</p> : null}
              </li>
            );
          })}
        </ol>
      </section>

      <section className="sec" aria-labelledby="ses-t">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="h-sec" id="ses-t">Sesiones de la semana {micro.position}</h2>
          <span className="small muted">Pautas de este microciclo; si no tiene propias, las del bloque.</span>
        </div>
        {sessions.length === 0 ? (
          <Empty title="El bloque no tiene sesiones">El programa no define sesiones para este mesociclo.</Empty>
        ) : (
          <ol className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {sessions.map((s) => (
              <li key={s.id} className="slab flex flex-col p-4">
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="text-lg font-bold leading-tight">
                    <span className="fig faint mr-2">D{s.position}</span>
                    {s.name}
                  </h3>
                  {s.plannedMinutes ? <span className="fig small muted flex-none">{s.plannedMinutes} min</span> : null}
                </div>
                {s.focus ? <p className="small muted mt-1">{s.focus}</p> : null}
                {s.isRest ? (
                  <p className="muted mt-3">Descanso.</p>
                ) : s.prescriptions.length === 0 ? (
                  <p className="muted mt-3">{s.isCardio ? "Cardio: sin ejercicios pautados." : "Sin ejercicios pautados."}</p>
                ) : (
                  <ol className="mt-3 divide-y divide-line border-t border-line">
                    {s.prescriptions.map((p) => (
                      <li key={p.id} className="flex items-baseline justify-between gap-3 py-2">
                        <Link href={`/libreria/${p.exerciseId}`} className="min-w-0 text-[0.9375rem] leading-snug hover:underline">
                          {p.exercise.name}
                        </Link>
                        <span className="fig small flex-none text-right font-semibold">
                          {p.sets} × {repRange(p.repMin, p.repMax)}
                          {p.rirTarget != null ? <span className="muted font-normal"> · RIR {num(p.rirTarget)}</span> : null}
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>

      <p className="micro faint mt-10">
        Los demás bloques solo enseñan nombre, tipo y semanas: el servicio del plan devuelve microciclos y sesiones del bloque en curso, no de todos.
      </p>
    </main>
  );
}
