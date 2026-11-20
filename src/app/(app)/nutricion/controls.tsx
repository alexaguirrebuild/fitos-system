"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Stepper } from "@/components/stepper";
import { day, int, num, parseNum } from "@/lib/format";
import type { ActionResult } from "@/lib/result";
import type { BuildShoppingListResult, GetTargetsResult, RecalcTargetsResult } from "@/server/services/nutrition";
import { buildShoppingListAction, deleteFoodLogAction, logCaffeineAction, recalcTargetsAction, setDayTypeAction, updateFoodLogAction } from "./actions";

/** Ejecuta una acción con estado de envío y mensaje de error común (incluido «sin conexión»). */
function useRun() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = <T,>(fn: () => Promise<ActionResult<T>>, onOk?: (data: T) => void) =>
    start(async () => {
      setError(null);
      try {
        const r = await fn();
        if (!r.ok) return setError(r.error.message);
        onOk?.(r.data);
        router.refresh();
      } catch {
        setError("Sin conexión: no se ha guardado.");
      }
    });
  return { run, pending, error, setError };
}

export function DayTypeSwitch({ dayType, forced, assumed }: { dayType: "on" | "off"; forced: boolean; assumed: boolean }) {
  const { run, pending, error } = useRun();
  const opts = [
    { v: "on" as const, l: "On · entreno" },
    { v: "off" as const, l: "Off · descanso" },
  ];
  return (
    <div>
      <div className="grid grid-cols-2 gap-2" role="group" aria-label="Tipo de día">
        {opts.map((o) => (
          <button key={o.v} type="button" className="chip" aria-pressed={dayType === o.v} disabled={pending} onClick={() => run(() => setDayTypeAction({ dayType: o.v }))}>
            {o.l}
          </button>
        ))}
      </div>
      <p className="micro faint mt-2">
        {forced ? "Forzado a mano. " : assumed ? "Supuesto: no hay sesión ni plan que lo diga. " : "Deducido de tu sesión o del plan. "}
        {forced ? (
          <button type="button" className="link" disabled={pending} onClick={() => run(() => setDayTypeAction({ dayType: "auto" }))}>
            Volver a automático
          </button>
        ) : null}
      </p>
      {error ? <p role="alert" className="err mt-1">{error}</p> : null}
    </div>
  );
}

export function LogRow({ log }: { log: { id: string; name: string; grams: number | null; kcal: number; proteinG: number; estimated: boolean } }) {
  const [open, setOpen] = useState(false);
  const [grams, setGrams] = useState(log.grams != null ? num(log.grams, 0) : "");
  const { run, pending, error, setError } = useRun();
  return (
    <li className="border-b border-line">
      <button type="button" className="flex min-h-12 w-full items-center justify-between gap-3 py-2 text-left" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="min-w-0">
          <span className="block truncate">{log.name}</span>
          <span className="fig micro faint">
            {log.grams != null ? `${int(log.grams)} g` : "sin gramos"}
            {log.estimated ? " · estimado" : ""}
          </span>
        </span>
        <span className="fig small flex-none text-right">
          {int(log.kcal)} kcal<span className="micro faint block">{int(log.proteinG)} g P</span>
        </span>
      </button>
      {open ? (
        <div className="pb-3">
          {log.grams != null ? <Stepper label="Gramos" unit="g" value={grams} onChange={setGrams} step={10} min={1} max={5000} inputMode="numeric" decimals={0} /> : null}
          <div className="mt-3 flex gap-2">
            {log.grams != null ? (
              <button
                type="button"
                className="btn flex-1"
                disabled={pending}
                onClick={() => {
                  const g = parseNum(grams);
                  if (g == null || g <= 0) return setError("Pon los gramos.");
                  run(() => updateFoodLogAction({ logId: log.id, grams: g }), () => setOpen(false));
                }}
              >
                Guardar gramos
              </button>
            ) : null}
            <button type="button" className="btn flex-1" disabled={pending} onClick={() => run(() => deleteFoodLogAction(log.id))}>
              Borrar
            </button>
          </div>
          {error ? <p role="alert" className="err mt-2">{error}</p> : null}
        </div>
      ) : null}
    </li>
  );
}

export function Caffeine({ todayMg, maxMg, lateDoses, note }: { todayMg: number; maxMg: number | null; lateDoses: number; note: string | null }) {
  const { run, pending, error } = useRun();
  const [warn, setWarn] = useState<string[]>([]);
  const add = (mg: number, source: string) => run(() => logCaffeineAction({ mg, source }), (d) => setWarn(d.warnings));
  return (
    <div>
      <p>
        <span className="fig text-xl">{todayMg} mg</span> <span className="muted">hoy{maxMg != null ? ` · referencia ${maxMg} mg` : ""}</span>
        {lateDoses > 0 ? <span className="accent"> · {lateDoses} después del corte</span> : null}
      </p>
      {note ? <p className="small muted mt-2">{note}</p> : null}
      <div className="mt-3 grid grid-cols-3 gap-2">
        <button type="button" className="btn px-1" disabled={pending} onClick={() => add(90, "café")}>Café 90</button>
        <button type="button" className="btn px-1" disabled={pending} onClick={() => add(160, "bebida energética")}>Lata 160</button>
        <button type="button" className="btn px-1" disabled={pending} onClick={() => add(200, "pre-entreno")}>Pre 200</button>
      </div>
      <p className="micro faint mt-2">Miligramos aproximados por toma. Se apunta a la hora actual.</p>
      {warn.map((w) => <p key={w} className="small accent mt-2" role="status">{w}</p>)}
      {error ? <p role="alert" className="err mt-2">{error}</p> : null}
    </div>
  );
}

export function Targets({ phase, current }: { phase: string | null; current?: GetTargetsResult | null }) {
  const [res, setRes] = useState<RecalcTargetsResult | null>(null);
  const { run, pending, error } = useRun();
  const MISSING: Record<string, string> = { peso: "una pesada", altura: "la altura confirmada", fecha_nacimiento: "la fecha de nacimiento" };
  return (
    <div>
      <p className="muted">
        {phase ? `Fase actual: ${phase}. ` : "Sin objetivos calculados. "}
        Calibración hasta tener 14 días con comida y 8 pesadas; después, gasto medido y déficit según tu peso objetivo.
      </p>
      <button type="button" className="btn btn-block mt-3" disabled={pending} onClick={() => run(() => recalcTargetsAction({}), setRes)}>
        {pending ? "Calculando…" : "Recalcular y ver de dónde sale"}
      </button>
      {error ? <p role="alert" className="err mt-2">{error}</p> : null}
      {res && !res.ok ? (
        <p className="notice notice-warn mt-3 small" role="alert">
          No se puede calcular: falta {res.missing.map((m) => MISSING[m] ?? m).join(", ")}. {res.warnings.join(" ")}
        </p>
      ) : null}
      {!res && current ? (
        <div className="mt-4">
          <div className="rows">
            <div className="row"><span className="row-k">Día On</span><span className="fig">{int(current.target.on.kcal)} kcal · {int(current.target.on.proteinG)} P · {int(current.target.on.carbsG)} H · {int(current.target.on.fatG)} G</span></div>
            <div className="row"><span className="row-k">Día Off</span><span className="fig">{int(current.target.off.kcal)} kcal · {int(current.target.off.proteinG)} P · {int(current.target.off.carbsG)} H · {int(current.target.off.fatG)} G</span></div>
          </div>
          <ul className="small muted mt-3 list-disc space-y-1 pl-5">
            {current.explain.map((e) => <li key={e}>{e}</li>)}
          </ul>
        </div>
      ) : null}
      {res && res.ok ? (
        <div className="mt-4">
          <div className="rows">
            <div className="row"><span className="row-k">Día On</span><span className="fig">{int(res.target.on.kcal)} kcal · {int(res.target.on.proteinG)} P · {int(res.target.on.carbsG)} H · {int(res.target.on.fatG)} G</span></div>
            <div className="row"><span className="row-k">Día Off</span><span className="fig">{int(res.target.off.kcal)} kcal · {int(res.target.off.proteinG)} P · {int(res.target.off.carbsG)} H · {int(res.target.off.fatG)} G</span></div>
            <div className="row"><span className="row-k">Gasto</span><span className="fig text-right">{int(res.target.tdee)} kcal<span className="micro faint block">{res.target.tdeeMethod === "medido" ? "medido con tus datos" : res.target.tdeeMethod === "mifflin" ? "estimado (Mifflin)" : "manual"}</span></span></div>
            <div className="row"><span className="row-k">Ritmo esperado</span><span className="fig">{num(res.expectedKgPerWeek, 2)} kg/sem</span></div>
            <div className="row"><span className="row-k">Calibración</span><span className="fig">{res.calibration.loggedDays}/{res.calibration.needDays} días · {res.calibration.weighIns}/{res.calibration.needWeighIns} pesadas</span></div>
            {res.bodyFat.pct != null ? <div className="row"><span className="row-k">Grasa</span><span className="fig text-right">{num(res.bodyFat.pct)} %<span className="micro faint block">estimado · {res.bodyFat.method}{res.bodyFat.marginPts != null ? ` · ± ${num(res.bodyFat.marginPts)}` : ""}</span></span></div> : null}
          </div>
          <ul className="small muted mt-3 list-disc space-y-1 pl-5">
            {res.explain.map((e) => <li key={e}>{e}</li>)}
          </ul>
          {res.warnings.map((w) => <p key={w} className="small accent mt-2">{w}</p>)}
          <p className="micro faint mt-2">{res.saved ? "Objetivos nuevos guardados." : "Sin cambios relevantes: se mantienen los que había."}</p>
        </div>
      ) : null}
    </div>
  );
}

type Shop = Extract<BuildShoppingListResult, { ok: true }>;

export function Shopping() {
  const [store, setStore] = useState<"mercadona" | "lidl" | null>(null);
  const [res, setRes] = useState<BuildShoppingListResult | null>(null);
  const { run, pending, error } = useRun();
  const ok: Shop | null = res && res.ok ? res : null;
  return (
    <div>
      <div className="grid grid-cols-3 gap-2" role="group" aria-label="Tienda">
        <button type="button" className="chip px-1" aria-pressed={store === null} onClick={() => setStore(null)}>Mis tiendas</button>
        <button type="button" className="chip px-1" aria-pressed={store === "mercadona"} onClick={() => setStore("mercadona")}>Mercadona</button>
        <button type="button" className="chip px-1" aria-pressed={store === "lidl"} onClick={() => setStore("lidl")}>Lidl</button>
      </div>
      <button type="button" className="btn btn-block mt-3" disabled={pending} onClick={() => run(() => buildShoppingListAction(store ? { store } : {}), setRes)}>
        {pending ? "Montando…" : "Lista de esta semana"}
      </button>
      {error ? <p role="alert" className="err mt-2">{error}</p> : null}
      {res && !res.ok ? <p className="notice mt-3 small">{res.problems.join(" ")}</p> : null}
      {ok ? (
        <div className="mt-4">
          <p className="small muted">
            Semana del {day(ok.weekStart)} · {ok.days.on} días On, {ok.days.off} Off{ok.days.fromPlan ? "" : " (supuestos)"} · {ok.mode === "comidas_ancla" ? "de tus comidas ancla" : "cesta base por proteína por euro"}
          </p>
          <p className="mt-2">
            <span className="fig text-xl">{ok.totalEur != null ? `${num(ok.totalEur, 2)} €` : "Sin importe"}</span>
            <span className={ok.overBudget ? "accent" : "muted"}>{ok.budgetEur != null ? ` de ${num(ok.budgetEur, 2)} € ${ok.overBudget ? "· se pasa" : ""}` : " · sin presupuesto en tu ficha"}</span>
          </p>
          {ok.missingPrices.length ? (
            <p className="notice notice-warn mt-3 small" role="alert">
              <span className="notice-t">Faltan precios.</span> El importe no incluye: {ok.missingPrices.join(", ")}. Sin precio fechado en 60 días no se inventa.
            </p>
          ) : null}
          {ok.lines.length === 0 ? (
            <p className="muted mt-3">La lista sale vacía: no hay alimentos con datos suficientes en el catálogo.</p>
          ) : (
            <ul className="rows mt-3">
              {ok.lines.map((l) => (
                <li key={l.foodId} className="row">
                  <span className="min-w-0 truncate">{l.name}</span>
                  <span className="fig small flex-none text-right">
                    {int(l.grams)} g{l.packs != null ? ` · ${l.packs} ud` : ""}
                    <span className="micro faint block">{l.costEur != null ? `${num(l.costEur, 2)} €` : "sin precio"}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {ok.notes.map((n) => <p key={n} className="small muted mt-2">{n}</p>)}
        </div>
      ) : null}
    </div>
  );
}
