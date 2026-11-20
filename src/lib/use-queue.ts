"use client";

import { useSyncExternalStore } from "react";
import { queueList, queueSubscribe, type QueuedItem } from "./offline-queue";

const EMPTY: QueuedItem[] = [];
let cache: { key: string; items: QueuedItem[] } = { key: "", items: EMPTY };

function snapshot(): QueuedItem[] {
  const items = queueList();
  const key = items.map((i) => i.id).join(",");
  if (key !== cache.key) cache = { key, items };
  return cache.items;
}

/** Elementos pendientes de enviar, reactivo a cambios de la cola (también desde otras pestañas). */
export function useQueue(): QueuedItem[] {
  return useSyncExternalStore(queueSubscribe, snapshot, () => EMPTY);
}
