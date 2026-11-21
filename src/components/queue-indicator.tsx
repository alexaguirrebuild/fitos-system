"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { queueFlush, queueList } from "@/lib/offline-queue";
import { useQueue } from "@/lib/use-queue";
import { replayQueued } from "@/app/(app)/queue-actions";

/** Indicador discreto «2 sin enviar» y reenvío automático al volver la conexión. */
export function QueueIndicator() {
  const items = useQueue();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const flush = useCallback(async () => {
    if (queueList().length === 0) return;
    setBusy(true);
    const r = await queueFlush((item) => replayQueued(item.kind, item.payload));
    setBusy(false);
    if (r.sent > 0) router.refresh();
    setNote(r.rejected > 0 ? `${r.rejected} no se ${r.rejected === 1 ? "pudo" : "pudieron"} guardar: revisa el registro.` : null);
  }, [router]);

  useEffect(() => {
    const run = () => void flush();
    const onVisible = () => {
      if (document.visibilityState === "visible") run();
    };
    window.addEventListener("online", run);
    document.addEventListener("visibilitychange", onVisible);
    const first = window.setTimeout(run, 800);
    return () => {
      window.removeEventListener("online", run);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearTimeout(first);
    };
  }, [flush]);

  if (items.length === 0 && !note) return null;
  return (
    <div className="fixed inset-x-0 top-0 z-40 flex justify-center" style={{ paddingTop: "calc(var(--safe-t) + 6px)" }} role="status" aria-live="polite">
      <button
        type="button"
        onClick={() => (items.length ? void flush() : setNote(null))}
        className="fig micro min-h-9 border border-accent-ink bg-surface px-3 text-fg"
        style={{ borderRadius: "var(--radius)" }}
      >
        {items.length ? `${items.length} sin enviar${busy ? " · enviando" : " · tocar para reintentar"}` : note}
      </button>
    </div>
  );
}
