import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { BottomNav } from "@/components/bottom-nav";
import { QueueIndicator } from "@/components/queue-indicator";
import { getSessionUserId } from "@/server/auth";
import { getOnboardingStatus, type OnboardingField } from "@/server/services/athlete";

/** Sin esto no hay cálculos ni sesión de hoy: se manda a completar la ficha. */
const ESSENTIAL: OnboardingField[] = ["heightCm", "birthDate", "weightKg", "program"];

export default async function AppLayout({ children }: { children: ReactNode }) {
  await connection();
  const userId = await getSessionUserId();
  // Sin sesión, cada página redirige a /login con su propia ruta en `next`.
  if (!userId) return <>{children}</>;

  const status = await getOnboardingStatus(userId);
  if (status.missing.some((m) => ESSENTIAL.includes(m.field))) redirect("/onboarding");

  return (
    <>
      <QueueIndicator />
      {children}
      <BottomNav />
    </>
  );
}
