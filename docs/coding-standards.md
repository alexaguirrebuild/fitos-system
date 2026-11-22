# Estándar de revisión

Lo usa el revisor: una sesión distinta de la que escribió el cambio, con el contexto limpio. Parte de `CEREBRO/research/ingenieria/agentes-y-verificacion.md` (destilado del cuaderno de NotebookLM «Ingeniería de Agentes de IA» y de claude.dev, leído el 21-nov-2026), adaptado a FITOS.

## Cuándo es obligatoria

| Cambio | Revisión |
|---|---|
| `src/engine/`, migraciones, RLS, `withUser`/`asSystem`, auth y OAuth, herramientas MCP, webhooks, CI, `.claude/` | **Obligatoria** |
| Servicios y pantallas con lógica | Recomendada |
| Textos, estilos, docs | Opcional |

## Cómo se revisa

- Solo el diff, contra `main`. Las reglas se leen de `main`: un cambio no puede tocar lo que lo juzga.
- Máximo 3 rondas. A la tercera, Alex decide.
- El revisor no arregla: devuelve hallazgos. Quien escribió, corrige.

## Qué se mira

1. **Correcto.** Hace lo que dice el ticket y no rompe otro flujo. Casos límite: sin datos, primer día, cambio de día a medianoche (zona horaria del atleta), sesión abierta de otro día.
2. **Invariantes de `AGENTS.md`.** Cálculos en `src/engine/` con su test y su grado; datos por `withUser`; migración nueva, nunca editada; zod en toda entrada; nada personal en git.
3. **Tests.** Cada regla nueva del motor, con su test. Cada bug arreglado deja un test que lo reproduce. Ningún test debilitado, saltado (`.skip`) o con `sleep` sin OK de Alex.
4. **Datos.** La migración se puede aplicar dos veces sin romper (o va en transacción). Las escrituras son idempotentes cuando las reintenta un cliente (cola sin conexión, Muse, HC Webhook).
5. **Seguridad.** Nada de secretos en código ni en logs. Scopes MCP correctos. Una URL que llega de fuera no se descarga sin lista de hosts permitidos (SSRF). Ningún rechazo de OAuth filtra tokens.
6. **Rendimiento en rutas calientes** (Hoy, Entreno, `log_set`, MCP). Cada consulta a la base es una ida y vuelta: cuenta las que añade el cambio. Nada de calcular dos veces lo mismo, ni de N+1.
7. **UI.** Las acciones lentas dan aviso (botón en «cargando» y bloqueado). Funciona a 390 px y con el teclado.
8. **Comentarios.** Se permiten, y se piden, los que explican **por qué** (una decisión, un PMID, una rareza del cliente de Meta). Se rechazan los que **tapan un parche**: «hack», «temporal», «TODO» o `eslint-disable` sin motivo ni ticket. Se rechazan también los que repiten lo que dice el código.
9. **Verificación.** El PR trae la prueba: salida de los tests, captura o petición y respuesta. Si algo no se probó, lo dice.

## Formato del veredicto

```
VEREDICTO: APRUEBA | CAMBIOS | BLOQUEA
- [grave|medio|menor] fichero:línea — qué falla y en qué caso concreto
Probado por el revisor: <qué ejecutó>
```

`BLOQUEA` solo para un fallo de datos, de seguridad o de un invariante.
