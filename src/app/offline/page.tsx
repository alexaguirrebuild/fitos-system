import type { Metadata } from "next";

export const metadata: Metadata = { title: "Sin conexión" };

export default function OfflinePage() {
  return (
    <main className="page-bare" style={{ minHeight: "100dvh", display: "grid", alignContent: "center" }}>
      <h1 className="h-page">Sin conexión</h1>
      <p className="muted mt-3">
        Esta pantalla necesita red. Las series y comidas que apuntes sin cobertura se guardan en el móvil y se envían solas al volver.
      </p>
      {/* Enlace normal a propósito: recarga la página entera cuando vuelva la red. */}
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <a className="btn btn-block mt-8" href="/">
        Reintentar
      </a>
    </main>
  );
}
