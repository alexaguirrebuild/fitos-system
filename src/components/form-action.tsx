"use client";

import { useActionState, type ReactNode } from "react";

export type FormState = { ok: boolean; message: string } | null;
export type FormActionFn = (prev: FormState, formData: FormData) => Promise<FormState>;

/** Formulario con Server Action y mensaje de resultado. Los campos van como hijos; el botón lo pone este componente. */
export function FormAction({ action, children, submit, className, primary, quiet }: { action: FormActionFn; children?: ReactNode; submit: string; className?: string; primary?: boolean; quiet?: boolean }) {
  const [state, run, pending] = useActionState(action, null);
  return (
    <form action={run} className={className}>
      {children}
      <button type="submit" className={`btn ${primary ? "btn-primary" : ""} ${quiet ? "btn-quiet" : "btn-block"} ${children ? "mt-3" : ""}`} disabled={pending}>
        {pending ? "Guardando…" : submit}
      </button>
      {state ? (
        <p className={`small mt-2 whitespace-pre-line ${state.ok ? "muted" : "err"}`} role={state.ok ? "status" : "alert"}>
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
