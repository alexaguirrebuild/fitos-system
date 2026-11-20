import type { Metadata } from "next";
import Link from "next/link";
import { Empty, Notice, PageHeader, Section } from "@/components/ui";
import { IconChevron } from "@/components/icons";
import { sessionOrLogin } from "@/app/_server/session";
import { ago, day, int, num, repRange, weekday } from "@/lib/format";
import { getNextSession } from "@/server/services/plan";
import { listWorkouts } from "@/server/services/training";
import { startAndGo } from "./actions";

export const metadata: Metadata = { title: "Entreno" };

export default async function EntrenoPage() {
  const userId = await sessionOrLogin("/entreno");
  const [next, recent] = await Promise.all([getNextSession(userId), listWorkouts(userId, { limit: 12 })]);
  const today = next.date;
  const s = next.session;
  const open = recent.find((w) => w.status === "en_curso");
  const openId = next.workoutId ?? open?.id ?? null;

  return (
    <main className="page">
      <PageHeader title="Entreno" sub={`${weekday(today).replace(/^./, (c) => c.toUpperCase())}, ${day(today)}`} />

      {next.isDeload ? <Notice title="Semana de descarga">Las cargas sugeridas ya vienen recortadas. No busques marcas.</Notice> : null}

      {openId ? (
        <div className="mt-4">
          <p className="muted small">Sesión abierta{open?.date && open.date !== today ? ` · ${day(open.date, today)}` : ""}</p>
          <p className="display mt-1 text-[2rem]">{open?.name ?? s?.name ?? "Sesión libre"}</p>
          <Link href={`/entreno/${openId}`} className="btn btn-primary btn-lg btn-block mt-4">
            Continuar
          </Link>
        </div>
      ) : s && !s.isRest ? (
        <div className="mt-4">
          <p className="muted small">
            {next.reason === "primera" ? "Primera sesión del programa" : "Toca ahora"}
            {next.lastDone ? ` · última: ${next.lastDone.name}, ${ago(next.lastDone.date, today)}` : ""}
          </p>
          <p className="display mt-1 text-[2.25rem]">{s.name}</p>
          {s.focus ? <p className="muted mt-1">{s.focus}</p> : null}
          <form action={startAndGo.bind(null, s.id)} className="mt-4">
            <button type="submit" className="btn btn-primary btn-lg btn-block">
              Empezar {s.name}
            </button>
          </form>
          {s.prescriptions.length ? (
            <ol className="rows mt-5">
              {s.prescriptions.map((p) => (
                <li key={p.id} className="row">
                  <span className="min-w-0 truncate">{p.exercise.name}</span>
                  <span className="fig small muted flex-none">
                    {p.sets} × {repRange(p.repMin, p.repMax)}
                    {p.rirTarget != null ? ` · RIR ${num(p.rirTarget)}` : ""}
                  </span>
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      ) : next.reason === "sin_plan" ? (
        <Empty title="No hay programa activo" action={<Link className="btn" href="/ajustes#programa">Elegir programa</Link>}>
          Sin programa no hay sesión propuesta ni progresión. Puedes abrir una sesión libre abajo.
        </Empty>
      ) : (
        <Empty title="Hoy toca descanso">La rueda marca descanso. Si entrenas igualmente, abre una sesión libre.</Empty>
      )}

      {!openId ? (
        <Section title="Sesión libre" id="libre">
          <form action={startAndGo.bind(null, null)} className="flex gap-3">
            <label htmlFor="free-name" className="sr-only">
              Nombre de la sesión
            </label>
            <input id="free-name" name="name" className="input" placeholder="Nombre (opcional)" maxLength={80} />
            <button type="submit" className="btn flex-none">
              Abrir
            </button>
          </form>
        </Section>
      ) : null}

      <Section title="Últimas sesiones" id="ultimas">
        {recent.filter((w) => w.status !== "en_curso").length === 0 ? (
          <Empty title="Aún no hay sesiones cerradas">Cuando cierres una sesión aparecerá aquí con su carga y sus series.</Empty>
        ) : (
          <ul className="rows">
            {recent
              .filter((w) => w.status !== "en_curso")
              .slice(0, 8)
              .map((w) => (
                <li key={w.id}>
                  <Link href={`/entreno/${w.id}`} className="row">
                    <span className="min-w-0">
                      <span className="block truncate">{w.name ?? "Sesión"}</span>
                      <span className="fig micro faint">
                        {day(w.date, today)} · {w.sets} series{w.tonnage ? ` · ${int(w.tonnage)} kg` : ""}
                        {w.srpe != null ? ` · sRPE ${num(w.srpe)}` : ""}
                      </span>
                    </span>
                    <IconChevron className="flex-none text-bone-3" />
                  </Link>
                </li>
              ))}
          </ul>
        )}
      </Section>
    </main>
  );
}
