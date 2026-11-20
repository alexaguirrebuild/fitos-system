"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { num, parseNum } from "@/lib/format";
import { logBodyAction } from "@/app/(app)/actions";

const FIELDS = [
  { key: "weightKg", label: "Peso", unit: "kg", lo: 30, hi: 300 },
  { key: "waistCm", label: "Cintura", unit: "cm", lo: 40, hi: 200 },
  { key: "neckCm", label: "Cuello", unit: "cm", lo: 20, hi: 70 },
  { key: "hipCm", label: "Cadera", unit: "cm", lo: 50, hi: 200 },
  { key: "chestCm", label: "Pecho", unit: "cm", lo: 50, hi: 200 },
  { key: "armCm", label: "Brazo", unit: "cm", lo: 15, hi: 70 },
  { key: "thighCm", label: "Muslo", unit: "cm", lo: 30, hi: 110 },
] as const;
type Key = (typeof FIELDS)[number]["key"];

/** Registro de peso (un campo, un toque) o de medidas completas (`full`). */
export function BodyForm({ full }: { full?: boolean }) {
  const router = useRouter();
  const [values, setValues] = useState<Partial<Record<Key, string>>>({});
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null);
  const [pending, start] = useTransition();
  const fields = full ? FIELDS : FIELDS.slice(0, 1);

  const submit = () => {
    const input: Partial<Record<Key, number>> = {};
    for (const f of fields) {
      const raw = (values[f.key] ?? "").trim();
      if (!raw) continue;
      const v = parseNum(raw);
      if (v == null || v < f.lo || v > f.hi) return setMsg({ text: `${f.label}: entre ${f.lo} y ${f.hi} ${f.unit}.`, bad: true });
      input[f.key] = v;
    }
    if (Object.keys(input).length === 0) return setMsg({ text: full ? "Pon al menos una medida." : "Pon el peso de hoy.", bad: true });
    start(async () => {
      try {
        const r = await logBodyAction(input);
        if (!r.ok) return setMsg({ text: r.error.message, bad: true });
        setValues({});
        const bf = r.data.bfPct != null ? ` Grasa estimada: ${num(r.data.bfPct)} %${r.data.bfMarginPts != null ? ` (± ${num(r.data.bfMarginPts)})` : ""}.` : "";
        setMsg({ text: `Guardado.${bf}${r.data.warnings.length ? ` ${r.data.warnings.join(" ")}` : ""}`, bad: false });
        router.refresh();
      } catch {
        setMsg({ text: "Sin conexión: no se ha guardado. Vuelve a pulsar cuando haya red.", bad: true });
      }
    });
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className={full ? "grid grid-cols-2 gap-3" : "flex items-end gap-3"}>
        {fields.map((f) => (
          <div key={f.key} className="field min-w-0 flex-1">
            <label htmlFor={`body-${f.key}`}>
              {full ? f.label : "Peso de hoy"} <span className="faint">· {f.unit}</span>
            </label>
            <input id={`body-${f.key}`} className="input input-fig" inputMode="decimal" autoComplete="off" placeholder="0,0" value={values[f.key] ?? ""} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
          </div>
        ))}
        {!full ? (
          <button type="submit" className="btn flex-none" disabled={pending}>
            {pending ? "…" : "Guardar"}
          </button>
        ) : null}
      </div>
      {full ? (
        <button type="submit" className="btn btn-block mt-3" disabled={pending}>
          {pending ? "Guardando…" : "Guardar medidas"}
        </button>
      ) : null}
      {msg ? (
        <p className={`small mt-2 ${msg.bad ? "err" : "muted"}`} role={msg.bad ? "alert" : "status"}>
          {msg.text}
        </p>
      ) : null}
    </form>
  );
}
