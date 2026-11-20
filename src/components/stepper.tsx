"use client";

import { useId } from "react";
import { num, parseNum } from "@/lib/format";

/**
 * Pasador numérico: − valor +. El valor se guarda como texto para aceptar coma decimal mientras se escribe.
 * `step` es el salto real (2,5 kg en barra, 1 rep…); `min`/`max` acotan los botones.
 */
export function Stepper({
  label, value, onChange, step = 1, min = 0, max = 9999, unit, decimals = 2, inputMode = "decimal", hideLabel,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  step?: number;
  min?: number;
  max?: number;
  unit?: string;
  decimals?: number;
  inputMode?: "decimal" | "numeric";
  hideLabel?: boolean;
}) {
  const id = useId();
  const bump = (dir: 1 | -1) => {
    const cur = parseNum(value) ?? 0;
    // Se alinea al múltiplo del salto para que 101 + 2,5 dé 102,5 y no 103,5.
    const next = dir > 0 ? Math.floor(cur / step + 1e-9) * step + step : Math.ceil(cur / step - 1e-9) * step - step;
    onChange(num(Math.max(min, Math.min(max, next)), decimals));
  };
  return (
    <div className="field">
      <label htmlFor={id} className={hideLabel ? "sr-only" : undefined}>
        {label}
        {unit ? <span className="faint"> · {unit}</span> : null}
      </label>
      <div className="stepper">
        <button type="button" onClick={() => bump(-1)} aria-label={`Menos ${label}`}>
          −
        </button>
        <input
          id={id}
          inputMode={inputMode}
          autoComplete="off"
          enterKeyHint="done"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
        />
        <button type="button" onClick={() => bump(1)} aria-label={`Más ${label}`}>
          +
        </button>
      </div>
    </div>
  );
}
