import type { Metadata } from "next";
import Link from "next/link";
import { BodyForm } from "@/components/body-form";
import { LineChart, VolumeBar } from "@/components/charts";
import { PhotoUpload } from "@/components/photo-upload";
import { Empty, PageHeader, Section } from "@/components/ui";
import { sessionOrLogin } from "@/app/_server/session";
import { day, num, signed } from "@/lib/format";
import { getProgress, getVolumeStatus } from "@/server/services/analytics";
import { getAthlete } from "@/server/services/athlete";
import { listPhotos } from "@/server/services/media";

export const metadata: Metadata = { title: "Progreso" };

const RANGES = [30, 90, 180, 365];

export default async function ProgresoPage({ searchParams }: PageProps<"/progreso">) {
  const userId = await sessionOrLogin("/progreso");
  const sp = await searchParams;
  const days = RANGES.includes(Number(sp.dias)) ? Number(sp.dias) : 90;
  const [p, volume, athlete, photos] = await Promise.all([getProgress(userId, { days }), getVolumeStatus(userId), getAthlete(userId), listPhotos(userId, { limit: 9 })]);
  const lift = p.lifts.find((l) => l.exerciseId === sp.lift) ?? p.lifts[0] ?? null;
  const w = p.weight;
  const ratios = p.acwr.filter((a) => a.ratio != null);
  const q = (extra: Record<string, string | number>) => `?${new URLSearchParams({ dias: String(days), ...(lift ? { lift: lift.exerciseId } : {}), ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, String(v)])) })}`;

  return (
    <main className="page">
      <PageHeader title="Progreso" sub={`${day(p.from, p.to)} → ${day(p.to)}`} />
      <nav className="grid grid-cols-4 gap-2" aria-label="Periodo">
        {RANGES.map((r) => (
          <Link key={r} href={q({ dias: r })} className="chip fig px-1" aria-current={r === days ? "page" : undefined} scroll={false}>
            {r} d
          </Link>
        ))}
      </nav>

      <Section title="Peso" id="peso" aside={w.weeklyRatePct != null ? <span className="fig">{signed(w.weeklyRatePct, 2)} %/sem</span> : undefined}>
        {w.series.length < 2 ? (
          <Empty title="Faltan pesadas">Con dos pesadas hay línea; con ocho en dos semanas, tendencia y ritmo semanal fiables. Llevas {w.series.length} en este periodo.</Empty>
        ) : (
          <>
            <p className="mb-2">
              <span className="display text-[2.25rem]">{num(w.current)}</span> <span className="muted">kg de tendencia · {signed(w.change)} kg en el periodo</span>
            </p>
            <LineChart
              unit="kg"
              label={`Peso: tendencia actual ${num(w.current)} kg, cambio de ${signed(w.change)} kg en ${days} días.`}
              series={[
                { name: "Pesada", kind: "dots", tone: "faint", points: w.series.map((s) => ({ date: s.date, y: s.kg })) },
                { name: "Tendencia", kind: "line", tone: "bone", points: w.series.map((s) => ({ date: s.date, y: s.trend })) },
              ]}
              target={athlete.goalWeightKg != null ? { y: athlete.goalWeightKg, label: `objetivo ${num(athlete.goalWeightKg)}` } : undefined}
            />
          </>
        )}
      </Section>

      <Section title="Cintura" id="cintura" aside={p.waist.change != null ? <span className="fig">{signed(p.waist.change)} cm</span> : undefined}>
        {p.waist.series.length < 2 ? (
          <Empty title="Faltan medidas de cintura">Mídela una vez por semana, a la altura del ombligo. Llevas {p.waist.series.length} en este periodo.</Empty>
        ) : (
          <LineChart
            unit="cm"
            label={`Cintura: de ${num(p.waist.series[0].cm)} a ${num(p.waist.series[p.waist.series.length - 1].cm)} cm.`}
            series={[{ name: "Cintura", kind: "line", points: p.waist.series.map((s) => ({ date: s.date, y: s.cm })) }]}
            target={athlete.goalWaistCm != null ? { y: athlete.goalWaistCm, label: `objetivo ${num(athlete.goalWaistCm)}` } : undefined}
          />
        )}
      </Section>

      <Section title="Medidas" id="medidas">
        <BodyForm full />
      </Section>

      <Section title="Fuerza (e1RM)" id="fuerza" aside={lift?.changePct != null ? <span className="fig">{signed(lift.changePct)} %</span> : undefined}>
        {!lift ? (
          <Empty title="Sin sesiones cerradas en este periodo">El 1RM estimado sale de las series con kg y repeticiones de sesiones cerradas.</Empty>
        ) : (
          <>
            <nav className="-mx-4 mb-3 flex gap-2 overflow-x-auto px-4 pb-1" aria-label="Ejercicio">
              {p.lifts.map((l) => (
                <Link key={l.exerciseId} href={q({ lift: l.exerciseId })} className="chip flex-none whitespace-nowrap" aria-current={l.exerciseId === lift.exerciseId ? "page" : undefined} scroll={false}>
                  {l.name}
                </Link>
              ))}
            </nav>
            {lift.series.length < 2 ? (
              <Empty title="Una sola sesión">Hace falta una segunda sesión de {lift.name} para dibujar la línea.</Empty>
            ) : (
              <LineChart
                unit="kg, 1RM estimado"
                label={`${lift.name}: 1RM estimado de ${num(lift.series[0].e1rm)} a ${num(lift.series[lift.series.length - 1].e1rm)} kg en ${lift.sessions} sesiones.`}
                series={[{ name: "Mejor e1RM de la sesión (estimado)", kind: "line", points: lift.series.map((s) => ({ date: s.date, y: s.e1rm })) }]}
              />
            )}
          </>
        )}
      </Section>

      <Section title="Carga" id="carga">
        {p.acwr.length < 2 ? (
          <Empty title="Sin carga registrada">La carga es sRPE × minutos de cada sesión cerrada, más el cardio.</Empty>
        ) : (
          <>
            <LineChart
              unit="carga (sRPE × min)"
              decimals={0}
              label="Carga aguda (7 días) frente a crónica (28 días)."
              series={[
                { name: "Aguda, 7 días", kind: "line", tone: "accent", points: p.acwr.map((a) => ({ date: a.date, y: a.acute })) },
                { name: "Crónica, 28 días", kind: "line", tone: "bone", points: p.acwr.map((a) => ({ date: a.date, y: a.chronic })) },
              ]}
            />
            {ratios.length >= 2 ? (
              <div className="mt-5">
                <LineChart
                  unit="ratio agudo / crónico"
                  decimals={2}
                  label={`Ratio de carga: último valor ${num(ratios[ratios.length - 1].ratio, 2)}. Banda de referencia 0,8 a 1,3.`}
                  band={{ from: 0.8, to: 1.3, label: "0,8-1,3" }}
                  series={[{ name: "Ratio", kind: "line", points: ratios.map((a) => ({ date: a.date, y: a.ratio! })) }]}
                />
              </div>
            ) : (
              <p className="small muted mt-3">El ratio necesita 21 días de historial. Aún no los hay en este periodo.</p>
            )}
            <p className="small muted mt-3">Es un semáforo, no un predictor de lesión: sirve para no subir de golpe, nada más.</p>
          </>
        )}
      </Section>

      <Section title="Volumen semanal" id="volumen" aside={<span className="fig">{day(volume.from)} → {day(volume.to)}</span>}>
        {volume.muscles.every((m) => m.sets === 0) ? (
          <Empty title="Sin series efectivas en este microciclo">Cuentan las series a 3 o menos del fallo. Aparecen al registrar la primera sesión del microciclo.</Empty>
        ) : (
          <>
            {volume.muscles.filter((m) => m.sets > 0 || m.mev > 0).map((m) => (
              <VolumeBar key={m.muscleId} name={m.name} sets={m.setsPerWeek} mev={m.mev} mrv={m.mrv} warn={m.status === "sobre_mrv"} />
            ))}
            <p className="micro faint mt-2">Series efectivas llevadas a 7 días. Marca clara: mínimo (MEV). Marca roja: máximo recuperable (MRV).</p>
            {volume.unclassifiedSets > 0 ? <p className="micro faint mt-1">{volume.unclassifiedSets} series sin grupo muscular (ejercicios sin enlazar).</p> : null}
          </>
        )}
      </Section>

      <Section title="Adherencia" id="adherencia">
        {p.adherence ? (
          <p>
            <span className="display text-[2.25rem]">{p.adherence.pct != null ? `${p.adherence.pct} %` : "—"}</span>{" "}
            <span className="muted">· {p.adherence.done} {p.adherence.done === 1 ? "sesión" : "sesiones"} de {num(p.adherence.planned)} previstas</span>
          </p>
        ) : (
          <p className="muted">Sin programa activo no hay sesiones previstas con las que comparar.</p>
        )}
        <ul className="mt-3 flex items-end gap-1" aria-label="Sesiones por semana">
          {p.sessionsPerWeek.slice(-16).map((s) => (
            <li key={s.weekStart} className="flex flex-1 flex-col items-center gap-1" title={`Semana del ${day(s.weekStart)}: ${s.done}`}>
              <span className="w-full bg-bone" style={{ height: `${Math.max(2, s.done * 9)}px`, opacity: s.done ? 1 : 0.25 }} />
              <span className="fig micro faint">{s.done}</span>
            </li>
          ))}
        </ul>
        <p className="micro faint mt-1">Sesiones cerradas por semana, la más reciente a la derecha.</p>
      </Section>

      <Section title="Fotos" id="fotos">
        <PhotoUpload />
        {photos.length === 0 ? (
          <p className="small muted mt-3">Aún no hay fotos. Misma luz, misma hora y en ayunas para que se puedan comparar.</p>
        ) : (
          <ul className="rows mt-3">
            {photos.map((f) => (
              <li key={f.id} className="row">
                <span className="capitalize">{f.pose}</span>
                <span className="fig small text-right">
                  {day(f.date, p.to)}
                  <span className="micro faint block">{f.driveUrl ? <a className="link" href={f.driveUrl} target="_blank" rel="noopener noreferrer">ver en Drive</a> : "pendiente de subir"}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </main>
  );
}
