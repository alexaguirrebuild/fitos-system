"use client";

/**
 * Cola sin conexión para series y comidas.
 * Lo que no llega al servidor por un fallo de red se guarda en localStorage y se reintenta al volver la conexión.
 * Límites conocidos (el backend no admite id de cliente ni hora de la serie):
 *  - la hora guardada es la del reenvío, no la del momento en que se hizo la serie;
 *  - si la petición llegó pero la respuesta se perdió, el reenvío puede duplicar (el servidor solo descarta
 *    la serie idéntica en menos de 20 s). Cada elemento lleva un id de cliente para no reenviarse dos veces desde aquí.
 */

export type QueueKind = "set" | "food";
export type QueuedItem = { id: string; kind: QueueKind; payload: unknown; label: string; at: number; tries: number };

const KEY = "sf.queue.v1";
const EVENT = "sf:queue";

function read(): QueuedItem[] {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(v) ? (v as QueuedItem[]) : [];
  } catch {
    return [];
  }
}

function write(items: QueuedItem[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    /* almacenamiento lleno o bloqueado: no hay cola */
  }
  window.dispatchEvent(new Event(EVENT));
}

export const queueList = (): QueuedItem[] => (typeof window === "undefined" ? [] : read());

export function queueAdd(kind: QueueKind, payload: unknown, label: string): QueuedItem {
  const item: QueuedItem = { id: crypto.randomUUID(), kind, payload, label, at: Date.now(), tries: 0 };
  write([...read(), item]);
  return item;
}

export function queueRemove(id: string) {
  write(read().filter((i) => i.id !== id));
}

export function queueSubscribe(fn: () => void): () => void {
  window.addEventListener(EVENT, fn);
  window.addEventListener("storage", fn);
  return () => {
    window.removeEventListener(EVENT, fn);
    window.removeEventListener("storage", fn);
  };
}

/** Un fallo de red al llamar a una Server Action llega como TypeError de fetch (o estando sin conexión). */
export function isNetworkError(e: unknown): boolean {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  if (e instanceof TypeError) return true;
  const m = e instanceof Error ? e.message : "";
  return /failed to fetch|networkerror|load failed|network request failed|fetch failed/i.test(m);
}

type Sender = (item: QueuedItem) => Promise<{ ok: boolean }>;
let flushing = false;

/**
 * Reenvía la cola en orden. Para en el primer fallo de red. Un rechazo del servidor (dato no válido) saca el
 * elemento de la cola: reintentarlo no lo va a arreglar. Devuelve cuántos se enviaron.
 */
export async function queueFlush(send: Sender): Promise<{ sent: number; rejected: number }> {
  if (flushing || typeof window === "undefined") return { sent: 0, rejected: 0 };
  flushing = true;
  let sent = 0;
  let rejected = 0;
  try {
    for (const item of read()) {
      try {
        const r = await send(item);
        queueRemove(item.id);
        if (r.ok) sent += 1;
        else rejected += 1;
      } catch (e) {
        if (isNetworkError(e)) break;
        queueRemove(item.id);
        rejected += 1;
      }
    }
  } finally {
    flushing = false;
  }
  return { sent, rejected };
}
