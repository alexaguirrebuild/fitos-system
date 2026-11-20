import type { Metadata } from "next";
import Link from "next/link";
import { FormAction } from "@/components/form-action";
import { Empty, Meter, Notice, PageHeader, Section } from "@/components/ui";
import { sessionOrLogin } from "@/app/_server/session";
import { ago, day, int, num } from "@/lib/format";
import { listIngestTokens } from "@/server/ingest-auth";
import { getAnkleStatus } from "@/server/services/athlete";
import { ANKLE_PAIN_LIMIT, ANKLE_WARNING, CARDIO_MODES, getActivity, getCardioWeek, type CardioMode } from "@/server/services/cardio";
import { HEALTH_INGEST_EXAMPLE } from "@/server/services/health";
import { createTokenAction, logCardioAction, logStepsAction, revokeTokenAction } from "./actions";

export const metadata: Metadata = { title: "Cardio" };

const MODE: Record<CardioMode, string> = { bici: "Bici", eliptica: "Elíptica", cinta_andando: "Cinta andando", caminar: "Caminar", remo: "Remo", natacion: "Natación", carrera: "Carrera", hiit: "HIIT", otro: "Otro" };
const IMPACT: CardioMode[] = ["carrera", "hiit"];

export default async function CardioPage() {
  const userId = await sessionOrLogin("/cardio");
  const [week, ankle, activity, tokens] = await Promise.all([getCardioWeek(userId), getAnkleStatus(userId), getActivity(userId, { days: 1 }), listIngestTokens(userId)]);
  const restricted = (ankle.pain ?? 0) > ANKLE_PAIN_LIMIT || ankle.rule.restricted;
  const steps = activity.days.find((d) => d.date === ankle.date)?.steps ?? null;
  const live = tokens.filter((t) => !t.revokedAt);

  return (
    <main className="page">
      <PageHeader title="Cardio" sub={`Semana del ${day(week.weekStart)}`} back={{ href: "/mas", label: "Más" }} />

      <p>
        <span className="display text-[2.5rem]">{int(week.z2.minutes)}</span> <span className="muted">de {int(week.z2.targetMin)} min en Z2 · faltan {int(week.z2.remainingMin)}</span>
      </p>
      <div className="mt-2"><Meter label="Minutos de zona 2 esta semana" value={week.z2.minutes} max={week.z2.targetMin} /></div>
      <p className="fig small muted mt-2">{week.sessionCount} sesiones · {int(week.minutesTotal)} min en total · fuerza {week.strength.sessions}</p>
      {week.warnings.map((w) => <p key={w} className="small accent mt-2">{w}</p>)}

      {restricted ? <div className="mt-4"><Notice warn title={`Tobillo ${ankle.pain ?? "—"}/10`}>{ANKLE_WARNING}</Notice></div> : null}

      <Section title="Registrar" id="registrar">
        <FormAction action={logCardioAction} submit="Guardar cardio" primary>
          <div className="field">
            <label htmlFor="mode">Modo</label>
            <select id="mode" name="mode" className="input" defaultValue="bici">
              {CARDIO_MODES.map((m) => (
                <option key={m} value={m}>
                  {MODE[m]}{IMPACT.includes(m) ? (restricted ? " · impacto: hoy no" : " · con impacto") : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-3">
            <div className="field">
              <label htmlFor="minutes">Minutos</label>
              <input id="minutes" name="minutes" className="input input-fig" inputMode="numeric" required />
            </div>
            <div className="field">
              <label htmlFor="avgHr">FC media</label>
              <input id="avgHr" name="avgHr" className="input input-fig" inputMode="numeric" placeholder="ppm" />
            </div>
            <div className="field">
              <label htmlFor="anklePainAfter">Tobillo tras</label>
              <input id="anklePainAfter" name="anklePainAfter" className="input input-fig" inputMode="numeric" placeholder="0-10" />
            </div>
          </div>
        </FormAction>
      </Section>

      <Section title="Zonas de pulso" id="zonas">
        {week.hrZones ? (
          <>
            <ul className="rows">
              {week.hrZones.map((z) => (
                <li key={z.zone} className="row">
                  <span>
                    <span className="fig mr-2">Z{z.zone}</span>
                    <span className="muted">{z.label}</span>
                  </span>
                  <span className="fig text-right">
                    {z.from}-{z.to} ppm<span className="micro faint block">{int(week.minutesByZone[String(z.zone)] ?? 0)} min esta semana</span>
                  </span>
                </li>
              ))}
            </ul>
            <p className="micro faint mt-2">Estimadas: FC máxima por edad (Tanaka) y reserva con tu pulso en reposo (Karvonen).</p>
          </>
        ) : (
          <Empty title="Faltan datos para tus zonas" action={<Link className="btn" href="/ajustes">Ir a Ajustes</Link>}>Hacen falta la fecha de nacimiento y el pulso en reposo.</Empty>
        )}
      </Section>

      <Section title="Pasos" id="pasos" aside={steps != null ? <span className="fig">{int(steps)} hoy</span> : "sin dato de hoy"}>
        <FormAction action={logStepsAction} submit="Guardar pasos">
          <div className="field">
            <label htmlFor="steps">Pasos totales de hoy</label>
            <input id="steps" name="steps" className="input input-fig" inputMode="numeric" required />
          </div>
        </FormAction>
      </Section>

      <Section title="Sesiones de la semana" id="sesiones">
        {week.sessions.length === 0 ? (
          <Empty title="Sin cardio esta semana">Registra una sesión arriba o conecta el reloj.</Empty>
        ) : (
          <ul className="rows">
            {week.sessions.map((s) => (
              <li key={s.id} className="row">
                <span>
                  {MODE[s.mode]}
                  <span className="micro faint block">{day(s.date)} · {s.source}</span>
                </span>
                <span className="fig text-right">
                  {int(s.minutes)} min<span className="micro faint block">{s.avgHr ? `${s.avgHr} ppm` : "sin FC"}{s.zone != null ? ` · Z${s.zone}` : ""}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Conectar el reloj" id="reloj">
        <p className="small muted">
          El reloj o un atajo del móvil envían los datos con un token de ingesta a <span className="fig text-bone">POST /api/ingest/health</span>. El token se enseña una sola vez.
        </p>
        {live.length ? (
          <ul className="rows mt-3">
            {live.map((t) => (
              <li key={t.id} className="row items-center">
                <span>
                  {t.name}
                  <span className="micro faint block">creado {ago(t.createdAt, ankle.date)} · {t.lastUsedAt ? `último uso ${ago(t.lastUsedAt, ankle.date)}` : "sin usar"}</span>
                </span>
                <FormAction action={revokeTokenAction.bind(null, t.id)} submit="Revocar" quiet />
              </li>
            ))}
          </ul>
        ) : null}
        <FormAction action={createTokenAction} submit="Crear token" className="mt-3">
          <div className="field">
            <label htmlFor="token-name">Nombre del token</label>
            <input id="token-name" name="name" className="input" placeholder="Reloj" maxLength={80} required />
          </div>
        </FormAction>
        <details className="fold mt-3">
          <summary>Ejemplo de cuerpo (datos de muestra)</summary>
          <pre className="fold-b fig micro overflow-x-auto whitespace-pre text-bone-2">{`Authorization: Bearer fit_ing_…\nContent-Type: application/json\n\n${JSON.stringify(HEALTH_INGEST_EXAMPLE, null, 1)}`}</pre>
        </details>
        <p className="micro faint mt-2">El mismo ejemplo, siempre al día, en GET /api/ingest/health. {num(1000, 0)} muestras por lote como máximo.</p>
      </Section>
    </main>
  );
}
