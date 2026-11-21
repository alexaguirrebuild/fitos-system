"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { OnboardingStatus, SaveOnboardingInput } from "@/server/services/athlete";
import { day, num, parseNum } from "@/lib/format";
import { chooseProgram, saveStep } from "./actions";

type Dated = { value: number; date: string } | null;
type ClassBlock = { title: string; weekday: number; start: string; end: string };
type ExamBlock = { title: string; from: string; to: string };

export type WizardInitial = {
  today: string;
  heightCm: number | null;
  heightConfirmed: boolean;
  birthDate: string | null;
  hrRest: number | null;
  bedtime: string | null;
  adhdMedication: boolean | null;
  weeklyFoodBudgetEur: number | null;
  stores: string[];
  lastWeight: Dated;
  lastWaist: Dated;
  lastNeck: Dated;
  ankle: { status: "abierta" | "vigilancia" | "cerrada"; lastPain: number | null; lastPainDate: string | null; limits: string | null } | null;
  classes: ClassBlock[];
  exams: ExamBlock[];
  templates: { slug: string; name: string; weeks: number; source: string | null; microcycleDays: number; sessions: string[] }[];
  activeProgram: string | null;
  contradictions: string[];
  missing: OnboardingStatus["missing"];
};

const STEPS = ["altura", "nacimiento", "peso", "cintura", "cuello", "pulso", "acostarse", "tobillo", "medicacion", "clases", "examenes", "compra", "marcas", "experiencia", "programa", "resumen"] as const;
type Step = (typeof STEPS)[number];
const OPTIONAL: Step[] = ["cintura", "cuello", "pulso", "acostarse", "tobillo", "medicacion", "clases", "examenes", "compra", "marcas", "experiencia"];
const WEEKDAYS = [
  { v: 1, l: "Lunes" }, { v: 2, l: "Martes" }, { v: 3, l: "Miércoles" }, { v: 4, l: "Jueves" }, { v: 5, l: "Viernes" }, { v: 6, l: "Sábado" }, { v: 0, l: "Domingo" },
];
const STORES = [{ v: "mercadona", l: "Mercadona" }, { v: "lidl", l: "Lidl" }, { v: "otro", l: "Otra" }];
const LEVELS: { key: "years" | "technique" | "progress" | "education"; q: string; opts: string[] }[] = [
  { key: "years", q: "Años entrenando en serio", opts: ["Menos de 1", "1 a 3", "3 a 5", "Más de 5"] },
  { key: "technique", q: "Técnica", opts: ["Aprendiendo", "Correcta", "Sólida", "Depurada"] },
  { key: "progress", q: "Cada cuánto subes marcas", opts: ["Cada sesión", "Cada semana", "Cada mes", "Cada varios meses"] },
  { key: "education", q: "Lo que sabes de entrenamiento", opts: ["Poco", "Lo básico", "Bastante", "Formación seria"] },
];
const FIELD_LABEL: Record<string, string> = {
  heightCm: "Altura", birthDate: "Fecha de nacimiento", weightKg: "Peso", waistCm: "Cintura", hrRest: "Pulso en reposo", bedtime: "Hora de acostarte",
  ankle: "Tobillo", program: "Programa", adhdMedication: "Medicación", weeklyFoodBudgetEur: "Presupuesto de comida", stores: "Tiendas",
};

function Choice({ pressed, onClick, children, wide }: { pressed: boolean; onClick: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <button type="button" className={`chip ${wide ? "w-full justify-start text-left" : ""}`} aria-pressed={pressed} onClick={onClick}>
      {children}
    </button>
  );
}

function NumField({ id, label, unit, value, onChange, placeholder, integer }: { id: string; label: string; unit: string; value: string; onChange: (v: string) => void; placeholder?: string; integer?: boolean }) {
  return (
    <div className="field">
      <label htmlFor={id}>
        {label} <span className="faint">· {unit}</span>
      </label>
      <input id={id} className="input input-fig" inputMode={integer ? "numeric" : "decimal"} autoComplete="off" enterKeyHint="next" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

export function Wizard({ initial }: { initial: WizardInitial }) {
  const router = useRouter();
  const [idx, setIdx] = useState(0);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [missing, setMissing] = useState(initial.missing);
  const [skipped, setSkipped] = useState<Step[]>([]);

  const [height, setHeight] = useState(initial.heightConfirmed && initial.heightCm ? num(initial.heightCm) : "");
  const [birth, setBirth] = useState(initial.birthDate ?? "");
  const [weight, setWeight] = useState("");
  const [waist, setWaist] = useState("");
  const [neck, setNeck] = useState("");
  const [hr, setHr] = useState(initial.hrRest ? String(initial.hrRest) : "");
  const [bed, setBed] = useState(initial.bedtime ?? "");
  const [pain, setPain] = useState<number | null>(null);
  const [run, setRun] = useState<"sigue" | "libre" | "cerrada" | null>(null);
  const [med, setMed] = useState<"si" | "no" | "nd" | null>(initial.adhdMedication == null ? null : initial.adhdMedication ? "si" : "no");
  const [classes, setClasses] = useState<ClassBlock[]>(initial.classes);
  const [draftClass, setDraftClass] = useState<ClassBlock>({ title: "", weekday: 1, start: "09:00", end: "11:00" });
  const [exams, setExams] = useState<ExamBlock[]>(initial.exams);
  const [draftExam, setDraftExam] = useState<ExamBlock>({ title: "", from: "", to: "" });
  const [budget, setBudget] = useState(initial.weeklyFoodBudgetEur != null ? num(initial.weeklyFoodBudgetEur) : "");
  const [stores, setStores] = useState<string[]>(initial.stores);
  const [lifts, setLifts] = useState({ bench: "", squat: "", deadlift: "", pullup: "" });
  const [levels, setLevels] = useState<Record<string, number>>({});
  const [level, setLevel] = useState<{ score: number; label: string } | null>(null);
  const [program, setProgram] = useState<string | null>(initial.activeProgram);

  const step = STEPS[idx];
  const optional = OPTIONAL.includes(step);
  const go = (n: number) => {
    setError(null);
    setIdx(Math.max(0, Math.min(STEPS.length - 1, n)));
    window.scrollTo({ top: 0 });
  };

  /** Guarda lo de este paso y avanza. `payload` null = no hay nada que guardar. */
  const save = (payload: SaveOnboardingInput | null) => {
    setError(null);
    if (!payload) return go(idx + 1);
    start(async () => {
      try {
        const r = await saveStep(payload);
        if (!r.ok) return setError(r.error.message);
        setMissing(r.data.status.missing);
        if (r.data.warnings.length) setWarnings((w) => [...new Set([...w, ...r.data.warnings])]);
        if (r.data.level) setLevel(r.data.level);
        setSkipped((s) => s.filter((x) => x !== step));
        go(idx + 1);
      } catch {
        setError("Sin conexión. Tus respuestas siguen aquí: pulsa Continuar cuando vuelva la red.");
      }
    });
  };
  const skip = () => {
    setSkipped((s) => (s.includes(step) ? s : [...s, step]));
    go(idx + 1);
  };
  const need = (v: number | null, lo: number, hi: number, what: string): v is number => {
    if (v == null || v < lo || v > hi) {
      setError(`${what}: entre ${lo} y ${hi}.`);
      return false;
    }
    return true;
  };

  const submit = () => {
    switch (step) {
      case "altura": {
        const v = parseNum(height);
        if (need(v, 120, 230, "Altura en centímetros")) save({ heightCm: v, heightConfirmed: true });
        break;
      }
      case "nacimiento":
        if (!/^\d{4}-\d{2}-\d{2}$/.test(birth) || birth >= initial.today) setError("Pon tu fecha de nacimiento.");
        else save({ birthDate: birth });
        break;
      case "peso": {
        const v = parseNum(weight);
        if (need(v, 30, 300, "Peso en kg")) save({ weightKg: v, measuredOn: initial.today });
        break;
      }
      case "cintura": {
        const v = parseNum(waist);
        if (need(v, 40, 200, "Cintura en cm")) save({ waistCm: v, measuredOn: initial.today });
        break;
      }
      case "cuello": {
        const v = parseNum(neck);
        if (need(v, 20, 70, "Cuello en cm")) save({ neckCm: v, measuredOn: initial.today });
        break;
      }
      case "pulso": {
        const v = parseNum(hr);
        if (need(v, 30, 120, "Pulso en reposo")) save({ hrRest: Math.round(v) });
        break;
      }
      case "acostarse":
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(bed)) setError("Pon la hora en formato 23:30.");
        else save({ bedtime: bed });
        break;
      case "tobillo":
        if (run === "cerrada") save({ ankle: { status: "cerrada" } });
        else if (pain == null) setError("Marca el dolor de hoy de 0 a 10.");
        else if (!run) setError("Di si sigue la restricción de carrera.");
        else save({ ankle: { status: run === "sigue" ? "abierta" : "vigilancia", painToday: pain, limits: run === "sigue" ? "Restricción de carrera vigente: sin carrera ni impacto." : "Sin restricción de carrera. En vigilancia." } });
        break;
      case "medicacion":
        if (!med) setError("Elige una opción.");
        else if (med === "nd") skip();
        else save({ adhdMedication: med === "si" });
        break;
      case "clases":
        save({ classes });
        break;
      case "examenes":
        save({ exams });
        break;
      case "compra": {
        const v = budget.trim() ? parseNum(budget) : null;
        if (budget.trim() && !need(v, 0, 1000, "Presupuesto en euros")) break;
        if (v == null && stores.length === 0) setError("Pon el presupuesto, las tiendas o salta el paso.");
        else save({ ...(v != null ? { weeklyFoodBudgetEur: v } : {}), ...(stores.length ? { stores: stores as ("mercadona" | "lidl" | "otro")[] } : {}) });
        break;
      }
      case "marcas": {
        for (const [k, raw] of Object.entries(lifts)) {
          if (raw.trim() && (parseNum(raw) == null || parseNum(raw)! < 0 || parseNum(raw)! > 500)) return setError(`Marca no válida en ${k === "bench" ? "banca" : k === "squat" ? "sentadilla" : k === "deadlift" ? "peso muerto" : "dominada"}.`);
        }
        go(idx + 1);
        break;
      }
      case "experiencia": {
        if (LEVELS.some((l) => !levels[l.key])) return setError("Contesta las cuatro o salta el paso.");
        const l = Object.fromEntries(Object.entries(lifts).map(([k, raw]) => [k, parseNum(raw)]).filter(([, v]) => v != null && (v as number) > 0));
        save({ marks: { years: levels.years as 1 | 2 | 3 | 4, technique: levels.technique as 1 | 2 | 3 | 4, progress: levels.progress as 1 | 2 | 3 | 4, education: levels.education as 1 | 2 | 3 | 4, lifts: l } });
        break;
      }
      case "programa":
        if (!program) setError("Elige un programa: sin él no hay sesión de hoy.");
        else go(idx + 1);
        break;
      case "resumen":
        router.push("/");
        router.refresh();
        break;
    }
  };

  const pick = (slug: string) => {
    setError(null);
    start(async () => {
      try {
        const r = await chooseProgram(slug);
        if (!r.ok) return setError(r.error.message);
        setProgram(r.data.name);
        setMissing((m) => m.filter((x) => x.field !== "program"));
        go(idx + 1);
      } catch {
        setError("Sin conexión. Vuelve a elegirlo cuando haya red.");
      }
    });
  };

  const inherited = (d: Dated, unit: string, set: (v: string) => void) =>
    d ? (
      <div className="mt-4 border-y border-line py-3">
        <p className="small muted">
          Último dato guardado: <span className="fig text-fg">{num(d.value)} {unit}</span> · {day(d.date, initial.today)}. No se da por bueno hasta que lo confirmes.
        </p>
        <button type="button" className="btn mt-3" onClick={() => set(num(d.value))}>
          Hoy sigue en {num(d.value)} {unit}
        </button>
      </div>
    ) : null;

  let title = "";
  let why = "";
  let body: ReactNode = null;
  switch (step) {
    case "altura":
      title = "¿Cuánto mides?";
      why = "174 cm en la hoja de junio, 164 cm en otra ficha: ¿cuál vale? Sin la altura confirmada no se calculan el gasto ni el % graso.";
      body = (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Choice pressed={height === "174"} onClick={() => setHeight("174")}>174 cm</Choice>
            <Choice pressed={height === "164"} onClick={() => setHeight("164")}>164 cm</Choice>
          </div>
          <div className="mt-4">
            <NumField id="h" label="Otra medida" unit="cm" value={height} onChange={setHeight} placeholder="174" />
          </div>
        </>
      );
      break;
    case "nacimiento":
      title = "Fecha de nacimiento";
      why = "La edad entra en el gasto en reposo y en las zonas de pulso.";
      body = (
        <div className="field">
          <label htmlFor="b">Día, mes y año</label>
          <input id="b" type="date" className="input" value={birth} max={initial.today} onChange={(e) => setBirth(e.target.value)} />
        </div>
      );
      break;
    case "peso":
      title = "Peso de hoy";
      why = "En ayunas si puede ser. Es el punto de partida de la tendencia y de las calorías.";
      body = (
        <>
          <NumField id="w" label="Peso" unit="kg" value={weight} onChange={setWeight} placeholder="0,0" />
          {inherited(initial.lastWeight, "kg", setWeight)}
        </>
      );
      break;
    case "cintura":
      title = "Cintura de hoy";
      why = "A la altura del ombligo, sin meter tripa. Enseña el progreso que la báscula no enseña.";
      body = (
        <>
          <NumField id="wa" label="Cintura" unit="cm" value={waist} onChange={setWaist} placeholder="0,0" />
          {inherited(initial.lastWaist, "cm", setWaist)}
        </>
      );
      break;
    case "cuello":
      title = "Cuello";
      why = "Opcional. Con cuello y cintura se estima el % graso (método de la Marina). Sin él, la estimación es más gruesa.";
      body = (
        <>
          <NumField id="n" label="Cuello" unit="cm" value={neck} onChange={setNeck} placeholder="0,0" />
          {inherited(initial.lastNeck, "cm", setNeck)}
        </>
      );
      break;
    case "pulso":
      title = "Pulso en reposo";
      why = "Al despertar, antes de levantarte. Con él se calculan tus zonas de cardio.";
      body = <NumField id="hr" label="Frecuencia cardiaca en reposo" unit="ppm" value={hr} onChange={setHr} placeholder="55" integer />;
      break;
    case "acostarse":
      title = "¿A qué hora te acuestas?";
      why = "Marca el corte de cafeína: 9 horas antes.";
      body = (
        <div className="field">
          <label htmlFor="bed">Hora habitual</label>
          <input id="bed" type="time" className="input input-fig" value={bed} onChange={(e) => setBed(e.target.value)} />
        </div>
      );
      break;
    case "tobillo":
      title = "El tobillo, hoy";
      why = "Decide si hay sentadilla libre, impacto y carrera.";
      body = (
        <>
          {initial.ankle?.lastPain != null ? (
            <p className="small muted mb-3">
              Último apunte: <span className="fig text-fg">{initial.ankle.lastPain}/10</span> · {day(initial.ankle.lastPainDate, initial.today)}
            </p>
          ) : null}
          <fieldset disabled={run === "cerrada"} className={run === "cerrada" ? "opacity-40" : undefined}>
            <legend className="label mb-2">Dolor de 0 (nada) a 10</legend>
            <div className="grid grid-cols-6 gap-2">
              {Array.from({ length: 11 }, (_, n) => (
                <button key={n} type="button" className="chip fig px-0" aria-pressed={pain === n} onClick={() => setPain(n)}>
                  {n}
                </button>
              ))}
            </div>
          </fieldset>
          <fieldset className="mt-6">
            <legend className="label mb-2">Restricción de carrera</legend>
            <div className="flex flex-col gap-2">
              <Choice wide pressed={run === "sigue"} onClick={() => setRun("sigue")}>Sigue: sin carrera ni impacto</Choice>
              <Choice wide pressed={run === "libre"} onClick={() => setRun("libre")}>Ya puedo correr, en vigilancia</Choice>
              <Choice wide pressed={run === "cerrada"} onClick={() => setRun("cerrada")}>Ya no molesta: cerrar la lesión</Choice>
            </div>
          </fieldset>
        </>
      );
      break;
    case "medicacion":
      title = "¿Tomas medicación para el TDAH?";
      why = "Solo sirve para una cosa: no proponerte cafeína a ciegas. No se usa para nada más ni sale de aquí.";
      body = (
        <div className="flex flex-col gap-2">
          <Choice wide pressed={med === "si"} onClick={() => setMed("si")}>Sí</Choice>
          <Choice wide pressed={med === "no"} onClick={() => setMed("no")}>No</Choice>
          <Choice wide pressed={med === "nd"} onClick={() => setMed("nd")}>Prefiero no decirlo</Choice>
          {med === "nd" ? <p className="small muted mt-2">Vale. Mientras no se sepa, la app no te sugiere dosis de cafeína.</p> : null}
        </div>
      );
      break;
    case "clases":
      title = "Horario de clases";
      why = "Opcional. Bloques de la UCM que se repiten cada semana: la app evita proponerte entrenar encima.";
      body = (
        <>
          {classes.length ? (
            <ul className="rows mb-5">
              {classes.map((c, k) => (
                <li key={`${c.title}-${k}`} className="row items-center">
                  <span className="min-w-0">
                    <span className="block truncate">{c.title}</span>
                    <span className="fig micro faint">{WEEKDAYS.find((w) => w.v === c.weekday)?.l} · {c.start}-{c.end}</span>
                  </span>
                  <button type="button" className="btn btn-quiet" onClick={() => setClasses(classes.filter((_, j) => j !== k))} aria-label={`Quitar ${c.title}`}>Quitar</button>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="grid gap-3">
            <div className="field">
              <label htmlFor="ct">Asignatura</label>
              <input id="ct" className="input" value={draftClass.title} onChange={(e) => setDraftClass({ ...draftClass, title: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="cd">Día</label>
              <select id="cd" className="input" value={draftClass.weekday} onChange={(e) => setDraftClass({ ...draftClass, weekday: Number(e.target.value) })}>
                {WEEKDAYS.map((w) => <option key={w.v} value={w.v}>{w.l}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="field">
                <label htmlFor="cs">Empieza</label>
                <input id="cs" type="time" className="input input-fig" value={draftClass.start} onChange={(e) => setDraftClass({ ...draftClass, start: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="ce">Acaba</label>
                <input id="ce" type="time" className="input input-fig" value={draftClass.end} onChange={(e) => setDraftClass({ ...draftClass, end: e.target.value })} />
              </div>
            </div>
            <button
              type="button"
              className="btn"
              onClick={() => {
                if (!draftClass.title.trim() || !draftClass.start || !draftClass.end || draftClass.start >= draftClass.end) return setError("Pon la asignatura y un horario con el inicio antes del final.");
                setError(null);
                setClasses([...classes, { ...draftClass, title: draftClass.title.trim() }]);
                setDraftClass({ ...draftClass, title: "" });
              }}
            >
              Añadir bloque
            </button>
          </div>
        </>
      );
      break;
    case "examenes":
      title = "Exámenes";
      why = "Opcional. En periodo de exámenes el plan pasa a mantenimiento: cuentan como estrés alto.";
      body = (
        <>
          {exams.length ? (
            <ul className="rows mb-5">
              {exams.map((x, k) => (
                <li key={`${x.title}-${k}`} className="row items-center">
                  <span className="min-w-0">
                    <span className="block truncate">{x.title}</span>
                    <span className="fig micro faint">{day(x.from, initial.today)} → {day(x.to, initial.today)}</span>
                  </span>
                  <button type="button" className="btn btn-quiet" onClick={() => setExams(exams.filter((_, j) => j !== k))} aria-label={`Quitar ${x.title}`}>Quitar</button>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="grid gap-3">
            <div className="field">
              <label htmlFor="xt">Periodo</label>
              <input id="xt" className="input" placeholder="Exámenes de enero" value={draftExam.title} onChange={(e) => setDraftExam({ ...draftExam, title: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="field">
                <label htmlFor="xf">Desde</label>
                <input id="xf" type="date" className="input" value={draftExam.from} onChange={(e) => setDraftExam({ ...draftExam, from: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="xo">Hasta</label>
                <input id="xo" type="date" className="input" value={draftExam.to} onChange={(e) => setDraftExam({ ...draftExam, to: e.target.value })} />
              </div>
            </div>
            <button
              type="button"
              className="btn"
              onClick={() => {
                if (!draftExam.title.trim() || !draftExam.from || !draftExam.to || draftExam.from > draftExam.to) return setError("Pon el nombre y las dos fechas, con el inicio antes del final.");
                setError(null);
                setExams([...exams, { ...draftExam, title: draftExam.title.trim() }]);
                setDraftExam({ title: "", from: "", to: "" });
              }}
            >
              Añadir periodo
            </button>
          </div>
        </>
      );
      break;
    case "compra":
      title = "Comida: presupuesto y tiendas";
      why = "La lista de la compra se ajusta a ese dinero y a los precios de esas tiendas.";
      body = (
        <>
          <NumField id="bu" label="Presupuesto semanal" unit="€" value={budget} onChange={setBudget} placeholder="0" />
          <fieldset className="mt-6">
            <legend className="label mb-2">Dónde compras</legend>
            <div className="grid grid-cols-3 gap-2">
              {STORES.map((s) => (
                <Choice key={s.v} pressed={stores.includes(s.v)} onClick={() => setStores(stores.includes(s.v) ? stores.filter((x) => x !== s.v) : [...stores, s.v])}>
                  {s.l}
                </Choice>
              ))}
            </div>
          </fieldset>
        </>
      );
      break;
    case "marcas":
      title = "Tus marcas";
      why = "Opcional. 1RM actual o estimado. Deja en blanco lo que no sepas: no se inventa.";
      body = (
        <div className="grid grid-cols-2 gap-3">
          <NumField id="lb" label="Press banca" unit="kg" value={lifts.bench} onChange={(v) => setLifts({ ...lifts, bench: v })} />
          <NumField id="ls" label="Sentadilla" unit="kg" value={lifts.squat} onChange={(v) => setLifts({ ...lifts, squat: v })} />
          <NumField id="ld" label="Peso muerto" unit="kg" value={lifts.deadlift} onChange={(v) => setLifts({ ...lifts, deadlift: v })} />
          <NumField id="lp" label="Dominada (tú + lastre)" unit="kg" value={lifts.pullup} onChange={(v) => setLifts({ ...lifts, pullup: v })} />
        </div>
      );
      break;
    case "experiencia":
      title = "Experiencia";
      why = "Con esto y tus marcas se calcula el nivel, que fija cuántas series semanales tienen sentido. Si saltas el paso, las marcas no se guardan.";
      body = (
        <div className="flex flex-col gap-6">
          {LEVELS.map((l) => (
            <fieldset key={l.key}>
              <legend className="label mb-2">{l.q}</legend>
              <div className="grid grid-cols-2 gap-2">
                {l.opts.map((o, k) => (
                  <Choice key={o} pressed={levels[l.key] === k + 1} onClick={() => setLevels({ ...levels, [l.key]: k + 1 })}>
                    {o}
                  </Choice>
                ))}
              </div>
            </fieldset>
          ))}
        </div>
      );
      break;
    case "programa":
      title = "Elige programa";
      why = program ? `Activo ahora: ${program}. Elegir otro lo sustituye y empieza hoy.` : "Sin programa activo no hay sesión de hoy ni progresión. Empieza hoy.";
      body = initial.templates.length ? (
        <ul className="flex flex-col gap-3">
          {initial.templates.map((t) => (
            <li key={t.slug} className="border border-line-strong p-4" style={{ borderRadius: "var(--radius)" }}>
              <h3 className="text-lg font-medium leading-snug">{t.name}</h3>
              <p className="fig small muted mt-1">
                {t.weeks} semanas · rueda de {t.microcycleDays} días · {t.sessions.length} sesiones
              </p>
              <p className="small mt-2">{t.sessions.join(" · ")}</p>
              <button type="button" className="btn btn-primary btn-block mt-4" disabled={pending} onClick={() => pick(t.slug)}>
                Activar
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No hay plantillas de programa en el servidor. Revisa la carpeta de programas.</p>
      );
      break;
    case "resumen": {
      const pendingFields = missing.filter((m) => m.field !== "program" || !program);
      title = pendingFields.length ? "Queda esto sin confirmar" : "Ficha completa";
      why = pendingFields.length ? "Puedes entrar ya. Lo que falta limita lo que la app puede calcular; se completa desde Ajustes." : "Todo lo necesario está confirmado.";
      body = (
        <>
          {pendingFields.length ? (
            <ul className="rows">
              {pendingFields.map((m) => (
                <li key={m.field} className="row flex-col items-start gap-0.5">
                  <span className="font-medium">{FIELD_LABEL[m.field] ?? m.field}</span>
                  <span className="small muted">{m.why}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {skipped.includes("experiencia") || skipped.includes("marcas") ? <p className="small muted mt-4">Marcas y nivel de entrenamiento: sin guardar.</p> : null}
          {level ? (
            <p className="mt-4">
              Nivel de entrenamiento: <span className="fig">{num(level.score)}</span> · {level.label}
            </p>
          ) : null}
          {program ? <p className="mt-4">Programa activo: {program}.</p> : null}
          {warnings.map((w) => (
            <p key={w} className="small muted mt-3">{w}</p>
          ))}
        </>
      );
      break;
    }
  }

  const last = step === "resumen";
  return (
    <main className="page-bare flex min-h-dvh flex-col">
      <div className="flex items-center gap-3">
        <div className="meter flex-1" role="progressbar" aria-label="Avance de la ficha" aria-valuemin={1} aria-valuemax={STEPS.length} aria-valuenow={idx + 1}>
          <i style={{ width: `${((idx + 1) / STEPS.length) * 100}%` }} />
        </div>
        <span className="fig micro faint">{idx + 1}/{STEPS.length}</span>
      </div>

      <form
        className="flex flex-1 flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="mt-8">
          <h1 className="display text-[2.25rem]">{title}</h1>
          <p className="muted mt-3">{why}</p>
        </div>
        <div className="mt-7 flex-1">{body}</div>

        {error ? <p role="alert" className="err mt-4">{error}</p> : null}

        <div className="sticky bottom-0 -mx-5 mt-8 border-t border-line bg-bg px-5 pt-3" style={{ paddingBottom: "calc(var(--safe-b) + 12px)" }}>
          {step !== "programa" ? (
            <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={pending}>
              {pending ? "Guardando…" : last ? "Ir a Hoy" : "Continuar"}
            </button>
          ) : program ? (
            <button type="submit" className="btn btn-lg btn-block" disabled={pending}>
              Seguir con {program.length > 22 ? "el activo" : program}
            </button>
          ) : null}
          <div className="mt-1 flex justify-between">
            <button type="button" className="btn btn-quiet" onClick={() => go(idx - 1)} disabled={idx === 0 || pending}>
              Atrás
            </button>
            {optional ? (
              <button type="button" className="btn btn-quiet" onClick={skip} disabled={pending}>
                Saltar
              </button>
            ) : null}
          </div>
        </div>
      </form>
    </main>
  );
}
