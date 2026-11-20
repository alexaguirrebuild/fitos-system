/* Service worker mínimo de Sistema Físico.
 * - Precachea la pantalla sin conexión y los iconos.
 * - Sirve de caché solo estáticos con huella (/_next/static, /icons): nunca cambian de contenido.
 * - Las páginas van siempre a la red (llevan datos del atleta y NO se guardan). Sin red: pantalla /offline.
 * - /api, /oauth, /.well-known y todo lo que no sea GET no se toca.
 */
const VERSION = "sf-v1";
const SHELL = ["/offline", "/icons/icon-192.png", "/icons/icon-512.png"];
const NEVER = [/^\/api\//, /^\/oauth/, /^\/oauthtoken/, /^\/\.well-known\//, /^\/login/];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (NEVER.some((re) => re.test(url.pathname))) return;

  const isStatic = url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/");
  if (isStatic) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      })),
    );
    return;
  }

  // Documentos: red siempre; sin red, la pantalla sin conexión (que no lleva datos).
  if (req.mode === "navigate") {
    event.respondWith(fetch(req).catch(() => caches.match("/offline").then((r) => r || new Response("Sin conexión", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } }))));
  }
  // El resto (RSC, datos) pasa de largo: no se cachea nada con datos.
});
