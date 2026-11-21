// /oauth/authorize → pantalla de consentimiento del servidor OAuth 2.1.
//  · sin sesión → /login?next=<esta misma petición> y vuelta aquí;
//  · cliente o redirect_uri no válidos → error en esta página, NUNCA se redirige;
//  · cualquier otro error → vuelta al agente con `error`, `state` e `iss`;
//  · petición válida → quién pide acceso, a dónde vuelve y qué permisos, con Autorizar / Cancelar.
// Clickjacking: las cabeceras `X-Frame-Options: DENY` y `frame-ancestors 'none'` se ponen en next.config.ts.
import { Suspense } from "react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AUTHORIZE_KEYS, authorizeRedirect, SCOPES, signConsent, validateAuthorizeRequest, type AuthorizeParams } from "@/server/oauth";
import { approveAuthorization, denyAuthorization } from "./actions";

export const metadata: Metadata = {
  title: "Autorizar acceso",
  robots: { index: false, follow: false },
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const AVISOS: Record<string, string> = {
  caducado: "La pantalla de autorización caducó o tu sesión se cerró. Vuelve a la aplicación y empieza la conexión otra vez.",
  invalido: "La petición de autorización ya no es válida. Vuelve a la aplicación y empieza la conexión otra vez.",
};

/** Import dinámico a propósito: así nada de OAuth arrastra la sesión de Next al cargarse (tests incluidos). */
async function sessionUserId(): Promise<string | null> {
  const { getSessionUserId } = await import("@/server/auth");
  return getSessionUserId();
}

function Problem({ message }: { message: string }) {
  return (
    <section className="oauth-card oauth-error">
      <h1>No se puede conectar</h1>
      <p role="alert">{message}</p>
      <p className="oauth-note">No se ha concedido ningún acceso.</p>
    </section>
  );
}

async function Consent({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  if (typeof sp.aviso === "string" && AVISOS[sp.aviso]) return <Problem message={AVISOS[sp.aviso]} />;

  // Un parámetro repetido no es una petición OAuth válida: se queda fuera y la validación falla.
  const params: AuthorizeParams = {};
  for (const key of AUTHORIZE_KEYS) {
    const value = sp[key];
    if (typeof value === "string") params[key] = value;
  }

  const userId = await sessionUserId();
  if (!userId) {
    const back = `/oauth/authorize?${new URLSearchParams(params as Record<string, string>).toString()}`;
    redirect(`/login?next=${encodeURIComponent(back)}`);
  }

  const check = await validateAuthorizeRequest(params);
  if (!check.ok) {
    // Sin secretos: solo el motivo y los parámetros que suelen fallar con clientes nuevos.
    console.warn("[oauth/authorize] rechazo", JSON.stringify({ error: check.error, description: check.description, client: params.client_id, scope: params.scope, resource: params.resource, method: params.code_challenge_method }));
    if (check.redirectable && check.redirectUri) {
      redirect(authorizeRedirect(check.redirectUri, { error: check.error, error_description: check.description }, check.state ?? null));
    }
    return <Problem message={check.description} />;
  }

  console.info("[oauth/authorize] pantalla", JSON.stringify({ client: check.client.clientName, pedido: params.scope ?? null, concedible: check.scope }));
  const consent = signConsent({
    userId,
    clientId: check.client.clientId,
    redirectUri: check.redirectUri,
    scope: check.scope,
    state: check.state,
    codeChallenge: check.codeChallenge,
    resource: check.resource,
  });
  const returnHost = new URL(check.redirectUri).host;

  return (
    <section className="oauth-card" aria-labelledby="oauth-title">
      <h1 id="oauth-title">Autorizar acceso</h1>
      <p className="oauth-client">
        <strong>{check.client.clientName ?? "Una aplicación"}</strong> quiere conectarse a tu sistema de entrenamiento.
      </p>
      <p className="oauth-host">
        Al terminar volverás a <strong>{returnHost}</strong>
      </p>
      <p className="oauth-note">El nombre lo elige la propia aplicación. Fíate de la dirección: si no la reconoces, cancela.</p>

      <h2>Podrá</h2>
      <ul className="oauth-scopes">
        {check.scope.map((scope) => (
          <li key={scope}>
            <span>{SCOPES[scope]}</span> <code>{scope}</code>
          </li>
        ))}
      </ul>

      <form className="oauth-actions">
        <input type="hidden" name="consent" value={consent} />
        <button type="submit" className="btn" formAction={denyAuthorization}>
          Cancelar
        </button>
        <button type="submit" className="btn btn-primary" formAction={approveAuthorization}>
          Autorizar
        </button>
      </form>
    </section>
  );
}

export default function AuthorizePage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <main className="oauth-page">
      <Suspense fallback={<p className="oauth-loading">Comprobando la petición…</p>}>
        <Consent searchParams={searchParams} />
      </Suspense>
    </main>
  );
}
