import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageHeader, Row, Section } from "@/components/ui";
import { sessionOrLogin } from "@/app/_server/session";
import { day, int, num, setText } from "@/lib/format";
import { AppError } from "@/server/errors";
import { getWorkoutView } from "@/server/services/training";
import { todayIn } from "@/server/time";
import { LiveWorkout } from "./live";

export const metadata: Metadata = { title: "Sesión" };

export default async function WorkoutPage({ params }: PageProps<"/entreno/[id]">) {
  const { id } = await params;
  const userId = await sessionOrLogin(`/entreno/${id}`);
  const view = await getWorkoutView(userId, id).catch((e: unknown) => {
    if (e instanceof AppError && (e.code === "no_encontrado" || e.code === "entrada_invalida")) return null;
    throw e;
  });
  if (!view) notFound();

  if (view.workout.status === "en_curso") return <LiveWorkout initial={view} />;

  const w = view.workout;
  const today = todayIn();
  return (
    <main className="page">
      <PageHeader title={w.name ?? "Sesión"} sub={`${day(w.date, today)} · ${w.status === "hecha" ? "cerrada" : "saltada"}`} back={{ href: "/entreno", label: "Entreno" }} />
      <div className="rows">
        <Row k="Series efectivas" v={<span className="fig">{num(w.hardSets ?? view.totals.hardSets)}</span>} />
        <Row k="Tonelaje" v={<span className="fig">{int(w.tonnage ?? view.totals.tonnage)} kg</span>} />
        {w.srpe != null ? <Row k="sRPE" v={<span className="fig">{num(w.srpe)}</span>} /> : null}
        {w.durationMin != null ? <Row k="Duración" v={<span className="fig">{w.durationMin} min</span>} /> : null}
        {w.load != null ? <Row k="Carga" v={<span className="fig">{int(w.load)}</span>} note="sRPE × minutos" /> : null}
        {w.caffeineMg ? <Row k="Cafeína" v={<span className="fig">{w.caffeineMg} mg</span>} /> : null}
        {w.kneeSleeves || w.belt || w.straps ? <Row k="Material" v={[w.kneeSleeves && "rodilleras", w.belt && "cinturón", w.straps && "straps"].filter(Boolean).join(", ")} /> : null}
      </div>
      {w.notes ? <p className="muted mt-4 whitespace-pre-line">{w.notes}</p> : null}

      <Section title="Series" id="series">
        {view.exercises.length === 0 && view.unmatchedSets.length === 0 ? <p className="muted">Sin series registradas.</p> : null}
        {view.exercises.map((b) => (
          <div key={b.exercise.id} className="border-b border-line py-3">
            <p className="font-medium">{b.exercise.name}</p>
            <p className="fig small muted mt-1">
              {b.sets.filter((s) => s.setType !== "aproximacion").map((s) => setText(s)).join("  /  ") || "sin series"}
            </p>
          </div>
        ))}
        {view.unmatchedSets.length ? (
          <div className="border-b border-line py-3">
            <p className="font-medium">Sin enlazar a la librería</p>
            <ul className="fig small muted mt-1">
              {view.unmatchedSets.map((s) => (
                <li key={s.id}>
                  {s.rawName ?? "Ejercicio"} · {setText(s)}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Section>
    </main>
  );
}
