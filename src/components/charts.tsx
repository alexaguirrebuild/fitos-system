/** Gráficas en SVG hecho a mano. Sin estado: se pintan en el servidor. */
import { day, diffDays, num } from "@/lib/format";

export type Series = {
  name: string;
  points: { date: string; y: number }[];
  /** `dots`: puntos sueltos (dato diario). `line`: línea continua (tendencia). */
  kind: "dots" | "line";
  tone?: "bone" | "accent" | "faint";
  dashed?: boolean;
};

const TONE = { bone: "var(--bone)", accent: "var(--blood-ink)", faint: "var(--bone-3)" } as const;
const W = 360;
const H = 180;
const PAD = { l: 38, r: 10, t: 10, b: 22 };

function niceTicks(lo: number, hi: number): number[] {
  if (hi === lo) return [lo];
  const span = hi - lo;
  const raw = span / 3;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 1000) / 1000);
  return out;
}

/**
 * Gráfica de líneas y puntos sobre fechas. `band` sombrea un rango del eje Y (p. ej. 0,8-1,3 del ratio de carga)
 * y `target` dibuja una horizontal con su etiqueta (el objetivo).
 */
export function LineChart({
  series, unit, label, band, target, decimals = 1,
}: {
  series: Series[];
  unit: string;
  /** Resumen para lectores de pantalla: qué es y qué dice. */
  label: string;
  band?: { from: number; to: number; label: string };
  target?: { y: number; label: string };
  decimals?: number;
}) {
  const all = series.flatMap((s) => s.points);
  if (all.length === 0) return null;
  const dates = all.map((p) => p.date).sort();
  const d0 = dates[0];
  const span = Math.max(1, diffDays(d0, dates[dates.length - 1]));
  const ys = all.map((p) => p.y).concat(target ? [target.y] : [], band ? [band.from, band.to] : []);
  let lo = Math.min(...ys);
  let hi = Math.max(...ys);
  const padY = (hi - lo || Math.abs(hi) || 1) * 0.08;
  lo -= padY;
  hi += padY;
  const X = (date: string) => PAD.l + (diffDays(d0, date) / span) * (W - PAD.l - PAD.r);
  const Y = (y: number) => PAD.t + (1 - (y - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
  const ticks = niceTicks(lo, hi);

  return (
    <figure className="m-0">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className="block h-auto w-full">
        {band ? <rect x={PAD.l} y={Y(band.to)} width={W - PAD.l - PAD.r} height={Math.max(0, Y(band.from) - Y(band.to))} fill="var(--bone)" opacity="0.07" /> : null}
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={Y(t)} y2={Y(t)} stroke="var(--line)" strokeWidth="1" />
            <text x={PAD.l - 6} y={Y(t) + 3.5} textAnchor="end" fontSize="10" fill="var(--bone-3)" fontFamily="var(--font-mono)">
              {num(t, decimals)}
            </text>
          </g>
        ))}
        {target ? (
          <g>
            <line x1={PAD.l} x2={W - PAD.r} y1={Y(target.y)} y2={Y(target.y)} stroke="var(--blood-ink)" strokeWidth="1" strokeDasharray="2 4" />
            <text x={W - PAD.r} y={Y(target.y) - 4} textAnchor="end" fontSize="10" fill="var(--blood-ink)" fontFamily="var(--font-mono)">
              {target.label}
            </text>
          </g>
        ) : null}
        {series.map((s) => {
          const c = TONE[s.tone ?? "bone"];
          if (s.kind === "dots")
            return (
              <g key={s.name} fill={c} opacity={s.tone === "faint" ? 0.9 : 1}>
                {s.points.map((p) => (
                  <circle key={p.date} cx={X(p.date)} cy={Y(p.y)} r="1.8" />
                ))}
              </g>
            );
          const d = s.points.map((p, k) => `${k ? "L" : "M"}${X(p.date).toFixed(1)} ${Y(p.y).toFixed(1)}`).join(" ");
          return (
            <g key={s.name}>
              <path d={d} fill="none" stroke={c} strokeWidth="1.6" strokeLinejoin="round" strokeDasharray={s.dashed ? "4 3" : undefined} />
              {s.points.length === 1 ? <circle cx={X(s.points[0].date)} cy={Y(s.points[0].y)} r="2.4" fill={c} /> : null}
            </g>
          );
        })}
        <text x={PAD.l} y={H - 5} fontSize="10" fill="var(--bone-3)" fontFamily="var(--font-mono)">
          {day(d0)}
        </text>
        <text x={W - PAD.r} y={H - 5} textAnchor="end" fontSize="10" fill="var(--bone-3)" fontFamily="var(--font-mono)">
          {day(dates[dates.length - 1])}
        </text>
      </svg>
      <figcaption className="micro faint mt-1 flex flex-wrap gap-x-4 gap-y-1">
        <span>Eje: {unit}</span>
        {series.map((s) => (
          <span key={s.name} className="inline-flex items-center gap-1.5">
            <svg width="16" height="8" aria-hidden="true">
              {s.kind === "dots" ? <circle cx="8" cy="4" r="2" fill={TONE[s.tone ?? "bone"]} /> : <line x1="0" x2="16" y1="4" y2="4" stroke={TONE[s.tone ?? "bone"]} strokeWidth="1.6" strokeDasharray={s.dashed ? "4 3" : undefined} />}
            </svg>
            {s.name}
          </span>
        ))}
        {band ? <span>Banda sombreada: {band.label}</span> : null}
      </figcaption>
    </figure>
  );
}

/** Barra horizontal de series semanales con las dos marcas: MEV (mínimo) y MRV (máximo recuperable). */
export function VolumeBar({ name, sets, mev, mrv, warn }: { name: string; sets: number; mev: number; mrv: number; warn?: boolean }) {
  const max = Math.max(mrv * 1.25, sets * 1.05, 1);
  const pct = (v: number) => `${Math.min(100, (v / max) * 100)}%`;
  return (
    <div className="py-2.5" role="img" aria-label={`${name}: ${num(sets)} series por semana. Mínimo ${num(mev)}, máximo ${num(mrv)}.`}>
      <div className="flex items-baseline justify-between gap-3">
        <span>{name}</span>
        <span className={`fig small ${warn ? "accent" : ""}`}>
          {num(sets)} <span className="faint">/ {num(mev)}-{num(mrv)}</span>
        </span>
      </div>
      <div className="relative mt-1.5 h-2 bg-ink-2">
        <div className="absolute inset-y-0 left-0" style={{ width: pct(sets), background: warn ? "var(--blood-ink)" : "var(--bone)" }} />
        <div className="absolute -inset-y-1 w-px bg-bone-2" style={{ left: pct(mev) }} />
        <div className="absolute -inset-y-1 w-px bg-blood-ink" style={{ left: pct(mrv) }} />
      </div>
    </div>
  );
}
