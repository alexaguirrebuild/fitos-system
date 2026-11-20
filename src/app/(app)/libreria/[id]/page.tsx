import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Empty, PageHeader, Row, Section } from "@/components/ui";
import { sessionOrLogin } from "@/app/_server/session";
import { day, num, setText, signed } from "@/lib/format";
import { AppError } from "@/server/errors";
import { findAlternatives, listMuscleGroups } from "@/server/services/library";
import { getExerciseHistory } from "@/server/services/training";
import { todayIn } from "@/server/time";

export const metadata: Metadata = { title: "Ejercicio" };

const TREND = { sube: "sube", baja: "baja", plano: "plano", sin_datos: "pocas sesiones" } as const;

export default async function ExercisePage({ params }: PageProps<"/libreria/[id]">) {
  const { id } = await params;
  const userId = await sessionOrLogin(`/libreria/${id}`);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const h = await getExerciseHistory(userId, { exercise: id, limit: 10 }).catch((e: unknown) => {
    if (e instanceof AppError && e.code === "no_encontrado") return null;
    throw e;
  });
  if (!h) notFound();
  const [alts, muscles] = await Promise.all([findAlternatives(userId, { exerciseId: id, limit: 6 }), listMuscleGroups(userId)]);
  const e = h.exercise;
  const today = todayIn();
  const m = (x: string | null) => muscles.find((g) => g.id === x)?.name ?? x ?? "—";

  return (
    <main className="page">
      <PageHeader title={e.name} sub={[m(e.primaryMuscle), e.kind, e.equipment?.replace(/_/g, " ")].filter(Boolean).join(" · ")} back={{ href: "/libreria", label: "Librería" }} />
      <div className="rows">
        {e.secondaryMuscles.length ? <Row k="Sinergistas" v={e.secondaryMuscles.map(m).join(", ")} /> : null}
        <Row k="Salto de carga" v={<span className="fig">{num(e.loadStep, 2)} kg{e.perSide ? " por lado" : ""}</span>} />
        <Row k="Tobillo" v={e.impact ? "Con impacto" : `Carga ${e.ankleLoad}`} warn={e.impact || e.ankleLoad === "alta"} />
        {h.best ? <Row k="Mejor e1RM" v={<span className="fig">{num(h.best.e1rm)} kg</span>} note={`estimado · ${day(h.best.date, today)}`} /> : null}
        <Row k="Tendencia" v={TREND[h.trend.direction]} note={h.trend.changePct != null ? `${signed(h.trend.changePct)} % en ${h.trend.sessions} sesiones` : undefined} />
      </div>

      <Section title="Claves técnicas" id="claves">
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

      <Section title="Historial" id="historial">
        {h.sessions.length === 0 ? (
          <Empty title="Aún no lo has hecho">Aparecerá aquí al cerrar la primera sesión con este ejercicio.</Empty>
        ) : (
          <ul className="rows">
            {h.sessions.map((s) => (
              <li key={s.workoutId}>
                <Link href={`/entreno/${s.workoutId}`} className="row items-start">
                  <span className="fig small min-w-0">
                    <span className="faint block">{day(s.date, today)}</span>
                    {s.sets.map((x) => setText(x)).join(" / ")}
                  </span>
                  <span className="fig small flex-none text-right">{s.e1rm != null ? `e1RM ${num(s.e1rm)}` : ""}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Alternativas" id="alternativas">
        {alts.length === 0 ? (
          <p className="muted">No hay alternativas para el mismo grupo en la librería.</p>
        ) : (
          <ul className="rows">
            {alts.map((a) => (
              <li key={a.id}>
                <Row href={`/libreria/${a.id}`} k={<span className="text-bone">{a.name}</span>} v={<span className="micro">{a.ankleLoad === "alta" || a.impact ? <span className="accent">carga el tobillo</span> : "segura para el tobillo"}</span>} />
              </li>
            ))}
          </ul>
        )}
      </Section>
    </main>
  );
}
