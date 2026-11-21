/** Piezas de interfaz sin estado. Valen en Server y en Client Components. */
import Link from "next/link";
import type { ReactNode } from "react";
import { IconBack, IconChevron } from "./icons";

export function PageHeader({ title, sub, back, action }: { title: string; sub?: ReactNode; back?: { href: string; label: string }; action?: ReactNode }) {
  return (
    <header className="mb-6">
      {back ? (
        <Link href={back.href} className="-ml-2 mb-1 inline-flex min-h-12 items-center gap-1 pr-3 text-fg-2">
          <IconBack width={20} height={20} />
          <span className="small">{back.label}</span>
        </Link>
      ) : null}
      <div className="flex items-end justify-between gap-4">
        <h1 className="h-page">{title}</h1>
        {action}
      </div>
      {sub ? <p className="muted mt-2">{sub}</p> : null}
    </header>
  );
}

export function Section({ title, aside, children, id }: { title: string; aside?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section className="sec" id={id} aria-labelledby={id ? `${id}-t` : undefined}>
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <h2 className="h-sec" id={id ? `${id}-t` : undefined}>
          {title}
        </h2>
        {aside ? <div className="small muted text-right">{aside}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** Fila etiqueta → valor. `note` va debajo del valor, en pequeño (fecha, origen, «estimado»). */
export function Row({ k, v, note, href, warn }: { k: ReactNode; v: ReactNode; note?: ReactNode; href?: string; warn?: boolean }) {
  const body = (
    <>
      <span className="row-k">{k}</span>
      <span className="row-v">
        <span className={warn ? "accent" : undefined}>{v}</span>
        {note ? <span className="micro faint block">{note}</span> : null}
      </span>
      {href ? <IconChevron className="flex-none text-fg-3" /> : null}
    </>
  );
  return href ? (
    <Link className="row" href={href}>
      {body}
    </Link>
  ) : (
    <div className="row">{body}</div>
  );
}

/** Estado vacío honesto: qué falta y qué hay que registrar para que aparezca. */
export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="border-y border-line py-5">
      <p className="font-medium">{title}</p>
      {children ? <p className="muted small mt-1">{children}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function Notice({ title, children, warn }: { title?: string; children: ReactNode; warn?: boolean }) {
  return (
    <div className={`notice ${warn ? "notice-warn" : ""}`} role={warn ? "alert" : "status"}>
      {title ? <p className="notice-t font-medium">{title}</p> : null}
      <div className={title ? "muted mt-1" : undefined}>{children}</div>
    </div>
  );
}

/** Barra de avance con su cifra: lo hecho contra el objetivo. */
export function Meter({ value, max, accent, label }: { value: number; max: number; accent?: boolean; label: string }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className={`meter ${accent ? "meter-accent" : ""}`} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={Math.round(max)} aria-valuenow={Math.round(Math.min(value, max))}>
      <i style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Skeleton({ lines = 4 }: { lines?: number }) {
  return (
    <div className="page" aria-busy="true" aria-label="Cargando">
      <div className="skel h-9 w-40" />
      <div className="skel mt-6 h-16 w-full" />
      <div className="mt-8 space-y-3">
        {Array.from({ length: lines }, (_, k) => (
          <div key={k} className="skel h-12 w-full" />
        ))}
      </div>
    </div>
  );
}
