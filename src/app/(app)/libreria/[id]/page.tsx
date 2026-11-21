import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { LineChart } from "@/components/charts";
import { Empty, PageHeader, Row, Section } from "@/components/ui";
import { sessionOrLogin } from "@/app/_server/session";
import { day, int, num, setText, signed } from "@/lib/format";
import { AppError } from "@/server/errors";
import { findAlternatives, listMuscleGroups } from "@/server/services/library";
import { getExerciseHistory, type ExerciseHistory } from "@/server/services/training";
import { todayIn } from "@/server/time";

export const metadata: Metadata = { title: "Ejercicio" };

const TREND = { sube: "sube", baja: "baja", plano: "plano", sin_datos: "pocas sesiones" } as const;
const TABS = [
  { id: "resumen", label: "Resumen" },
  { id: "historial", label: "Historial" },
  { id: "tecnica", label: "Técnica" },
] as const;

type Session = ExerciseHistory["sessions"][number];
/** Las cuatro lecturas de la gráfica. Todas salen de las series guardadas; el 1RM es estimado. */
const METRICS = [
  { id: "max", label: "Peso máx.", unit: "kg", long: "Peso máximo de la sesión", of: (s: Session) => (s.sets.length ? Math.max(...s.sets.map((x) => x.kg)) : null) },
  { id: "e1rm", label: "1RM", unit: "kg, estimado", long: "Mejor 1RM estimado de la sesión", of: (s: Session) => s.e1rm },
  { id: "serie", label: "Mejor serie", unit: "kg × reps", long: "Volumen de la mejor serie (kg × reps)", of: (s: Session) => (s.sets.length ? Math.max(...s.sets.map((x) => x.kg * x.reps)) : null) },
  { id: "sesion", label: "Sesión", unit: "kg", long: "Volumen de la sesión (tonelaje)", of: (s: Session) => s.tonnage || null },
] as const;

export default async function ExercisePage({ params, searchParams }: PageProps<"/libreria/[id]">) {
  const { id } = await params;
  const sp = await searchParams;
  const userId = await sessionOrLogin(`/libreria/${id}`);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const h = await getExerciseHistory(userId, { exercise: id, limit: 40 }).catch((e: unknown) => {
    if (e instanceof AppError && e.code === "no_encontrado") return null;
    throw e;
  });
  if (!h) notFound();
  const tab = TABS.find((t) => t.id === sp.tab)?.id ?? "resumen";
  const metric = METRICS.find((m) => m.id === sp.m) ?? METRICS[1];
  const e = h.exercise;
  const today = todayIn();
  const [alts, muscles] = tab === "tecnica" ? await Promise.all([findAlternatives(userId, { exerciseId: id, limit: 6 }), listMuscleGroups(userId)]) : [[], await listMuscleGroups(userId)];
  const m = (x: string | null) => muscles.find((g) => g.id === x)?.name ?? x ?? "—";
  const href = (q: Record<string, string>) => `?${new URLSearchParams({ tab, m: metric.id, ...q })}`;

  const points = [...h.sessions]
    .reverse()
    .map((s) => ({ date: s.date, y: metric.of(s) }))
    .filter((p): p is { date: string; y: number } => p.y != null);
  const best = points.reduce<{ date: string; y: number } | null>((a, p) => (!a || p.y > a.y ? p : a), null);
  const last = points.at(-1) ?? null;

  return (
    <main className="page">
      <PageHeader title={e.name} sub={[m(e.primaryMuscle), e.kind, e.equipment?.replace(/_/g, " ")].filter(Boolean).join(" · ")} back={{ href: "/libreria", label: "Librería" }} />

      <nav className="seg" aria-label="Secciones del ejercicio">
        {TABS.map((t) => (
          <Link key={t.id} href={href({ tab: t.id })} aria-current={t.id === tab ? "page" : undefined} scroll={false} replace>
            {t.label}
          </Link>
        ))}
      </nav>

      {tab === "resumen" ? (
        h.sessions.length === 0 ? (
          <div className="mt-6">
            <Empty title="Aún no lo has hecho">Las cifras y la gráfica aparecen al cerrar la primera sesión con este ejercicio.</Empty>
          </div>
        ) : (
          <>
            <section className="mt-7" aria-label={metric.long}>
              <p className="small muted">{metric.long}</p>
              <p className="display mt-2 text-[5rem]">
                {best ? (metric.id === "serie" || metric.id === "sesion" ? int(best.y) : num(best.y)) : "—"}
                <span className="unit">{metric.id === "serie" ? "kg·rep" : "kg"}</span>
              </p>
              <p className="small muted mt-2">
                mejor marca{best ? ` · ${day(best.date, today)}` : ""}
                {last && best && last.date !== best.date ? ` · última ${metric.id === "serie" || metric.id === "sesion" ? int(last.y) : num(last.y)}` : ""}
              </p>
            </section>

            <nav className="seg mt-6" aria-label="Métrica de la gráfica">
              {METRICS.map((x) => (
                <Link key={x.id} href={href({ m: x.id })} aria-current={x.id === metric.id ? "page" : undefined} scroll={false} replace className="!text-[0.8125rem]">
                  {x.label}
                </Link>
              ))}
            </nav>
            <div className="mt-4">
              {points.length < 2 ? (
                <p className="muted small">Hace falta una segunda sesión para dibujar la línea.</p>
              ) : (
                <LineChart
                  unit={metric.unit}
                  decimals={metric.id === "serie" || metric.id === "sesion" ? 0 : 1}
                  label={`${metric.long}: de ${num(points[0].y)} a ${num(points[points.length - 1].y)} en ${points.length} sesiones.`}
                  series={[{ name: metric.long, kind: "line", area: true, points }]}
                />
              )}
            </div>

            <div className="rows mt-6">
              <Row k="Sesiones" v={<span className="fig">{h.sessions.length}</span>} note={`desde ${day(h.sessions[h.sessions.length - 1].date, today)}`} />
              <Row k="Tendencia del 1RM" v={TREND[h.trend.direction]} note={h.trend.changePct != null ? `${signed(h.trend.changePct)} % en ${h.trend.sessions} sesiones` : undefined} />
              <Row k="Salto de carga" v={<span className="fig">{num(e.loadStep, 2)} kg{e.perSide ? " por lado" : ""}</span>} />
            </div>
          </>
        )
      ) : null}

      {tab === "historial" ? (
        h.sessions.length === 0 ? (
          <div className="mt-6">
            <Empty title="Aún no lo has hecho">Aparecerá aquí al cerrar la primera sesión con este ejercicio.</Empty>
          </div>
        ) : (
          <ul className="mt-6">
            {h.sessions.map((s) => (
              <li key={s.workoutId} className="border-b border-line">
                <Link href={`/entreno/${s.workoutId}`} className="block py-4">
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="font-semibold">{day(s.date, today)}</span>
                    <span className="fig small muted">{s.e1rm != null ? `1RM ${num(s.e1rm)} kg` : ""} · {int(s.tonnage)} kg</span>
                  </span>
                  <ol className="mt-2 grid gap-1">
                    {s.sets.map((x, k) => (
                      <li key={k} className="fig flex gap-3">
                        <span className="faint w-4">{k + 1}</span>
                        <span>{setText(x)}</span>
                      </li>
                    ))}
                  </ol>
                </Link>
              </li>
            ))}
          </ul>
        )
      ) : null}

      {tab === "tecnica" ? (
        <>
          <div className="rows mt-6">
            <Row k="Principal" v={m(e.primaryMuscle)} />
            {e.secondaryMuscles.length ? <Row k="Sinergistas" v={e.secondaryMuscles.map(m).join(", ")} /> : null}
            {e.movementPattern ? <Row k="Patrón" v={e.movementPattern.replace(/_/g, " ")} /> : null}
          </div>
          <Section title="Claves" id="claves">
            {e.cues ? <p className="whitespace-pre-line">{e.cues}</p> : <p className="muted">Sin claves guardadas para este ejercicio.</p>}
            {e.videoUrls.length ? (
              <ul className="mt-3">
                {e.videoUrls.map((u, k) => (
                  <li key={u}>
                    <a className="link" href={u} target="_blank" rel="noopener noreferrer">Vídeo de referencia {e.videoUrls.length > 1 ? k + 1 : ""}</a>
                  </li>
                ))}
              </ul>
            ) : null}
          </Section>
          <Section title="Alternativas" id="alternativas">
            {alts.length === 0 ? (
              <p className="muted">No hay alternativas para el mismo grupo en la librería.</p>
            ) : (
              <ul className="rows">
                {alts.map((a) => (
                  <li key={a.id}>
                    <Row href={`/libreria/${a.id}`} k={<span className="text-fg">{a.name}</span>} v={<span className="micro muted">{a.equipment?.replace(/_/g, " ") ?? ""}</span>} />
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </>
      ) : null}
    </main>
  );
}
