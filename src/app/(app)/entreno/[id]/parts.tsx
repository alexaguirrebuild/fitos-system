"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore, useTransition } from "react";
import { IconCamera } from "@/components/icons";
import { Stepper } from "@/components/stepper";
import { mmss, num, parseNum } from "@/lib/format";
import { restTimer } from "@/lib/rest-timer";
import type { FinishWorkoutInput, WorkoutSummary } from "@/server/services/training";
import { alternativesAction, finishWorkoutAction, searchExercisesAction } from "../actions";

/* ───────────────────────── Descanso ───────────────────────── */

/** Cuenta atrás del descanso. Vibra al acabar si el móvil lo permite. Devuelve null si no hay descanso en curso. */
export function RestBar() {
  const end = useSyncExternalStore(restTimer.subscribe, restTimer.get, restTimer.server);
  const [left, setLeft] = useState<number | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (end == null) return;
    let hide: number | undefined;
    const tick = () => {
      const ms = end - Date.now();
      if (ms <= 0) {
        if (typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate([220, 120, 220]);
        restTimer.clear();
        setLeft(null);
        setDone(true);
        hide = window.setTimeout(() => setDone(false), 6000);
        return;
      }
      setLeft(Math.ceil(ms / 1000));
    };
    const first = window.setTimeout(tick, 0);
    const t = window.setInterval(tick, 250);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(t);
      if (hide) window.clearTimeout(hide);
    };
  }, [end]);

  if (end == null || left == null) {
    return done ? (
      <p className="flex min-h-12 items-center font-medium" role="status">
        Descanso terminado. Siguiente serie.
      </p>
    ) : null;
  }
  return (
    <div className="flex items-center justify-between gap-3" role="timer" aria-label={`Descanso: quedan ${mmss(left)}`}>
      <div className="flex items-baseline gap-3">
        <span className="small muted">Descanso</span>
        <span className="fig text-[1.75rem] leading-none">{mmss(left)}</span>
      </div>
      <div className="flex gap-2">
        <button type="button" className="btn" onClick={() => restTimer.add(30)} aria-label="Añadir 30 segundos">
          +30 s
        </button>
        <button type="button" className="btn" onClick={() => restTimer.clear()}>
          Saltar
        </button>
      </div>
    </div>
  );
}

/* ───────────────────────── Elegir ejercicio (añadir / cambiar) ───────────────────────── */

type Pick = { id: string; name: string; primaryMuscle: string | null; equipment: string | null; ankleLoad: string; impact: boolean };

function PickList({ items, onPick, busy }: { items: Pick[]; onPick: (p: Pick) => void; busy: boolean }) {
  return (
    <ul className="rows mt-3">
      {items.map((e) => (
        <li key={e.id}>
          <button type="button" className="row" disabled={busy} onClick={() => onPick(e)}>
            <span className="min-w-0">
              <span className="block">{e.name}</span>
              <span className="micro faint">
                {[e.primaryMuscle, e.equipment?.replace(/_/g, " ")].filter(Boolean).join(" · ")}
                {e.ankleLoad === "alta" || e.impact ? <span className="accent"> · carga el tobillo</span> : null}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function AddExercise({ ankleRestricted, onPick, busy }: { ankleRestricted: boolean; onPick: (id: string) => void; busy: boolean }) {
  const [q, setQ] = useState("");
  const [safe, setSafe] = useState(ankleRestricted);
  const [items, setItems] = useState<Pick[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, start] = useTransition();
  const seq = useRef(0);

  const search = (text: string, ankleSafe: boolean) => {
    setQ(text);
    setSafe(ankleSafe);
    const mine = ++seq.current;
    if (text.trim().length < 2) return setItems(null);
    start(async () => {
      try {
        const r = await searchExercisesAction({ q: text.trim(), ankleSafe: ankleSafe || undefined });
        if (mine !== seq.current) return;
        if (r.ok) {
          setItems(r.data);
          setError(null);
        } else setError(r.error.message);
      } catch {
        if (mine === seq.current) setError("Sin conexión: no se puede buscar ahora.");
      }
    });
  };

  return (
    <div>
      <div className="field">
        <label htmlFor="add-q">Buscar ejercicio</label>
        <input id="add-q" className="input" value={q} autoComplete="off" autoCapitalize="none" placeholder="press, remo, curl…" onChange={(e) => search(e.target.value, safe)} />
      </div>
      <button type="button" className="chip mt-3" aria-pressed={safe} onClick={() => search(q, !safe)}>
        Solo seguros para el tobillo
      </button>
      {error ? <p role="alert" className="err mt-3">{error}</p> : null}
      {items == null ? (
        <p className="small muted mt-4">Escribe al menos dos letras. Da igual tildes y mayúsculas.</p>
      ) : items.length === 0 ? (
        <p className="small muted mt-4">Nada con ese nombre{safe ? " entre los seguros para el tobillo" : ""}.</p>
      ) : (
        <PickList items={items} busy={busy} onPick={(p) => onPick(p.id)} />
      )}
    </div>
  );
}

export function SwapExercise({ exerciseId, name, ankleRestricted, onPick, busy }: { exerciseId: string; name: string; ankleRestricted: boolean; onPick: (id: string) => void; busy: boolean }) {
  const [safe, setSafe] = useState(true);
  const [state, setState] = useState<{ safe: boolean; items: Pick[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    alternativesAction({ exerciseId, ankleSafe: safe })
      .then((r) => {
        if (!alive) return;
        if (r.ok) {
          setState({ safe, items: r.data });
          setError(null);
        } else setError(r.error.message);
      })
      .catch(() => alive && setError("Sin conexión: no se pueden cargar alternativas."));
    return () => {
      alive = false;
    };
  }, [exerciseId, safe]);

  const loading = !state || state.safe !== safe;
  return (
    <div>
      <p className="muted small">
        Sustituye a {name} solo en esta sesión. La pauta (series, rango y RIR) se conserva.
        {ankleRestricted ? " El tobillo está restringido hoy." : ""}
      </p>
      <button type="button" className="chip mt-3" aria-pressed={safe} onClick={() => setSafe(!safe)}>
        Solo seguras para el tobillo
      </button>
      {error ? <p role="alert" className="err mt-3">{error}</p> : null}
      {loading && !error ? (
        <div className="mt-4 space-y-2" aria-busy="true">
          <div className="skel h-12" />
          <div className="skel h-12" />
          <div className="skel h-12" />
        </div>
      ) : state && state.items.length === 0 ? (
        <p className="small muted mt-4">No hay alternativas{safe ? " seguras para el tobillo" : ""} para el mismo grupo.</p>
      ) : state ? (
        <PickList items={state.items} busy={busy} onPick={(p) => onPick(p.id)} />
      ) : null}
    </div>
  );
}

/* ───────────────────────── Vídeo de una serie ───────────────────────── */

type UploadState = { kind: "idle" } | { kind: "subiendo"; name: string } | { kind: "ok"; text: string } | { kind: "pendiente"; text: string } | { kind: "error"; text: string };

export function VideoButton({ meta }: { meta: Record<string, unknown> }) {
  const [state, setState] = useState<UploadState>({ kind: "idle" });
  const id = useId();

  const upload = async (file: File) => {
    setState({ kind: "subiendo", name: file.name });
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("meta", JSON.stringify(meta));
      const res = await fetch("/api/media/upload", { method: "POST", body: form });
      const body = (await res.json().catch(() => null)) as { status?: string; message?: string; missing?: string[] } | null;
      if (!res.ok) return setState({ kind: "error", text: body?.message ?? "No se pudo subir el vídeo." });
      if (body?.status === "subido") return setState({ kind: "ok", text: "Subido a Drive." });
      if (body?.status === "pendiente")
        return setState({ kind: "pendiente", text: `Pendiente: Drive sin configurar${body.missing?.length ? ` (${body.missing.join(", ")})` : ""}. Los datos de la serie sí se han guardado; el fichero no.` });
      setState({ kind: "error", text: body?.message ?? "Drive no aceptó el fichero." });
    } catch {
      setState({ kind: "error", text: "Sin conexión: el vídeo no se ha subido. Sigue en tu galería." });
    }
  };

  return (
    <div>
      <label htmlFor={id} className="btn btn-block" aria-disabled={state.kind === "subiendo"}>
        <IconCamera width={20} height={20} />
        {state.kind === "subiendo" ? "Subiendo…" : "Grabar vídeo"}
      </label>
      <input
        id={id}
        type="file"
        accept="video/*"
        capture="environment"
        className="sr-only"
        disabled={state.kind === "subiendo"}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void upload(f);
        }}
      />
      {state.kind !== "idle" && state.kind !== "subiendo" ? (
        <p className={`small mt-2 ${state.kind === "error" ? "err" : "muted"}`} role="status">
          {state.text}
        </p>
      ) : null}
    </div>
  );
}

/* ───────────────────────── Cerrar sesión ───────────────────────── */

export function FinishForm({ workoutId, date, startedAt, onDone }: { workoutId: string; date: string; startedAt: string | null; onDone: (s: WorkoutSummary) => void }) {
  const [srpe, setSrpe] = useState<number | null>(null);
  // Duración por defecto: desde que se abrió la sesión. Se calcula al montar la hoja (al pulsar «Cerrar sesión»).
  const [minutes, setMinutes] = useState(() => {
    const m = startedAt ? Math.round((Date.now() - Date.parse(startedAt)) / 60_000) : 60;
    return String(Math.max(1, Math.min(600, m)));
  });
  const [gear, setGear] = useState({ kneeSleeves: false, belt: false, straps: false });
  const [caf, setCaf] = useState("0");
  const [cafAt, setCafAt] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const submit = () => {
    if (srpe == null) return setError("Marca el esfuerzo de la sesión (sRPE).");
    const dur = parseNum(minutes);
    if (dur == null || dur < 1 || dur > 600) return setError("Duración entre 1 y 600 minutos.");
    const mg = Math.round(parseNum(caf) ?? 0);
    const input: FinishWorkoutInput = {
      workoutId, srpe, durationMin: Math.round(dur), ...gear,
      ...(notes.trim() ? { notes: notes.trim() } : {}),
      ...(mg > 0 ? { caffeineMg: mg } : {}),
      ...(mg > 0 && /^\d{2}:\d{2}$/.test(cafAt) ? { caffeineAt: new Date(`${date}T${cafAt}:00`).toISOString() } : {}),
    };
    setError(null);
    start(async () => {
      try {
        const r = await finishWorkoutAction(input);
        if (r.ok) onDone(r.data);
        else setError(r.error.message);
      } catch {
        setError("Sin conexión. La sesión sigue abierta con sus series: ciérrala cuando vuelva la red.");
      }
    });
  };

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <fieldset>
        <legend className="label mb-2">Esfuerzo de la sesión entera (sRPE): 1 suave, 10 máximo</legend>
        <div className="grid grid-cols-5 gap-2">
          {Array.from({ length: 10 }, (_, k) => k + 1).map((n) => (
            <button key={n} type="button" className="chip fig px-0" aria-pressed={srpe === n} onClick={() => setSrpe(n)}>
              {n}
            </button>
          ))}
        </div>
      </fieldset>
      <Stepper label="Duración" unit="min" value={minutes} onChange={setMinutes} step={5} min={1} max={600} inputMode="numeric" decimals={0} />
      <fieldset>
        <legend className="label mb-2">Material</legend>
        <div className="grid grid-cols-3 gap-2">
          {([["kneeSleeves", "Rodilleras"], ["belt", "Cinturón"], ["straps", "Straps"]] as const).map(([k, l]) => (
            <button key={k} type="button" className="chip px-1" aria-pressed={gear[k]} onClick={() => setGear({ ...gear, [k]: !gear[k] })}>
              {l}
            </button>
          ))}
        </div>
      </fieldset>
      <div className="grid grid-cols-[1fr_7.5rem] items-end gap-3">
        <Stepper label="Cafeína antes" unit="mg" value={caf} onChange={setCaf} step={50} min={0} max={1000} inputMode="numeric" decimals={0} />
        <div className="field">
          <label htmlFor="caf-at">Hora</label>
          <input id="caf-at" type="time" className="input input-fig" style={{ minHeight: 58 }} value={cafAt} onChange={(e) => setCafAt(e.target.value)} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="notes">Nota</label>
        <textarea id="notes" className="input" rows={2} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      {error ? <p role="alert" className="err">{error}</p> : null}
      <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={pending}>
        {pending ? "Cerrando…" : "Guardar y cerrar"}
      </button>
    </form>
  );
}

export function SummaryView({ summary }: { summary: WorkoutSummary }) {
  return (
    <div>
      <div className="rows">
        <div className="row"><span className="row-k">Series efectivas</span><span className="fig">{num(summary.hardSets)}</span></div>
        <div className="row"><span className="row-k">Tonelaje</span><span className="fig">{Math.round(summary.tonnage).toLocaleString("es-ES")} kg</span></div>
        <div className="row"><span className="row-k">Carga (sRPE × min)</span><span className="fig">{Math.round(summary.load).toLocaleString("es-ES")}</span></div>
      </div>
      <h2 className="h-sec mt-8 mb-2">Marcas</h2>
      {summary.prs.length === 0 ? (
        <p className="muted">Ninguna marca nueva hoy.</p>
      ) : (
        <ul className="rows">
          {summary.prs.map((p) => (
            <li key={p.exerciseId} className="row">
              <span className="min-w-0 truncate">{p.name}</span>
              <span className="fig flex-none text-right">
                <span className="accent">PR</span> {num(p.e1rm)} kg
                <span className="micro faint block">e1RM estimado · antes {num(p.previous)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {summary.annotations.length ? (
        <>
          <h2 className="h-sec mt-8 mb-2">Anotaciones</h2>
          <ul className="rows">
            {summary.annotations.map((a) => (
              <li key={a.id} className="row flex-col items-start gap-1">
                <span className={`font-medium ${a.severity !== "info" ? "accent" : ""}`}>{a.title}</span>
                {a.body ? <span className="small muted">{a.body}</span> : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
