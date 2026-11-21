# Diseño

Herramienta personal de Alex, sin marca THEOVERCODE. Se usa con una mano en el gimnasio a 390 px y, para planificar, en escritorio a 1280 px.

## Por qué la v1 parecía hecha con IA

Capturas de antes en `docs/capturas/*.png`; después, en `docs/capturas/v2/`.

- **Caía en el clúster editorial.** Didona (Bodoni) + negro cálido + un rojo + etiquetas en mono: es la estética que sale por defecto cuando se pide «serio y premium». Se adivinaba sin saber de qué iba la app.
- **Mono como disfraz.** IBM Plex Mono en todas las cifras para parecer técnico. Con tres familias, ninguna mandaba.
- **Jerarquía plana.** Hoy era una lista de seis filas iguales (readiness, tobillo, día On, pasos, peso, carga) con la misma letra, el mismo peso y el mismo filete. Nada pesaba más que nada.
- **Sin un solo dato protagonista.** La cifra que importa (la carga de la próxima serie, el peso de tendencia, la proteína que falta) iba al mismo tamaño que su nota.
- **Sin imagen.** Ni cuerpo, ni gráfica principal en Hoy, ni forma reconocible: solo texto y filetes.
- **Tobillo con protagonismo** que ya no tiene: fila fija en Hoy y avisos en cada ejercicio.
- **Densidad uniforme.** Todas las secciones al mismo ritmo, sin pasajes densos ni pasajes tranquilos.

## Astryx

Evaluado (github.com/meta/astryx, v0.7, beta). **No se adopta.** Exige StyleX con su compilador en el build, que se suma a Tailwind 4 en vez de sustituirlo: dos sistemas de estilos, un plugin más en Turbopack y una dependencia en beta para una app de una persona. Se toma de él la idea que sí sirve: el tema como un juego de propiedades CSS con nombres semánticos (`--bg`, `--fg`, `--accent`…) y los modos claro y oscuro como redefinición de esas mismas propiedades.

## Dirección: sala de pesas

Grafito, tiza y los colores de los discos de competición. El amarillo del disco de 15 kg es el acento; el azul (20 kg) y el rojo (25 kg) solo codifican datos.

- **Tipo.** Una sola familia variable, **Archivo**, y su eje de anchura como jerarquía: condensada al 62,5 % y peso 800 para la cifra que manda (`.display`), al 75 % para títulos de página, normal para texto. Cifras tabulares de la propia familia; sin mono.
- **Una cifra protagonista por pantalla**, enorme (48-80 px): la acción en Hoy, la carga objetivo en el entreno, la mejor marca en la ficha, el peso en Progreso, las kcal en Comida.
- **Mapa muscular** propio en SVG (`src/components/body-map.tsx`), frente y espalda: azul bajo el MEV, amarillo dentro del rango (más intenso cerca del MRV), rojo por encima.
- **Bloques elevados (`.slab`)** solo para lo que se toca o se lee de un vistazo: la sesión de hoy, el ejercicio activo, las sesiones de `/programa`. El resto, filas con filete.
- **Navegación**: barra inferior en móvil, raíl a la izquierda desde 1024 px con «Programa».

## Tokens (`src/app/globals.css`)

| Token | Claro | Oscuro | Uso |
|---|---|---|---|
| `--bg` | `#f3f4f2` | `#0c0e10` | Fondo |
| `--surface` | `#ffffff` | `#15181b` | Bloques, hojas, barra fija |
| `--field` / `--raise` | `#e9ebe8` / `#dfe2de` | `#1c2024` / `#252a2f` | Campos y pasadores / silueta, zona MEV-MRV |
| `--line` / `--line-strong` | `#d9dcd8` / `#b4b9b4` | `#262b30` / `#3b424a` | Filetes / bordes de control |
| `--fg` / `--fg-2` / `--fg-3` | `#111315` / `#474e55` / `#646c73` | `#eef0f1` / `#a8afb6` / `#7f878f` | Texto (≥ 5:1 el terciario) |
| `--accent` | `#f2c230` | `#f2c230` | Relleno de la acción principal, texto `--on-accent` encima |
| `--accent-ink` | `#7f6100` | `#f2c230` | El acento como texto: aviso, PR |
| `--hot` / `--cool` | `#c62a2f` / `#2b5fcf` | `#ff6b5e` / `#6b9bff` | Sobre el máximo y errores / bajo el mínimo |

Espaciado en múltiplos de 4 px (más aire encima de un título que debajo). Radios: 10 px controles, 14 px acción grande y pasadores, 18 px bloques y hojas, píldora en chips y pestañas. Movimiento: `--ease` `cubic-bezier(.2,.8,.2,1)` con 120 / 200 / 320 ms; la hoja sube, los botones ceden un 1,5 % al pulsar; nada con `prefers-reduced-motion`. Modo: sigue al sistema (`prefers-color-scheme`).

## Reglas

- Una sola acción amarilla por pantalla.
- Toda cifra lleva unidad; si no es de hoy, su fecha; si es estimada, lo dice.
- Estado vacío = qué falta y qué registrar. Nunca datos de ejemplo.
- Gráficas en SVG propio (`src/components/charts.tsx`): línea gruesa con área suave para la serie protagonista, puntos para el dato diario.
- Zonas táctiles de 44 px o más (60 px la acción principal y los pasadores).
