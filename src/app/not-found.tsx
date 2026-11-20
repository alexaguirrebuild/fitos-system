import Link from "next/link";

export default function NotFound() {
  return (
    <main className="page-bare" style={{ minHeight: "100dvh", display: "grid", alignContent: "center" }}>
      <h1 className="h-page">No existe</h1>
      <p className="muted mt-3">Esa página no está o no es tuya.</p>
      <Link className="btn btn-block mt-8" href="/">
        Ir a Hoy
      </Link>
    </main>
  );
}
