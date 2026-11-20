"use client";

import { useActionState } from "react";
import { loginAction, type LoginState } from "./actions";

const START: LoginState = { error: null, email: "" };

export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState(loginAction, START);
  return (
    <form action={action} className="mt-8 flex flex-col gap-4" noValidate>
      <input type="hidden" name="next" value={next} />
      <div className="field">
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" className="input" autoComplete="username" inputMode="email" autoCapitalize="none" spellCheck={false} defaultValue={state.email} required />
      </div>
      <div className="field">
        <label htmlFor="password">Contraseña</label>
        <input id="password" name="password" type="password" className="input" autoComplete="current-password" required aria-describedby={state.error ? "login-error" : undefined} />
      </div>
      {state.error ? (
        <p id="login-error" role="alert" className="err">
          {state.error}
        </p>
      ) : null}
      <button type="submit" className="btn btn-primary btn-lg btn-block mt-2" disabled={pending}>
        {pending ? "Entrando…" : "Entrar"}
      </button>
    </form>
  );
}
