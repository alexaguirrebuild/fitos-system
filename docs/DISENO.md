# Diseño

Herramienta personal de Alex (no es la marca THEOVERCODE). Se usa con una mano, en el gimnasio, entre series, a 390 px y a veces sin cobertura. Por eso es oscura: luz de sala irregular, pantalla a medio brillo, sudor.

## Dirección

Un libro de registro editado como un almanaque deportivo. La pantalla es una pantalla de trabajo: navegación inferior estándar, listas, campos y botones que ya se saben usar. El mundo solo aporta cuatro cosas:

- **Tipo.** Bodoni Moda (didona) para la única cifra o frase que manda en cada pantalla; Space Grotesk para texto y controles; IBM Plex Mono, tabular, para toda cifra medida.
- **Paleta.** Negro cálido, hueso y un solo acento: rojo sangre seco.
- **Densidad.** Filas de libro de registro: etiqueta a la izquierda, cifra a la derecha, filete de 1 px. Sin tarjetas en rejilla.
- **Gesto propio.** El objetivo de la serie compuesto en didona grande («100 kg × 8-10 · RIR 2») con su porqué debajo en una línea.

Lo que se rechaza: frases de póster, emojis, etiquetas en mayúsculas sobre los títulos, degradados, sombras, rebotes, anillos decorativos.

## Tokens (`src/app/globals.css`)

| Token | Valor | Uso |
|---|---|---|
| `--ink-0` | `#0e0c0a` | Fondo |
| `--ink-1` | `#15120f` | Superficie (hojas, avisos, barra fija) |
| `--ink-2` | `#1e1a16` | Campos y pasadores |
| `--line` / `--line-strong` | `#2c2621` / `#4a4037` | Filetes / bordes de control |
| `--bone` | `#ece4d6` | Texto (15,6:1 sobre el fondo) |
| `--bone-2` | `#b3a999` | Texto secundario (8,3:1) |
| `--bone-3` | `#8f8577` | Texto terciario (5,2:1) |
| `--blood` / `--blood-hi` | `#8a1c14` / `#a52419` | Acento como relleno: la acción principal (texto hueso encima, 7,3:1) |
| `--blood-ink` | `#e06a57` | El mismo acento como texto o trazo: avisos, PR, MRV (5,9:1) |
| `--radius` | `2px` | Radio único |
| `--ease` | `cubic-bezier(.16,1,.3,1)` | Única curva; 140-320 ms; nada con `prefers-reduced-motion` |

Escala: didona 40 / 36 / 32 / 22 px; texto 16; secundario 14; mínimo 13. Zonas táctiles de 48 px o más (60 la acción principal, 56 los pasadores). `env(safe-area-inset-*)` en la barra inferior, la barra fija y las hojas.

## Reglas

- Una sola acción roja por pantalla. El rojo como texto significa aviso o marca, nunca adorno.
- Toda cifra lleva unidad; si no es de hoy, su fecha; si es estimada, lo dice.
- Estado vacío = qué falta y qué registrar. Nunca datos de ejemplo.
- Gráficas en SVG propio (`src/components/charts.tsx`): puntos para el dato diario, línea para la tendencia, discontinua roja para el objetivo.
- Foco visible en hueso, 2 px. Selección en rojo. Barras de desplazamiento finas del color de los filetes.
