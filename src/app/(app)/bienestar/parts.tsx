"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { num } from "@/lib/format";
import { pomsAction } from "./actions";

/** Deslizador con su cifra a la vista. `low`/`high` dicen qué significan los extremos. */
export function Slider({ name, label, low, high, min = 1, max = 10, step = 1, initial, unit }: { name: string; label: string; low: string; high: string; min?: number; max?: number; step?: number; initial: number; unit?: string }) {
  const id = useId();
  const [v, setV] = useState(initial);
  return (
    <div className="border-b border-line py-3">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id}>{label}</label>
        <output htmlFor={id} className="fig text-xl">
          {num(v)}{unit ? ` ${unit}` : ""}
        </output>
      </div>
      <input id={id} name={name} type="range" min={min} max={max} step={step} value={v} onChange={(e) => setV(Number(e.target.value))} className="mt-1 h-11 w-full" />
      <div className="micro faint flex justify-between">
        <span>{low}</span>
        <span>{high}</span>
      </div>
    </div>
  );
}

type Profile = { tension: number; depresion: number; colera: number; vigor: number; fatiga: number };
const SCALES: { k: keyof Profile; l: string }[] = [{ k: "tension", l: "Tensión" }, { k: "depresion", l: "Depresión" }, { k: "colera", l: "Cólera" }, { k: "vigor", l: "Vigor" }, { k: "fatiga", l: "Fatiga" }];

/** Perfil del POMS: cada escala de 0 a 1 sobre su máximo. El iceberg es el pico en vigor. */
export function PomsProfile({ normalized }: { normalized: Profile }) {
  const W = 320, H = 150, L = 20, B = 26;
  const x = (k: number) => L + (k * (W - L * 2)) / (SCALES.length - 1);
  const y = (v: number) => 10 + (1 - v) * (H - 10 - B);
  const d = SCALES.map((s, k) => `${k ? "L" : "M"}${x(k)} ${y(normalized[s.k])}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label={`Perfil POMS: ${SCALES.map((s) => `${s.l} ${Math.round(normalized[s.k] * 100)} %`).join(", ")}.`}>
      {[0, 0.5, 1].map((t) => <line key={t} x1={L} x2={W - L} y1={y(t)} y2={y(t)} stroke="var(--line)" />)}
      <path d={d} fill="none" stroke="var(--bone)" strokeWidth="1.6" />
      {SCALES.map((s, k) => (
        <g key={s.k}>
          <circle cx={x(k)} cy={y(normalized[s.k])} r="3" fill={s.k === "vigor" ? "var(--blood-ink)" : "var(--bone)"} />
          <text x={x(k)} y={H - 8} textAnchor="middle" fontSize="10.5" fill="var(--bone-2)">{s.l}</text>
        </g>
      ))}
    </svg>
  );
}

const PER_PAGE = 4;

export function Poms({ items, scale, instructions }: { items: { n: number; text: string }[]; scale: { value: number; label: string }[]; instructions: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [answers, setAnswers] = useState<(number | null)[]>(() => items.map(() => null));
  const [page, setPage] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ tmd: number; shape: string; reading: string; normalized: Profile } | null>(null);
  const [pending, start] = useTransition();
  const pages = Math.ceil(items.length / PER_PAGE);
  const slice = items.slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE);
  const answered = answers.filter((a) => a != null).length;

  if (result) {
    return (
      <div>
        <p><span className="display text-[2rem]">{result.tmd}</span> <span className="muted">TMD · perfil {result.shape}</span></p>
        <p className="small muted mt-1">{result.reading}</p>
        <div className="mt-3"><PomsProfile normalized={result.normalized} /></div>
      </div>
    );
  }
  if (!open) {
    return (
      <button type="button" className="btn btn-block" onClick={() => setOpen(true)}>
        Hacer el POMS · {items.length} ítems, unos 5 minutos
      </button>
    );
  }
  const next = () => {
    if (slice.some((it) => answers[it.n - 1] == null)) return setError("Contesta los de esta pantalla.");
    setError(null);
    if (page < pages - 1) return setPage(page + 1);
    start(async () => {
      try {
        const r = await pomsAction(answers as number[]);
        if (!r.ok) return setError(r.error.message);
        setResult({ tmd: r.data.tmd, shape: r.data.shape, reading: r.data.reading, normalized: r.data.normalized });
        router.refresh();
      } catch {
        setError("Sin conexión. Tus respuestas siguen aquí: vuelve a pulsar cuando haya red.");
      }
    });
  };
  return (
    <div>
      <div className="flex items-center gap-3">
        <div className="meter flex-1" role="progressbar" aria-label="Avance del POMS" aria-valuemin={0} aria-valuemax={items.length} aria-valuenow={answered}>
          <i style={{ width: `${(answered / items.length) * 100}%` }} />
        </div>
        <span className="fig micro faint">{answered}/{items.length}</span>
      </div>
      <p className="small muted mt-3">{instructions}</p>
      {slice.map((it) => (
        <fieldset key={it.n} className="mt-4">
          <legend className="font-medium">{it.text}</legend>
          <div className="mt-2 grid grid-cols-5 gap-1.5">
            {scale.map((s) => (
              <button key={s.value} type="button" className="chip flex-col px-0 leading-tight" aria-pressed={answers[it.n - 1] === s.value} aria-label={`${it.text}: ${s.label}`} onClick={() => setAnswers(answers.map((a, k) => (k === it.n - 1 ? s.value : a)))}>
                <span className="fig">{s.value}</span>
              </button>
            ))}
          </div>
        </fieldset>
      ))}
      <p className="micro faint mt-3">{scale.map((s) => `${s.value} ${s.label.toLowerCase()}`).join(" · ")}</p>
      {error ? <p role="alert" className="err mt-3">{error}</p> : null}
      <div className="mt-4 grid grid-cols-2 gap-2">
        <button type="button" className="btn" disabled={page === 0 || pending} onClick={() => setPage(page - 1)}>Atrás</button>
        <button type="button" className="btn btn-primary" disabled={pending} onClick={next}>{pending ? "Guardando…" : page < pages - 1 ? "Siguiente" : "Terminar"}</button>
      </div>
    </div>
  );
}
