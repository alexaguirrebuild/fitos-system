// Muse (cliente de conectores de Meta) pierde la barra y abre /oauthorize: se redirige a /oauth/authorize con la misma consulta.
export function GET(request: Request) {
  const url = new URL(request.url);
  return Response.redirect(new URL(`/oauth/authorize${url.search}`, url.origin), 307);
}
