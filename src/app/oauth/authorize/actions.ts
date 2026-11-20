"use server";

// La decisión del dueño en la pantalla de consentimiento. Del navegador solo llega la petición
// firmada (`consent`); completeAuthorization() comprueba la firma, que sea de esta sesión y que no
// haya caducado, vuelve a validar la petición entera contra la base y solo entonces crea el código.
// Next comprueba el Origin de una acción de servidor: otra web no puede enviarla.
import { redirect } from "next/navigation";
import { completeAuthorization } from "@/server/oauth";

/** Import dinámico a propósito: así nada de OAuth arrastra la sesión de Next al cargarse (tests incluidos). */
async function sessionUserId(): Promise<string | null> {
  const { getSessionUserId } = await import("@/server/auth");
  return getSessionUserId();
}

async function decide(formData: FormData, approve: boolean): Promise<never> {
  const consent = formData.get("consent");
  const userId = await sessionUserId();
  if (!userId || typeof consent !== "string") redirect("/oauth/authorize?aviso=caducado");
  const result = await completeAuthorization({ userId, consent, approve });
  // Con éxito, vuelta al agente (redirect_uri ya validado) con `code` o con `error=access_denied`.
  redirect(result.ok ? result.redirectTo : `/oauth/authorize?aviso=${result.reason}`);
}

export async function approveAuthorization(formData: FormData): Promise<void> {
  await decide(formData, true);
}

export async function denyAuthorization(formData: FormData): Promise<void> {
  await decide(formData, false);
}
