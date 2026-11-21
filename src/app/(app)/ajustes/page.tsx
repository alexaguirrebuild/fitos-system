import type { Metadata } from "next";
import Link from "next/link";
import { FormAction } from "@/components/form-action";
import { Empty, PageHeader, Row, Section } from "@/components/ui";
import { sessionOrLogin } from "@/app/_server/session";
import { logoutAction } from "@/app/login/actions";
import { ago, day, num } from "@/lib/format";
import { isDevAuth } from "@/server/auth";
import { missingDriveEnv } from "@/server/drive";
import { listIngestTokens } from "@/server/ingest-auth";
import { SCOPES, listGrants } from "@/server/oauth";
import { getAthlete, listSchedule } from "@/server/services/athlete";
import { listMuscleGroups } from "@/server/services/library";
import { getActivePlan, listProgramTemplates } from "@/server/services/plan";
import { todayIn } from "@/server/time";
import { deloadAction, importHistoryAction, profileAction, programAction, revokeGrantAction, volumeAction } from "./actions";

export const metadata: Metadata = { title: "Ajustes" };
/** Importar el histórico son ~2.000 inserciones contra Supabase: margen de sobra. */
export const maxDuration = 300;

const WEEKDAY = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];

function F({ name, label, unit, value, type, mode }: { name: string; label: string; unit?: string; value: string | number | null; type?: string; mode?: "decimal" | "numeric" }) {
  return (
    <div className="field">
      <label htmlFor={`a-${name}`}>{label}{unit ? <span className="faint"> · {unit}</span> : null}</label>
      <input id={`a-${name}`} name={name} type={type ?? "text"} inputMode={mode} className={`input ${mode ? "input-fig" : ""}`} defaultValue={value == null ? "" : typeof value === "number" ? num(value, 2) : value} autoComplete="off" />
    </div>
  );
}

export default async function AjustesPage() {
  const userId = await sessionOrLogin("/ajustes");
  const [a, schedule, plan, muscles, grants, tokens] = await Promise.all([getAthlete(userId), listSchedule(userId), getActivePlan(userId), listMuscleGroups(userId), listGrants(userId), listIngestTokens(userId)]);
  const { templates } = listProgramTemplates();
  const today = todayIn(a.timezone);
  const drive = missingDriveEnv();
  const liveTokens = tokens.filter((t) => !t.revokedAt);

  return (
    <main className="page">
      <PageHeader title="Ajustes" sub={a.email} back={{ href: "/mas", label: "Más" }} />

      <Section title="Ficha y objetivos" id="ficha">
        <FormAction action={profileAction} submit="Guardar ficha" primary>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2"><F name="name" label="Nombre" value={a.name} /></div>
            <F name="birthDate" label="Nacimiento" value={a.birthDate} type="date" />
            <F name="heightCm" label={a.heightConfirmed ? "Altura" : "Altura (sin confirmar)"} unit="cm" value={a.heightCm} mode="decimal" />
            <F name="goalWeightKg" label="Peso objetivo" unit="kg" value={a.goalWeightKg} mode="decimal" />
            <F name="goalWaistCm" label="Cintura objetivo" unit="cm" value={a.goalWaistCm} mode="decimal" />
            <F name="hrRest" label="Pulso en reposo" unit="ppm" value={a.hrRest} mode="numeric" />
            <F name="stepsGoal" label="Pasos en día On" value={a.stepsGoal} mode="numeric" />
            <F name="bedtime" label="Me acuesto" value={a.bedtime?.slice(0, 5) ?? null} type="time" />
            <F name="wakeTime" label="Me levanto" value={a.wakeTime?.slice(0, 5) ?? null} type="time" />
            <F name="weeklyFoodBudgetEur" label="Comida / semana" unit="€" value={a.weeklyFoodBudgetEur} mode="decimal" />
            <div className="field">
              <label htmlFor="a-med">Medicación TDAH</label>
              <select id="a-med" name="adhdMedication" className="input" defaultValue={a.adhdMedication == null ? "nd" : a.adhdMedication ? "si" : "no"}>
                <option value="si">Sí</option>
                <option value="no">No</option>
                <option value="nd">Prefiero no decirlo</option>
              </select>
            </div>
          </div>
          <p className="micro faint mt-2">La medicación solo se usa para no proponerte cafeína a ciegas. Tiendas: {a.stores.length ? a.stores.join(", ") : "sin elegir"}.</p>
        </FormAction>
      </Section>

      <Section title="Horario y exámenes" id="horario">
        {schedule.length === 0 ? (
          <p className="muted">Sin clases ni exámenes guardados.</p>
        ) : (
          <ul className="rows">
            {schedule.map((b) => (
              <li key={b.id} className="row">
                <span className="min-w-0 truncate">{b.title}</span>
                <span className="fig small flex-none text-right">
                  {b.weekday != null ? `${WEEKDAY[b.weekday]} ${b.start ?? ""}-${b.end ?? ""}` : `${day(b.from, today)} → ${day(b.to, today)}`}
                  <span className="micro faint block">{b.kind}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
        <Link href="/onboarding" className="btn btn-block mt-3">Editar en la ficha guiada</Link>
      </Section>

      <Section title="Programa" id="programa">
        {plan ? (
          <>
            <div className="rows">
              <Row k="Activo" v={plan.macrocycle.name} note={`desde ${day(plan.macrocycle.startDate, today)}`} />
              <Row k="Bloque" v={plan.mesocycle.name} note={`microciclo ${plan.microcycle.position} · ${day(plan.microcycle.startDate, today)} → ${day(plan.microcycle.endDate, today)}`} />
              <Row k="Descarga" v={plan.microcycle.isDeload ? "Sí, este microciclo" : "No"} warn={plan.microcycle.isDeload} />
            </div>
            <FormAction action={deloadAction.bind(null, plan.microcycle.id, !plan.microcycle.isDeload)} submit={plan.microcycle.isDeload ? "Quitar la descarga" : "Marcar este microciclo como descarga"} className="mt-3" />
          </>
        ) : (
          <Empty title="Sin programa activo">Elige uno para tener sesión del día y progresión.</Empty>
        )}
        <details className="fold mt-3">
          <summary>Cambiar de programa</summary>
          <div className="fold-b">
            <p className="small muted mb-3">Cierra el actual y empieza el nuevo hoy. El historial de sesiones se conserva.</p>
            {templates.map((t) => (
              <div key={t.slug} className="border-t border-line py-3">
                <p className="font-medium">{t.name}</p>
                <p className="fig micro faint">{t.weeks} semanas · {t.mesocycles[0]?.sessions.length ?? 0} sesiones por rueda</p>
                <FormAction action={programAction.bind(null, t.slug)} submit="Activar" className="mt-2" />
              </div>
            ))}
          </div>
        </details>
      </Section>

      <Section title="Volumen por grupo" id="volumen">
        <p className="small muted mb-2">Series efectivas por semana: mínimo (MEV) y máximo recuperable (MRV). Los valores de fábrica son orientativos.</p>
        {muscles.map((m) => (
          <details key={m.id} className="fold">
            <summary>
              <span>{m.name}{m.custom ? <span className="micro faint"> · propio</span> : null}</span>
              <span className="fig small ml-auto mr-3">{num(m.mev)}-{num(m.mrv)}</span>
            </summary>
            <div className="fold-b">
              <FormAction action={volumeAction.bind(null, m.id)} submit="Guardar">
                <div className="grid grid-cols-2 gap-3">
                  <F name="mev" label="MEV" value={m.mev} mode="decimal" />
                  <F name="mrv" label="MRV" value={m.mrv} mode="decimal" />
                </div>
                <p className="micro faint mt-2">De fábrica: {num(m.defaultMev)}-{num(m.defaultMrv)}.</p>
              </FormAction>
            </div>
          </details>
        ))}
      </Section>

      <Section title="Agentes conectados" id="agentes">
        {grants.length === 0 ? (
          <Empty title="Ningún agente conectado">Cuando conectes Muse u otro cliente MCP aparecerá aquí con sus permisos.</Empty>
        ) : (
          <ul>
            {grants.map((g) => (
              <li key={g.clientId} className="border-b border-line py-3">
                <p className="font-medium">{g.clientName ?? "Aplicación sin nombre"}</p>
                <p className="fig micro faint">
                  conectado {ago(g.createdAt.toISOString(), today)} · {g.lastUsedAt ? `último uso ${ago(g.lastUsedAt.toISOString(), today)}` : "sin usar"}
                </p>
                <ul className="small muted mt-1 list-disc pl-5">
                  {g.scopes.map((s) => <li key={s}>{SCOPES[s]} <span className="fig micro faint">{s}</span></li>)}
                </ul>
                <FormAction action={revokeGrantAction.bind(null, g.clientId)} submit="Desconectar" className="mt-2" />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Importar histórico" id="historico">
        <p className="small muted">
          El export de tu app anterior (<span className="fig text-fg">entrenos.json</span> y, si lo tienes, <span className="fig text-fg">estado.json</span>). Con él, la progresión, el volumen y el RIR parten de lo que ya has hecho. Reimportar actualiza; no duplica.
        </p>
        <FormAction action={importHistoryAction} submit="Importar" className="mt-3">
          <div className="field">
            <label htmlFor="imp-entrenos">entrenos.json</label>
            <input id="imp-entrenos" name="entrenos" type="file" accept="application/json,.json" className="input" required />
          </div>
          <div className="field mt-2">
            <label htmlFor="imp-estado">estado.json (opcional: check-ins)</label>
            <input id="imp-estado" name="estado" type="file" accept="application/json,.json" className="input" />
          </div>
        </FormAction>
      </Section>

      <Section title="Conexiones" id="conexiones">
        <div className="rows">
          <Row href="/cardio#reloj" k="Tokens de ingesta" v={<span className="fig">{liveTokens.length} activos</span>} note="reloj y atajos del móvil" />
          <Row k="Google Drive" v={drive.length === 0 ? "Configurado" : "Sin configurar"} note={drive.length ? `faltan: ${drive.join(", ")}` : "vídeos y fotos se suben a tu Drive"} warn={drive.length > 0} />
        </div>
      </Section>

      <Section title="Sesión" id="sesion">
        {isDevAuth() ? (
          <p className="muted">Modo desarrollo: se entra sin contraseña con el atleta local. No hay sesión que cerrar.</p>
        ) : (
          <form action={logoutAction}>
            <button type="submit" className="btn btn-block">Cerrar sesión</button>
          </form>
        )}
      </Section>
    </main>
  );
}
