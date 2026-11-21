import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { getSessionUserId } from "@/server/auth";
import { safeNext } from "@/app/_server/session";
import { LoginForm } from "./form";

export const metadata: Metadata = { title: "Entrar" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  await connection();
  const sp = await searchParams;
  const next = safeNext(sp.next);
  // Con sesión (o en modo dev) no hay nada que pedir.
  if (await getSessionUserId()) redirect(next);

  return (
    <main className="page-bare" style={{ minHeight: "100dvh", display: "grid", alignContent: "center" }}>
      <h1 className="display text-[2.75rem]">FITOS SYSTEM</h1>
      <p className="muted mt-3">Entra con tu cuenta para ver tu entreno y registrar.</p>
      <LoginForm next={next} />
    </main>
  );
}
