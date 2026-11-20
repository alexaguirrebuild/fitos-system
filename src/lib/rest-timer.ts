"use client";

/** Fin del descanso en curso (ms desde epoch). Vive fuera de React para sobrevivir a recargas y cambios de pantalla. */
const KEY = "sf.rest.end";
let end: number | null | undefined;
const listeners = new Set<() => void>();

function load(): number | null {
  if (end === undefined) {
    try {
      const v = Number(sessionStorage.getItem(KEY));
      end = Number.isFinite(v) && v > Date.now() ? v : null;
    } catch {
      end = null;
    }
  }
  return end;
}

function set(v: number | null) {
  end = v;
  try {
    if (v == null) sessionStorage.removeItem(KEY);
    else sessionStorage.setItem(KEY, String(v));
  } catch {
    /* sin sessionStorage el temporizador sigue funcionando en memoria */
  }
  listeners.forEach((fn) => fn());
}

export const restTimer = {
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  get: () => load(),
  server: () => null,
  start: (seconds: number) => set(Date.now() + Math.max(1, seconds) * 1000),
  add: (seconds: number) => set(Math.max(Date.now(), load() ?? Date.now()) + seconds * 1000),
  clear: () => set(null),
};
