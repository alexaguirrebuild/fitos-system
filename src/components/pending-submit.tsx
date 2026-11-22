"use client";

import { useFormStatus } from "react-dom";
import type { ReactNode } from "react";

/**
 * Botón de envío para un `<form action>` de servidor que no devuelve nada (redirige). Mientras la acción
 * corre se bloquea y cambia el texto: sin esto, un toque que tarda se repetía (12 POST en 14 s el 22-nov).
 */
export function PendingSubmit({ children, pendingText, className }: { children: ReactNode; pendingText: string; className?: string }) {
  const { pending } = useFormStatus();
  return (
    <>
      <button type="submit" className={className} disabled={pending}>
        {pending ? pendingText : children}
      </button>
      {/* El cambio de texto de un botón no lo anuncia el lector de pantalla; esta región, sí. */}
      <span role="status" className="sr-only">{pending ? pendingText : ""}</span>
    </>
  );
}
