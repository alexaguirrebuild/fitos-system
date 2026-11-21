"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { IconBack, IconCheck, IconPlus, IconSwap } from "@/components/icons";
import { Stepper } from "@/components/stepper";
import { ago, int, num, parseNum, repRange, setText } from "@/lib/format";
import { isNetworkError, queueAdd } from "@/lib/offline-queue";
import { restTimer } from "@/lib/rest-timer";
import { useQueue } from "@/lib/use-queue";
import type { ExerciseBlock, LogSetInput, WorkoutSummary, WorkoutView } from "@/server/services/training";
import { addExerciseAction, deleteSetAction, logSetAction, swapExerciseAction } from "../actions";
import { Sheet } from "@/components/sheet";
import { AddExercise, FinishForm, RestBar, SummaryView, SwapExercise, VideoButton } from "./parts";

type Draft = { kg: string; reps: string; rir: string };
type Flash = { exerciseId: string; text: string; pr: boolean };
type SheetState = { kind: "add" } | { kind: "finish" } | { kind: "swap"; exerciseId: string; name: string } | null;

const RULE: Record<string, string> = {
  primera: "Primera vez", subir_carga: "Sube carga", sumar_rep: "Suma una repetición", repetir: "Repite", bajar_carga: "Baja carga",
  descarga: "Descarga", readiness_bajo: "Readiness bajo", solo_z2: "Hoy solo Z2",
};

const working = (s: { setType: string }) => s.setType !== "aproximacion";

function defaults(b: ExerciseBlock): Draft {
  const s = b.suggestion;
  const last = b.sets.filter(working).at(-1);
  const kg = b.next?.kg ?? s?.kg ?? last?.kg ?? b.lastSession?.sets[0]?.kg ?? null;
  const reps = b.next?.reps ?? s?.repsTarget[Math.min(b.workingSetsDone, Math.max(0, s.repsTarget.length - 1))] ?? last?.reps ?? b.prescription?.repMin ?? null;
  const rir = b.next?.rir ?? s?.rirTarget ?? b.prescription?.rirTarget ?? null;
  return { kg: kg == null ? "" : num(kg, 2), reps: reps == null ? "" : String(reps), rir: rir == null ? "" : num(rir) };
}

function targetText(b: ExerciseBlock): string {
  const s = b.suggestion;
  const p = b.prescription;
  const reps = p && (p.repMin != null || p.repMax != null) ? repRange(p.repMin, p.repMax) : s?.repsTarget.length ? repRange(Math.min(...s.repsTarget), Math.max(...s.repsTarget)) : null;
  const rir = s?.rirTarget ?? p?.rirTarget ?? null;
  const load = s?.kg != null ? `${num(s.kg, 2)} kg` : "Carga libre";
  return [load, reps ? `× ${reps}` : null].filter(Boolean).join(" ") + (rir != null ? ` · RIR ${num(rir)}` : "");
}

export function LiveWorkout({ initial }: { initial: WorkoutView }) {
  const [view, setView] = useState(initial);
  const [seen, setSeen] = useState(initial);
  if (seen !== initial) {
    // El servidor ha mandado una vista nueva (p. ej. tras vaciar la cola sin conexión).
    setSeen(initial);
    setView(initial);
  }
  const queue = useQueue();
  const [activeId, setActiveId] = useState<string | null>(initial.next?.exerciseId ?? initial.exercises.find((e) => !e.done)?.exercise.id ?? initial.exercises[0]?.exercise.id ?? null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [sending, setSending] = useState<{ key: string; exerciseId: string; text: string }[]>([]);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<SheetState>(null);
  const [busy, setBusy] = useState(false);
  const [selectedSet, setSelectedSet] = useState<string | null>(null);
  const [summary, setSummary] = useState<WorkoutSummary | null>(null);
  const closeSheet = useCallback(() => setSheet(null), []);

  const w = view.workout;
  const queuedHere = queue.filter((q) => q.kind === "set" && (q.payload as LogSetInput).workoutId === w.id);
  const ankleRestricted = view.ankle.rule.restricted;

  const applyView = (v: WorkoutView, keepActive = true) => {
    setView(v);
    if (!keepActive || !v.exercises.some((e) => e.exercise.id === activeId && !e.done)) setActiveId(v.next?.exerciseId ?? v.exercises.find((e) => !e.done)?.exercise.id ?? activeId);
  };

  const logSet = async (b: ExerciseBlock) => {
    const d = drafts[b.exercise.id] ?? defaults(b);
    const kg = parseNum(d.kg);
    const reps = parseNum(d.reps);
    const rir = d.rir.trim() ? parseNum(d.rir) : null;
    if (kg == null || kg < 0 || kg > 1000) return setError("Pon la carga en kg (0 si es con tu peso).");
    if (reps == null || reps < 1 || reps > 200 || !Number.isInteger(reps)) return setError("Pon las repeticiones hechas.");
    if (d.rir.trim() && (rir == null || rir < 0 || rir > 10)) return setError("RIR entre 0 y 10, o vacío si no lo sabes.");
    setError(null);
    setFlash(null);

    // clientId y hora desde ya: el mismo envío se puede repetir desde la cola sin duplicar y con la hora real de la serie.
    const input: LogSetInput = { workoutId: w.id, exercise: b.exercise.id, kg, reps, ...(rir != null ? { rir } : {}), clientId: crypto.randomUUID(), doneAt: new Date().toISOString() };
    const text = setText({ kg, reps, rir });
    const key = crypto.randomUUID();
    restTimer.start(b.next?.restSeconds ?? b.prescription?.restSeconds ?? 120);

    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      queueAdd("set", input, `${b.exercise.name} · ${text}`);
      return;
    }
    setSending((s) => [...s, { key, exerciseId: b.exercise.id, text }]);
    try {
      const r = await logSetAction(input);
      if (!r.ok) setError(r.error.message);
      else if (!r.data.logged || !r.data.view) setError(r.data.problems.join(" ") || "No se pudo guardar la serie.");
      else {
        const l = r.data.logged;
        setDrafts((m) => {
          const rest = { ...m };
          delete rest[b.exercise.id];
          return rest;
        });
        applyView(r.data.view);
        if (l.next && l.next.exerciseId === b.exercise.id) restTimer.start(l.next.restSeconds);
        if (l.duplicate) setFlash({ exerciseId: b.exercise.id, text: "Esa serie ya estaba registrada hace un momento. No se duplica.", pr: false });
        else if (l.isPr && l.pr) setFlash({ exerciseId: b.exercise.id, text: `PR · e1RM ${num(l.pr.e1rm)} kg (antes ${num(l.pr.previous)})`, pr: true });
        else if (l.warnings.length) setFlash({ exerciseId: b.exercise.id, text: l.warnings.join(" "), pr: false });
      }
    } catch (e) {
      if (isNetworkError(e)) queueAdd("set", input, `${b.exercise.name} · ${text}`);
      else setError("No se pudo guardar la serie. Prueba otra vez.");
    } finally {
      setSending((s) => s.filter((x) => x.key !== key));
    }
  };

  const run = async (fn: () => Promise<{ ok: true; data: WorkoutView } | { ok: false; error: { message: string } }>, after?: (v: WorkoutView) => void) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      if (r.ok) {
        applyView(r.data);
        after?.(r.data);
        setSheet(null);
      } else setError(r.error.message);
    } catch {
      setError("Sin conexión: ese cambio necesita red.");
    } finally {
      setBusy(false);
    }
  };

  if (summary) {
    return (
      <main className="page">
        <h1 className="h-page">{w.name ?? "Sesión"} cerrada</h1>
        <p className="muted mt-2 mb-6">Guardada. Esto es lo que deja.</p>
        <SummaryView summary={summary} />
        <Link href="/" className="btn btn-primary btn-lg btn-block mt-8">
          Volver a Hoy
        </Link>
      </main>
    );
  }

  return (
    <main className="page" style={{ paddingBottom: "calc(var(--tab-h) + var(--safe-b) + 9.5rem)" }}>
      <header className="mb-5">
        <Link href="/entreno" className="-ml-2 mb-1 inline-flex min-h-12 items-center gap-1 pr-3 text-fg-2">
          <IconBack width={20} height={20} />
          <span className="small">Entreno</span>
        </Link>
        <h1 className="h-page">{w.name ?? "Sesión libre"}</h1>
        <p className="small muted mt-2">
          {view.readiness != null ? (
            <>
              Readiness <span className="fig text-fg">{Math.round(view.readiness)}</span> · {view.readinessLabel}
            </>
          ) : (
            <>
              Sin check-in hoy: las cargas no se ajustan por recuperación.{" "}
              <Link className="link" href="/bienestar">
                Hacerlo
              </Link>
            </>
          )}
        </p>
      </header>

      {view.deload ? <p className="notice mb-3">Semana de descarga: cargas recortadas, sin buscar marcas.</p> : null}
      {ankleRestricted ? (
        <div className="notice notice-warn mb-3" role="alert">
          <p className="notice-t">Tobillo {view.ankle.pain != null ? `${view.ankle.pain}/10` : "restringido"}</p>
          <p className="muted small mt-1">{view.ankle.rule.notes[0]}</p>
        </div>
      ) : null}

      {view.exercises.length === 0 ? (
        <div className="border-y border-line py-5">
          <p className="font-medium">Sesión vacía</p>
          <p className="muted small mt-1">Añade el primer ejercicio para empezar a registrar series.</p>
        </div>
      ) : null}

      <ol>
        {view.exercises.map((b) => {
          const id = b.exercise.id;
          const active = id === activeId;
          const d = drafts[id] ?? defaults(b);
          const setD = (patch: Partial<Draft>) => setDrafts((m) => ({ ...m, [id]: { ...(m[id] ?? defaults(b)), ...patch } }));
          const done = b.sets.filter(working);
          const pendingHere = sending.filter((s) => s.exerciseId === id);
          const queued = queuedHere.filter((q) => (q.payload as LogSetInput).exercise === id);
          const planned = b.prescription?.sets ?? b.suggestion?.sets ?? null;

          if (!active) {
            return (
              <li key={id} className="border-b border-line">
                <button type="button" className="flex min-h-14 w-full items-center justify-between gap-3 py-3 text-left" onClick={() => setActiveId(id)} aria-expanded={false}>
                  <span className="min-w-0">
                    <span className={`block truncate font-medium ${b.done ? "text-fg-2" : ""}`}>{b.exercise.name}</span>
                    <span className="fig micro faint">{targetText(b)}</span>
                  </span>
                  <span className={`fig small flex-none ${b.done ? "text-fg-2" : ""}`}>
                    {b.done ? <IconCheck width={18} height={18} className="mr-1 inline-block align-[-3px]" /> : null}
                    {b.workingSetsDone + queued.length}
                    {planned ? `/${planned}` : ""}
                  </span>
                </button>
              </li>
            );
          }

          return (
            <li key={id} className="slab -mx-2 my-3 px-4 pb-5 pt-4" aria-current="true">
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="text-lg font-bold leading-snug"><Link href={`/libreria/${id}`} className="hover:underline">{b.exercise.name}</Link></h2>
                <span className="fig small muted flex-none">
                  {b.workingSetsDone + queued.length}
                  {planned ? `/${planned}` : ""}
                </span>
              </div>
              {b.replaces ? <p className="micro faint">En lugar de {b.replaces.name}</p> : null}

              {(() => {
                const s = b.suggestion;
                const p = b.prescription;
                const reps = p && (p.repMin != null || p.repMax != null) ? repRange(p.repMin, p.repMax) : s?.repsTarget.length ? repRange(Math.min(...s.repsTarget), Math.max(...s.repsTarget)) : null;
                const rir = s?.rirTarget ?? p?.rirTarget ?? null;
                return (
                  <p className="mt-3 flex flex-wrap items-baseline gap-x-3">
                    <span className="display text-[3.5rem]">
                      {s?.kg != null ? <>{num(s.kg, 2)}<span className="unit">kg</span></> : reps ? <>{reps}<span className="unit">reps</span></> : "Libre"}
                    </span>
                    <span className="fig text-lg font-semibold">
                      {s?.kg != null && reps ? `× ${reps}` : s?.kg == null ? "carga libre" : ""}
                      {rir != null ? <span className="muted font-normal"> · RIR {num(rir)}</span> : null}
                    </span>
                  </p>
                );
              })()}
              {b.suggestion ? (
                <p className="small muted mt-1.5">
                  <span className="font-semibold text-fg">{RULE[b.suggestion.rule] ?? b.suggestion.rule}.</span> {b.suggestion.why}
                  {b.suggestion.defaultRx ? " Fuera del plan: pauta por defecto." : ""}
                </p>
              ) : null}
              {b.loadCap ? (
                <p className="small accent mt-1">
                  Tope hoy: {b.loadCap.pct} %{b.loadCap.kg != null ? ` · ${num(b.loadCap.kg, 2)} kg` : ""} ({b.loadCap.reason})
                </p>
              ) : null}
              <p className="fig micro faint mt-2">
                {b.lastSession ? `Última vez, ${ago(b.lastSession.date, w.date)}: ${b.lastSession.sets.map((s) => setText(s)).join(" / ")}` : "Sin historial de este ejercicio."}
              </p>

              {b.ankleWarning ? (
                <div className="notice notice-warn mt-3" role="alert">
                  <p className="small">{b.ankleWarning.message}</p>
                  {b.ankleWarning.alternative ? (
                    <button type="button" className="btn mt-2" disabled={busy || done.length > 0} onClick={() => run(() => swapExerciseAction({ workoutId: w.id, fromExerciseId: id, toExerciseId: b.ankleWarning!.alternative!.id }), (v) => setActiveId(v.exercises.find((e) => e.exercise.id === b.ankleWarning!.alternative!.id)?.exercise.id ?? null))}>
                      Cambiar por {b.ankleWarning.alternative.name}
                    </button>
                  ) : null}
                </div>
              ) : null}

              {done.length || pendingHere.length || queued.length ? (
                <ol className="mt-3 border-t border-line" aria-label="Series hechas">
                  {done.map((s, k) => (
                    <li key={s.id} className="border-b border-line">
                      <button type="button" className="fig flex min-h-12 w-full items-center justify-between gap-3 text-left" onClick={() => setSelectedSet(selectedSet === s.id ? null : s.id)} aria-expanded={selectedSet === s.id}>
                        <span>
                          <span className="faint mr-3">{k + 1}</span>
                          {setText(s)}
                        </span>
                        <span className="small muted">{s.e1rm != null ? `e1RM ${num(s.e1rm)}` : ""}</span>
                      </button>
                      {selectedSet === s.id ? (
                        <div className="pb-3">
                          <button type="button" className="btn" disabled={busy} onClick={() => run(() => deleteSetAction(s.id))}>
                            Borrar esta serie
                          </button>
                        </div>
                      ) : null}
                    </li>
                  ))}
                  {pendingHere.map((s) => (
                    <li key={s.key} className="fig flex min-h-12 items-center justify-between border-b border-line text-fg-2">
                      <span>{s.text}</span>
                      <span className="micro">enviando</span>
                    </li>
                  ))}
                  {queued.map((q) => (
                    <li key={q.id} className="fig flex min-h-12 items-center justify-between border-b border-line text-fg-2">
                      <span>{setText(q.payload as LogSetInput)}</span>
                      <span className="micro accent">sin enviar</span>
                    </li>
                  ))}
                </ol>
              ) : null}

              {flash && flash.exerciseId === id ? (
                <p className={`mt-3 ${flash.pr ? "display text-[1.75rem] accent" : "small muted"}`} role="status">
                  {flash.text}
                </p>
              ) : null}

              <div className="mt-4 grid gap-3">
                <Stepper label="Carga" unit={b.exercise.perSide ? "kg por lado" : "kg"} value={d.kg} onChange={(v) => setD({ kg: v })} step={b.exercise.loadStep > 0 ? b.exercise.loadStep : 2.5} max={1000} />
                <div className="grid grid-cols-2 gap-3">
                  <Stepper label="Reps" value={d.reps} onChange={(v) => setD({ reps: v })} step={1} min={0} max={200} inputMode="numeric" decimals={0} />
                  <Stepper label="RIR" value={d.rir} onChange={(v) => setD({ rir: v })} step={1} min={0} max={10} decimals={1} />
                </div>
                {error ? <p role="alert" className="err">{error}</p> : null}
                <button type="button" className="btn btn-primary btn-lg btn-block" onClick={() => void logSet(b)}>
                  Hecha
                </button>
              </div>

              <div className="mt-4">
                {b.warmup.length || b.plates ? (
                  <details className="fold">
                    <summary>Aproximaciones y discos</summary>
                    <div className="fold-b fig small">
                      {b.warmup.length ? (
                        <p>{b.warmup.map((x) => `${num(x.kg, 2)} × ${x.reps}`).join("  /  ")}</p>
                      ) : (
                        <p className="muted">Sin aproximaciones para esta carga.</p>
                      )}
                      {b.plates ? (
                        <p className="mt-2">
                          Por lado: {b.plates.plates.length ? b.plates.plates.map((p) => num(p, 2)).join(" + ") : "barra sola"}
                          {b.plates.exact ? "" : " (aproximado)"}
                        </p>
                      ) : null}
                    </div>
                  </details>
                ) : null}
                <details className="fold">
                  <summary>Técnica y vídeo</summary>
                  <div className="fold-b">
                    {b.exercise.cues ? <p className="small whitespace-pre-line">{b.exercise.cues}</p> : <p className="small muted">Sin claves técnicas guardadas para este ejercicio.</p>}
                    {b.prescription?.tempo ? <p className="fig small muted mt-2">Tempo {b.prescription.tempo}</p> : null}
                    {b.prescription?.notes ? <p className="small muted mt-2">{b.prescription.notes}</p> : null}
                    {b.exercise.videoUrls.length ? (
                      <ul className="mt-2">
                        {b.exercise.videoUrls.map((u, k) => (
                          <li key={u}>
                            <a className="link small" href={u} target="_blank" rel="noopener noreferrer">
                              Vídeo de referencia {b.exercise.videoUrls.length > 1 ? k + 1 : ""}
                            </a>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    <div className="mt-3">
                      <VideoButton
                        meta={{ workoutId: w.id, exerciseId: id, ...(done.at(-1) ? { workoutSetId: done.at(-1)!.id } : {}), kneeSleeves: w.kneeSleeves, belt: w.belt, straps: w.straps }}
                      />
                      <p className="micro faint mt-2">Se asocia a la última serie registrada de este ejercicio.</p>
                    </div>
                  </div>
                </details>
                <button type="button" className="btn btn-quiet mt-1 -ml-2" disabled={done.length > 0} onClick={() => setSheet({ kind: "swap", exerciseId: id, name: b.exercise.name })}>
                  <IconSwap width={18} height={18} />
                  {done.length > 0 ? "Ya tiene series: añade otro ejercicio" : "Cambiar ejercicio"}
                </button>
              </div>
            </li>
          );
        })}
      </ol>

      {activeId == null && error ? <p role="alert" className="err mt-3">{error}</p> : null}

      <div className="mt-6 grid gap-3">
        <button type="button" className="btn btn-block" onClick={() => setSheet({ kind: "add" })}>
          <IconPlus width={18} height={18} />
          Añadir ejercicio
        </button>
        <button type="button" className="btn btn-block" onClick={() => setSheet({ kind: "finish" })}>
          Cerrar sesión
        </button>
      </div>

      <div className="dock">
        <div>
          <RestBar />
          <div className="fig small flex min-h-9 items-center justify-between gap-4">
            <span>
              <span className="muted">Series efectivas</span> {num(view.totals.hardSets)}
            </span>
            <span>
              <span className="muted">Tonelaje</span> {int(view.totals.tonnage)} kg
            </span>
          </div>
        </div>
      </div>

      {sheet?.kind === "add" ? (
        <Sheet title="Añadir ejercicio" onClose={closeSheet}>
          <AddExercise ankleRestricted={ankleRestricted} busy={busy} onPick={(exId) => run(() => addExerciseAction({ workoutId: w.id, exercise: exId }), () => setActiveId(exId))} />
          {error ? <p role="alert" className="err mt-3">{error}</p> : null}
        </Sheet>
      ) : null}
      {sheet?.kind === "swap" ? (
        <Sheet title="Cambiar ejercicio" onClose={closeSheet}>
          <SwapExercise exerciseId={sheet.exerciseId} name={sheet.name} ankleRestricted={ankleRestricted} busy={busy} onPick={(toId) => run(() => swapExerciseAction({ workoutId: w.id, fromExerciseId: sheet.exerciseId, toExerciseId: toId }), () => setActiveId(toId))} />
          {error ? <p role="alert" className="err mt-3">{error}</p> : null}
        </Sheet>
      ) : null}
      {sheet?.kind === "finish" ? (
        <Sheet title="Cerrar sesión" onClose={closeSheet}>
          {queuedHere.length ? <p className="notice notice-warn mb-4 small">Hay {queuedHere.length} {queuedHere.length === 1 ? "serie" : "series"} sin enviar. Espera a tener red antes de cerrar o no contarán.</p> : null}
          <FinishForm
            workoutId={w.id}
            date={w.date}
            startedAt={w.startedAt}
            onDone={(s) => {
              restTimer.clear();
              setSheet(null);
              setSummary(s);
            }}
          />
        </Sheet>
      ) : null}
    </main>
  );
}
