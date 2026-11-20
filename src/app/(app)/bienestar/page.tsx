import type { Metadata } from "next";
import { FormAction } from "@/components/form-action";
import { PageHeader, Section } from "@/components/ui";
import { sessionOrLogin } from "@/app/_server/session";
import { ago, day } from "@/lib/format";
import { getAnkleStatus } from "@/server/services/athlete";
import { listMuscleGroups } from "@/server/services/library";
import { getCheckin, getPomsItems, listCheckins, listPoms } from "@/server/services/wellness";
import { checkinAction, sorenessAction } from "./actions";
import { Poms, Slider } from "./parts";

export const metadata: Metadata = { title: "Bienestar" };

export default async function BienestarPage() {
  const userId = await sessionOrLogin("/bienestar");
  const [today, past, ankle, muscles, poms] = await Promise.all([getCheckin(userId), listCheckins(userId, { days: 28 }), getAnkleStatus(userId), listMuscleGroups(userId), listPoms(userId, { limit: 1 })]);
  const q = getPomsItems();
  const scored = past.filter((c) => c.readiness != null && c.date !== ankle.date);
  const mean = scored.length ? Math.round(scored.reduce((a, c) => a + c.readiness!, 0) / scored.length) : null;

  return (
    <main className="page">
      <PageHeader title="Bienestar" sub={day(ankle.date)} back={{ href: "/mas", label: "Más" }} />

      {today?.readiness != null ? (
        <div>
          <p>
            <span className="display text-[3rem]">{Math.round(today.readiness)}</span> <span className="muted">readiness de hoy</span>
          </p>
          <p className="mt-1">{today.label}</p>
          <p className="small muted mt-1">
            {mean != null ? `Media de tus últimos 28 días: ${mean} (${scored.length} check-ins).` : "Aún no hay check-ins anteriores con los que comparar."}
          </p>
        </div>
      ) : (
        <p className="muted">Sin check-in hoy. Un minuto: decide si la sesión va completa, con más reserva o se queda en Z2.</p>
      )}

      <Section title={today ? "Corregir check-in" : "Check-in"} id="checkin">
        <FormAction action={checkinAction} submit="Guardar check-in" primary>
          <Slider name="sleepQuality" label="Sueño" low="fatal" high="perfecto" initial={today?.sleepQuality ?? 7} />
          <Slider name="sleepHours" label="Horas dormidas" low="3" high="11" min={3} max={11} step={0.5} initial={today?.sleepHours ?? 7.5} unit="h" />
          <Slider name="stress" label="Estrés" low="ninguno" high="máximo" initial={today?.stress ?? 4} />
          <Slider name="motivation" label="Ganas de entrenar" low="ninguna" high="todas" initial={today?.motivation ?? 7} />
          <Slider name="pain" label="Dolor general" low="nada" high="mucho" initial={today?.pain ?? 2} />
          <Slider name="fatigue" label="Fatiga" low="fresco" high="agotado" initial={today?.fatigue ?? 4} />
          <Slider name="anklePain" label="Tobillo" low="0 nada" high="10" min={0} max={10} initial={today?.anklePain ?? ankle.pain ?? 0} />
          <p className="micro faint mt-2">
            Los valores de partida son neutros{ankle.painDate ? `; el del tobillo es tu último apunte (${ago(ankle.painDate, ankle.date)})` : ""}. Muévelos antes de guardar.
          </p>
        </FormAction>
      </Section>

      <Section title="Agujetas" id="agujetas">
        <p className="small muted mb-2">A las 48 h de entrenar el grupo. 1 nada, 5 no puedo moverlo. Deja en blanco lo que no hayas entrenado.</p>
        <FormAction action={sorenessAction} submit="Guardar agujetas">
          <div className="grid grid-cols-2 gap-x-3 gap-y-2">
            {muscles.map((m) => (
              <div key={m.id} className="field">
                <label htmlFor={`m-${m.id}`}>{m.name}</label>
                <select id={`m-${m.id}`} name={`m:${m.id}`} className="input" defaultValue="">
                  <option value="">—</option>
                  {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </div>
            ))}
          </div>
        </FormAction>
      </Section>

      <Section title="POMS" id="poms" aside={poms[0] ? `último: ${ago(poms[0].date, ankle.date)} · TMD ${poms[0].tmd} · ${poms[0].shape}` : "sin tests"}>
        <p className="small muted mb-3">Chequeo opcional del estado de ánimo. El perfil sano en deportistas es el «iceberg»: vigor alto y lo demás bajo.</p>
        <Poms items={q.items} scale={q.scale} instructions={q.instructions} />
      </Section>
    </main>
  );
}
