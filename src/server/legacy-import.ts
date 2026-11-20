/**
 * Hereda el histórico de SISTEMA-ALEX-APP (tablas `entrenos` y `estado`) sin perder nada:
 * - cada fila de `entrenos` → una sesión + sus series, con su fecha original;
 * - la fila original se guarda íntegra en `workouts.legacy`;
 * - el nombre que escribiste queda en `exercise_name_raw` aunque no se pueda enlazar a la librería;
 * - es idempotente: repetirlo no duplica (clave `legacy_key = fecha|día`).
 */
import { estimate1RM, effectiveReps } from "@/engine";
import { withUser, type Db } from "@/db/client";

export type LegacyEntreno = {
  fecha: string;
  dia: string | number;
  created_at?: string;
  data: {
    sub?: string; srpe?: number; dur?: number; load?: number; tonelaje?: number; efectivas?: number;
    ejercicios?: { n?: string; grupo?: string | null; sch?: string; rir?: number | null; nota?: string | null; e1rm?: number | null;
      sets?: { kg?: number | string | null; reps?: number | string | null; rir?: number | string | null }[] }[];
  };
};
export type LegacyEstado = { data: Record<string, unknown>; updated_at?: string };

export const normalizeText = (s: string) =>
  s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

type Cat = { id: string; phrases: string[] };

/** Enlaza un nombre en texto libre con la librería: igualdad o la frase conocida más larga contenida en el texto. */
export function matchExercise(raw: string, catalog: Cat[]): string | null {
  const t = ` ${normalizeText(raw)} `;
  if (t.trim().length < 2) return null;
  let best: { id: string; len: number } | null = null;
  for (const c of catalog)
    for (const p of c.phrases) {
      if (p.length < 4) continue;
      if (t.includes(` ${p} `) && (!best || p.length > best.len)) best = { id: c.id, len: p.length };
    }
  return best?.id ?? null;
}

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
};
const clamp = (v: number | null, lo: number, hi: number) => (v == null ? null : Math.max(lo, Math.min(hi, v)));

export async function importLegacy(userId: string, input: { entrenos: LegacyEntreno[]; estado?: LegacyEstado | null }, db?: Db) {
  const report = { workouts: 0, sets: 0, exercises: 0, linked: 0, unlinked: 0, unlinkedNames: [] as string[], checkins: 0, skippedSets: 0 };

  await withUser(userId, async (tx) => {
    const cat = (await tx.query<{ id: string; slug: string; name: string; aliases: string[] }>("select id, slug, name, aliases from fit.exercises")).map((e) => ({
      id: e.id,
      phrases: [...new Set([normalizeText(e.name), normalizeText(e.slug), ...(e.aliases ?? []).map(normalizeText)])],
    }));

    for (const row of input.entrenos) {
      const d = row.data ?? {};
      const key = `${row.fecha}|${row.dia}`;
      const srpe = clamp(num(d.srpe), 0, 10);
      const dur = clamp(num(d.dur), 0, 600);
      const [w] = await tx.query<{ id: string }>(
        `insert into fit.workouts (date, name, status, srpe, duration_min, tonnage, hard_sets, source, legacy_key, legacy, started_at)
         values ($1,$2,'hecha',$3,$4,$5,$6,'legacy',$7,$8,$9)
         on conflict (user_id, legacy_key) do update set name = excluded.name, srpe = excluded.srpe, duration_min = excluded.duration_min,
           tonnage = excluded.tonnage, hard_sets = excluded.hard_sets, legacy = excluded.legacy, updated_at = now()
         returning id`,
        [row.fecha, d.sub ? `${row.dia} · ${d.sub}` : String(row.dia), srpe, dur == null ? null : Math.round(dur), num(d.tonelaje),
          num(d.efectivas) == null ? null : Math.round(num(d.efectivas)!), key, JSON.stringify(row), row.created_at ?? null],
      );
      await tx.query("delete from fit.workout_sets where workout_id = $1", [w.id]);
      report.workouts++;

      let pos = 0;
      for (const e of d.ejercicios ?? []) {
        const sets = (e.sets ?? []).filter((s) => s);
        if (!sets.length) continue;
        pos++;
        report.exercises++;
        const raw = (e.n ?? "").trim();
        const exId = raw ? matchExercise(raw, cat) : null;
        if (exId) report.linked++;
        else {
          report.unlinked++;
          if (raw && report.unlinkedNames.length < 40 && !report.unlinkedNames.includes(raw)) report.unlinkedNames.push(raw);
        }
        let idx = 0;
        for (const s of sets) {
          const kg = num(s.kg);
          const reps = num(s.reps);
          const rir = clamp(num(s.rir), 0, 10);
          if (reps == null || reps < 0 || reps > 200 || (kg != null && (kg < 0 || kg > 2000))) { report.skippedSets++; continue; }
          idx++;
          const e1 = kg && reps ? estimate1RM({ kg, reps: Math.round(reps), rir }) : null;
          await tx.query(
            `insert into fit.workout_sets (workout_id, exercise_id, exercise_name_raw, exercise_position, set_index, kg, reps, rir,
               rir_target, e1rm, e1rm_confidence, effective_reps, note, done_at, created_at)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)`,
            [w.id, exId, raw || null, pos, idx, kg, Math.round(reps), rir, clamp(num(e.rir), 0, 10), e1 ? Math.round(e1.value * 100) / 100 : null,
              e1?.confidence ?? null, effectiveReps(Math.round(reps), rir), idx === 1 ? (e.nota ?? null) : null, `${row.fecha}T12:00:00Z`],
          );
          report.sets++;
        }
      }
    }

    const st = input.estado?.data;
    if (st) {
      const log = (st.checkinLog as { fecha?: string; r?: number }[] | undefined) ?? [];
      for (const c of log) {
        if (!c?.fecha || c.r == null) continue;
        await tx.query(
          `insert into fit.checkins (date, readiness, source) values ($1,$2,'legacy')
           on conflict (user_id, date) do update set readiness = excluded.readiness where fit.checkins.source = 'legacy'`,
          [c.fecha, Math.round(c.r)],
        );
        report.checkins++;
      }
      const ck = st.checkin as Record<string, unknown> | undefined;
      const ckDate = st.checkinDate as string | undefined;
      if (ck && ckDate) {
        const s10 = (v: unknown) => clamp(num(v) == null ? null : Math.round(num(v)!), 1, 10);
        await tx.query(
          `insert into fit.checkins (date, sleep_quality, sleep_hours, stress, motivation, pain, fatigue, source)
           values ($1,$2,$3,$4,$5,$6,$7,'legacy')
           on conflict (user_id, date) do update set sleep_quality = excluded.sleep_quality, sleep_hours = excluded.sleep_hours,
             stress = excluded.stress, motivation = excluded.motivation, pain = excluded.pain, fatigue = excluded.fatigue
           where fit.checkins.source = 'legacy'`,
          [ckDate, s10(ck.sueno), clamp(num(ck.horas), 0, 24), s10(ck.estres), s10(ck.motiv), s10(ck.dolor), s10(ck.fatiga)],
        );
      }
      // Peso y cintura venían sin fecha: no se inventa una. Quedan guardados tal cual para el onboarding.
      const legacy = {
        peso: st.peso, pesoObj: st.pesoObj, pesoHist: st.pesoHist, cintura: st.cintura, cinturaObj: st.cinturaObj, cinturaHist: st.cinturaHist,
        cardio: st.cardio, nutri: st.nutri, exportado: input.estado?.updated_at ?? null,
        nota: "Lecturas de peso y cintura sin fecha en la app antigua. No se han convertido en mediciones.",
      };
      await tx.query(
        `update fit.athletes set onboarding = onboarding || jsonb_build_object('legacy', $1::jsonb),
           goal_weight_kg = coalesce(goal_weight_kg, $2), goal_waist_cm = coalesce(goal_waist_cm, $3), updated_at = now()
         where id = auth.uid()`,
        [JSON.stringify(legacy), num(st.pesoObj), num(st.cinturaObj)],
      );
    }
    await tx.query("insert into fit.audit_log (user_id, actor, action, payload) values (auth.uid(), 'import', 'legacy_import', $1)", [
      JSON.stringify({ workouts: report.workouts, sets: report.sets, linked: report.linked, unlinked: report.unlinked }),
    ]);
  }, db);

  return report;
}
