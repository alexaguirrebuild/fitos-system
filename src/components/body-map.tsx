/**
 * Mapa muscular de frente y de espalda, en SVG propio. Cada grupo se colorea por sus series semanales frente a
 * su MEV y su MRV: azul por debajo del mínimo, amarillo dentro del rango (más intenso cuanto más cerca del máximo),
 * rojo por encima del máximo. Sin estado: se pinta en el servidor.
 */
import { num } from "@/lib/format";

export type MuscleLoad = { muscleId: string; name: string; setsPerWeek: number; mev: number; mrv: number };

type Shape = { id: string; el: "e"; cx: number; cy: number; rx: number; ry: number; rot?: number } | { id: string; el: "p"; d: string } | { id: string; el: "r"; x: number; y: number; w: number; h: number };

/* Formas del lado izquierdo de la figura (x < 50). Las marcadas `mid` van una sola vez, en el centro. */
const FRONT: Shape[] = [
  { id: "deltoides_anterior", el: "e", cx: 31, cy: 36, rx: 5.5, ry: 6.5 },
  { id: "deltoides_lateral", el: "e", cx: 25, cy: 39, rx: 3.6, ry: 7, rot: 12 },
  { id: "pectoral", el: "p", d: "M49 32 C41 30 34 33 33 41 C34 49 42 53 49 51 Z" },
  { id: "biceps", el: "e", cx: 24, cy: 56, rx: 4.4, ry: 10.5, rot: 8 },
  { id: "antebrazo", el: "e", cx: 20.5, cy: 82, rx: 3.9, ry: 12.5, rot: 9 },
  { id: "abductores", el: "e", cx: 34.5, cy: 112, rx: 3.4, ry: 8 },
  { id: "cuadriceps", el: "e", cx: 41, cy: 134, rx: 6.8, ry: 20 },
  { id: "aductores", el: "e", cx: 47.2, cy: 123, rx: 2.6, ry: 12 },
];
const FRONT_MID: Shape[] = [{ id: "core", el: "r", x: 42, y: 55, w: 16, h: 37 }];

const BACK: Shape[] = [
  { id: "deltoides_posterior", el: "e", cx: 30.5, cy: 37, rx: 5.5, ry: 5.8 },
  { id: "deltoides_lateral", el: "e", cx: 25, cy: 39, rx: 3.6, ry: 7, rot: 12 },
  { id: "espalda", el: "p", d: "M48 47 C40 44 34 46 33 52 C34 66 40 77 48 83 Z" },
  { id: "erectores", el: "r", x: 45.2, y: 62, w: 4.2, h: 31 },
  { id: "triceps", el: "e", cx: 24, cy: 56, rx: 4.4, ry: 10.5, rot: 8 },
  { id: "antebrazo", el: "e", cx: 20.5, cy: 82, rx: 3.9, ry: 12.5, rot: 9 },
  { id: "abductores", el: "e", cx: 34, cy: 106, rx: 3, ry: 6.5 },
  { id: "gluteos", el: "e", cx: 42, cy: 113, rx: 8.3, ry: 9 },
  { id: "isquios", el: "e", cx: 41, cy: 141, rx: 6.4, ry: 17 },
  { id: "gemelos", el: "e", cx: 42, cy: 173, rx: 5, ry: 12 },
];
const BACK_MID: Shape[] = [{ id: "trapecio", el: "p", d: "M50 24 L37 34 L50 52 L63 34 Z" }];

export function fillFor(m: MuscleLoad | undefined): string {
  if (!m || m.setsPerWeek <= 0) return "var(--raise)";
  if (m.setsPerWeek > m.mrv) return "var(--hot)";
  if (m.setsPerWeek < m.mev) {
    const k = Math.round(35 + 45 * (m.setsPerWeek / Math.max(1, m.mev)));
    return `color-mix(in oklab, var(--cool) ${k}%, var(--raise))`;
  }
  const k = Math.round(60 + 40 * ((m.setsPerWeek - m.mev) / Math.max(1, m.mrv - m.mev)));
  return `color-mix(in oklab, var(--accent) ${k}%, var(--raise))`;
}

function draw(s: Shape, fill: string, title: string, key: string) {
  const common = { fill, stroke: "var(--bg)", strokeWidth: 0.8 };
  const t = <title>{title}</title>;
  if (s.el === "e") return <ellipse key={key} cx={s.cx} cy={s.cy} rx={s.rx} ry={s.ry} transform={s.rot ? `rotate(${s.rot} ${s.cx} ${s.cy})` : undefined} {...common}>{t}</ellipse>;
  if (s.el === "r") return <rect key={key} x={s.x} y={s.y} width={s.w} height={s.h} rx={Math.min(s.w, s.h) / 2.4} {...common}>{t}</rect>;
  return <path key={key} d={s.d} {...common}>{t}</path>;
}

/** Silueta neutra común a las dos vistas. */
function Silhouette() {
  const c = "var(--field)";
  return (
    <g>
      <circle cx="50" cy="13" r="8.5" fill={c} />
      <rect x="45" y="20" width="10" height="9" rx="3" fill={c} />
      <path d="M30 30 C38 27 62 27 70 30 C74 40 69 70 65 95 L67 112 C60 118 40 118 33 112 L35 95 C31 70 26 40 30 30 Z" fill={c} />
      <g stroke={c} strokeLinecap="round" fill="none">
        <path d="M27 35 L22 68 L18 99" strokeWidth="10" />
        <path d="M73 35 L78 68 L82 99" strokeWidth="10" />
        <path d="M41 112 L41 156 L43 200" strokeWidth="15" />
        <path d="M59 112 L59 156 L57 200" strokeWidth="15" />
      </g>
    </g>
  );
}

function Figure({ label, side, mid, by }: { label: string; side: Shape[]; mid: Shape[]; by: Map<string, MuscleLoad> }) {
  const title = (id: string) => {
    const m = by.get(id);
    return m ? `${m.name}: ${num(m.setsPerWeek)} series/sem (MEV ${num(m.mev)}, MRV ${num(m.mrv)})` : id;
  };
  return (
    <figure className="m-0 flex flex-col items-center">
      <svg viewBox="0 0 100 210" className="block h-auto w-full max-w-[11rem]" role="img" aria-label={`Vista de ${label.toLowerCase()}`}>
        <Silhouette />
        {side.map((s) => draw(s, fillFor(by.get(s.id)), title(s.id), `l-${s.id}`))}
        <g transform="translate(100 0) scale(-1 1)">{side.map((s) => draw(s, fillFor(by.get(s.id)), title(s.id), `r-${s.id}`))}</g>
        {mid.map((s) => draw(s, fillFor(by.get(s.id)), title(s.id), `m-${s.id}`))}
      </svg>
      <figcaption className="small muted mt-1">{label}</figcaption>
    </figure>
  );
}

export function BodyMap({ muscles }: { muscles: MuscleLoad[] }) {
  const by = new Map(muscles.map((m) => [m.muscleId, m]));
  const under = muscles.filter((m) => m.setsPerWeek > 0 && m.setsPerWeek < m.mev).length;
  const over = muscles.filter((m) => m.setsPerWeek > m.mrv).length;
  const inRange = muscles.filter((m) => m.setsPerWeek >= m.mev && m.setsPerWeek <= m.mrv && m.setsPerWeek > 0).length;
  return (
    <div>
      <div className="grid grid-cols-2 gap-4" aria-label={`Mapa muscular: ${inRange} grupos en rango, ${under} por debajo del mínimo, ${over} por encima del máximo.`}>
        <Figure label="Frente" side={FRONT} mid={FRONT_MID} by={by} />
        <Figure label="Espalda" side={BACK} mid={BACK_MID} by={by} />
      </div>
      <ul className="micro muted mt-4 flex flex-wrap justify-center gap-x-4 gap-y-2">
        {[
          ["var(--raise)", "sin series"],
          ["color-mix(in oklab, var(--cool) 70%, var(--raise))", "bajo el mínimo"],
          ["var(--accent)", "en rango"],
          ["var(--hot)", "sobre el máximo"],
        ].map(([c, l]) => (
          <li key={l} className="inline-flex items-center gap-1.5">
            <span className="inline-block h-3 w-3 rounded-full" style={{ background: c }} aria-hidden="true" />
            {l}
          </li>
        ))}
      </ul>
    </div>
  );
}
