"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, login, sessionCookieOptions } from "@/server/auth";
import { AppError } from "@/server/errors";
import { safeNext } from "@/app/_server/session";

export type LoginState = { error: string | null; email: string };

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = safeNext(formData.get("next"));
  if (!email || !password) return { error: "Escribe el email y la contraseña.", email };

  const h = await headers();
  const ip = (h.get("x-forwarded-for") ?? "").split(",")[0].trim() || h.get("x-real-ip") || "desconocida";
  try {
    const { token } = await login(email, password, ip);
    (await cookies()).set(SESSION_COOKIE, token, sessionCookieOptions());
  } catch (e) {
    if (e instanceof AppError) return { error: e.message, email };
    console.error("[login]", e instanceof Error ? e.message : "error desconocido");
    return { error: "No se pudo iniciar sesión. Prueba otra vez.", email };
  }
  redirect(next);
}

export async function logoutAction(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}
