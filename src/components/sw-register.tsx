"use client";

import { useEffect } from "react";

/** Registra el service worker. En desarrollo no se registra para no servir estáticos viejos. */
export function ServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      /* sin service worker la app funciona igual, solo sin pantalla offline */
    });
  }, []);
  return null;
}
