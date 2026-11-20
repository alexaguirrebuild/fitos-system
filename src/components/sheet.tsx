"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { IconClose } from "./icons";

/** Hoja inferior modal: foco dentro al abrir, Escape y fondo cierran, y devuelve el foco al cerrar. */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
      prev?.focus?.();
    };
  }, [onClose]);
  return (
    <>
      <div className="sheet-back" onClick={onClose} aria-hidden="true" />
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1} ref={ref}>
        <div className="sheet-in">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 id={id} className="h-sec">
              {title}
            </h2>
            <button type="button" className="btn btn-quiet -mr-2" onClick={onClose} aria-label="Cerrar">
              <IconClose />
            </button>
          </div>
          {children}
        </div>
      </div>
    </>
  );
}
