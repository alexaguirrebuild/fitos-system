import type { Metadata } from "next";
import { PageHeader, Row } from "@/components/ui";
import { sessionOrLogin } from "@/app/_server/session";

export const metadata: Metadata = { title: "Más" };

export default async function MasPage() {
  await sessionOrLogin("/mas");
  return (
    <main className="page">
      <PageHeader title="Más" />
      <nav aria-label="Más secciones" className="rows">
        <Row href="/bienestar" k={<span className="text-bone">Bienestar</span>} v={<span className="small muted">Check-in, agujetas, POMS</span>} />
        <Row href="/cardio" k={<span className="text-bone">Cardio</span>} v={<span className="small muted">Zonas, Z2, pasos, reloj</span>} />
        <Row href="/libreria" k={<span className="text-bone">Librería</span>} v={<span className="small muted">Ejercicios y glosario</span>} />
        <Row href="/ajustes" k={<span className="text-bone">Ajustes</span>} v={<span className="small muted">Ficha, programa, agentes</span>} />
      </nav>
    </main>
  );
}
