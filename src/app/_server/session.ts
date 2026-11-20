/** Sesión en Server Components. Solo servidor. */
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { getSessionUserId } from "@/server/auth";

/** Atleta de la petición, o redirección a /login con vuelta a `next`. Marca la ruta como dinámica. */
export async function sessionOrLogin(next: string): Promise<string> {
  await connection();
  const userId = await getSessionUserId();
  if (!userId) redirect(`/login?next=${encodeURIComponent(next)}`);
  return userId;
}

/** `next` solo como ruta interna: empieza por «/» y no por «//» ni por «/\». */
export function safeNext(raw: unknown): string {
  const s = typeof raw === "string" ? raw : "";
  if (!s.startsWith("/") || s.startsWith("//") || s.startsWith("/\\") || /[\r\n\t]/.test(s)) return "/";
  return s;
}
