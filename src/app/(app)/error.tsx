"use client";

export default function AppError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <main className="page">
      <h1 className="h-page">No se pudo cargar</h1>
      <p className="muted mt-3">
        La pantalla ha fallado al leer tus datos. Lo ya registrado está guardado. Si estás sin cobertura, vuelve a probar cuando haya red.
      </p>
      {error.digest ? <p className="fig micro faint mt-3">Referencia: {error.digest}</p> : null}
      <button type="button" className="btn btn-block mt-8" onClick={() => retry()}>
        Reintentar
      </button>
    </main>
  );
}
