"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const POSES = [
  { v: "frontal", l: "Frontal" },
  { v: "lateral", l: "Lateral" },
  { v: "trasera", l: "Trasera" },
] as const;

/** Fotos de progreso: una por pose, a /api/media/upload. Dice claro si Drive no está configurado. */
export function PhotoUpload() {
  const router = useRouter();
  const [state, setState] = useState<Record<string, { text: string; bad: boolean }>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const upload = async (pose: string, file: File) => {
    setBusy(pose);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("meta", JSON.stringify({ pose }));
      const res = await fetch("/api/media/upload", { method: "POST", body: form });
      const body = (await res.json().catch(() => null)) as { status?: string; message?: string; missing?: string[] } | null;
      const text = !res.ok
        ? body?.message ?? "No se pudo subir."
        : body?.status === "subido"
          ? "Subida a Drive."
          : body?.status === "pendiente"
            ? `Pendiente: Drive sin configurar${body.missing?.length ? ` (${body.missing.join(", ")})` : ""}. La foto no se ha guardado.`
            : body?.message ?? "Drive no aceptó la foto.";
      setState((s) => ({ ...s, [pose]: { text, bad: !res.ok || body?.status === "error" } }));
      if (res.ok) router.refresh();
    } catch {
      setState((s) => ({ ...s, [pose]: { text: "Sin conexión: la foto no se ha subido.", bad: true } }));
    }
    setBusy(null);
  };

  return (
    <div>
      <div className="grid grid-cols-3 gap-2">
        {POSES.map((p) => (
          <div key={p.v}>
            <label htmlFor={`photo-${p.v}`} className="btn btn-block px-1" aria-disabled={busy != null}>
              {busy === p.v ? "Subiendo…" : p.l}
            </label>
            <input
              id={`photo-${p.v}`}
              type="file"
              accept="image/*"
              capture="environment"
              className="sr-only"
              disabled={busy != null}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void upload(p.v, f);
              }}
            />
          </div>
        ))}
      </div>
      {POSES.filter((p) => state[p.v]).map((p) => (
        <p key={p.v} className={`small mt-2 ${state[p.v].bad ? "err" : "muted"}`} role="status">
          {p.l}: {state[p.v].text}
        </p>
      ))}
    </div>
  );
}
