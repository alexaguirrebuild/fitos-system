"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { dismissAnnotationAction } from "@/app/(app)/actions";

export function DismissButton({ id, title }: { id: string; title: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [failed, setFailed] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-quiet -mr-2 flex-none"
      disabled={pending}
      aria-label={`Descartar: ${title}`}
      onClick={() =>
        start(async () => {
          try {
            const r = await dismissAnnotationAction(id);
            if (r.ok) router.refresh();
            else setFailed(true);
          } catch {
            setFailed(true);
          }
        })
      }
    >
      {failed ? "Sin red" : pending ? "…" : "Descartar"}
    </button>
  );
}
