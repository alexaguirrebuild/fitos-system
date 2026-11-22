/**
 * Elegir la cámara trasera principal (la 1x) para leer códigos de barras.
 * Con `facingMode: "environment"`, Chrome en Android a veces abre la gran angular (0,5x),
 * que no enfoca de cerca y no lee el código. Las etiquetas solo existen tras dar permiso.
 */

export type Cam = { deviceId: string; label: string };

const BACK = /back|rear|environment|trasera|posterior/i;
/** Lentes que no son la principal: gran angular, tele y las virtuales que cambian de lente solas. */
const NOT_MAIN = /ultra|tele|dual|triple|0[.,]5/i;

export function backCameras(devices: readonly Pick<MediaDeviceInfo, "kind" | "deviceId" | "label">[]): Cam[] {
  return devices.filter((d) => d.kind === "videoinput" && d.deviceId && BACK.test(d.label)).map(({ deviceId, label }) => ({ deviceId, label }));
}

/** La principal: en Android, la de menor índice «camera2 N»; si no hay índice, la primera sin nombre de lente secundaria. */
export function pickMainBackCamera(backs: readonly Cam[]): Cam | null {
  if (backs.length === 0) return null;
  const plain = backs.filter((c) => !NOT_MAIN.test(c.label));
  const pool = plain.length ? plain : backs;
  const index = (c: Cam) => Number(/camera2 (\d+)/i.exec(c.label)?.[1] ?? Number.POSITIVE_INFINITY);
  return [...pool].sort((a, b) => index(a) - index(b))[0];
}
