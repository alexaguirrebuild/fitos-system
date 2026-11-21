# Gimnasio: Enjoy Carabanchel

Investigado el 21-nov-2026. **VERIFICADO** = leído hoy (URL) o visto en una foto de Alex. **SIN VERIFICAR** = inferido o no encontrado. Datos de máquinas en `data/seed/equipment.json`.

## 1. Carpeta de Drive `16QUYb-lADVvxH2mgm68v8Yr-SbjI53xn`

Listada con rclone el 21-nov-2026 (fecha = subida a Drive, 21-nov 11:21-11:45 UTC; el nombre lleva la fecha de captura).

| Fichero | Tipo | Tomada | Qué es |
|---|---|---|---|
| `20261120_213646.jpg` | JPEG 2,8 MB | 20-nov 21:36 | Rótulo de la polea doble «DAP» (ENCORE) |
| `20261120_220426.jpg` | JPEG 2,8 MB | 20-nov 22:04 | Barra Z con discos en el suelo (movida) |
| `20261120_220431.jpg` | JPEG 3,3 MB | 20-nov 22:04 | Rack de mancuernas ZIVA (2, 4, 8, 10 kg) |
| `20261120_220736.jpg` | JPEG 2,9 MB | 20-nov 22:07 | Life Fitness «Mariposa pectoral» |
| `20261120_220926.jpg` | JPEG 3,0 MB | 20-nov 22:09 | Life Fitness «Curl de bíceps» |
| `20261120_220933.jpg` | JPEG 3,0 MB | 20-nov 22:09 | Life Fitness «Elevación lateral» |
| `20261120_220944.jpg` | JPEG 3,0 MB | 20-nov 22:09 | Life Fitness «Remo» |
| `20261120_220950.jpg` | JPEG 2,8 MB | 20-nov 22:09 | Life Fitness «Aducción de cadera» |
| `20261120_222553.jpg` | JPEG 4,1 MB | 20-nov 22:25 | Pantalla de la InBody |
| `20261121_121511.jpg`, `…121524`, `…121546`, `…121610` | JPEG ~3 MB c/u | 21-nov 12:15-12:16 | Fotos de físico. No abiertas |
| `RelacionProblemasSalud (1).pdf` | PDF 0,5 MB | subido 21-nov 11:45 | No abierto (fuera del encargo) |

**InBody del 20-nov-2026** (VERIFICADO, foto `20261120_222553.jpg`): altura 174,0 cm, 22 años, peso **90,7 kg**, masa musculoesquelética **38,8 kg**, grasa corporal **25,8 %**. Es la pantalla resumen, sin segmental ni agua. Candidata a `body_metrics` del 20-nov (no se ha cargado).

## 2. El gimnasio

- Calle Reus 11, 28044 Madrid. L-V 7:00-23:00, S-D 9:00-21:00. «1000 m2 de sala con más de 200 puestos», «equipamiento deportivo de última generación con conectividad» — VERIFICADO https://enjoy.es/centros/enjoy-carabanchel/
- La web **no nombra la marca** de las máquinas, y no hay nota de prensa Enjoy + Life Fitness (CMD Sport, Palco23, Gym Factory) — NO ENCONTRADO.
- La marca sale de las fotos: rótulos «Life Fitness» y QR de LFconnect en las selectorizadas — VERIFICADO (fotos).

## 2b. Fotos de Google Maps (revisadas el 21-nov-2026)

31 fotos de la ficha «Enjoy! Carabanchel» (3,9 ★, 838 reseñas), pestaña Gimnasio — VERIFICADO https://www.google.com/maps/place/Enjoy!+Carabanchel/@40.3717205,-3.7434354,17z (la mayoría de feb-2025, del propietario y de usuarios). Lo que se ve:

- **Selectorizadas Life Fitness** en fila, tapizado color arena, carcasa negra alta con el logo «Life Fitness», ventana de la torre y pegatina de instrucciones con figura azul. Vistas: extensión de cuádriceps («Leg Extension»), curl femoral, press/jalón de hombro, varias más sin rótulo legible. Mismo aspecto que las de tus fotos → misma línea en toda la sala.
- **Zona «FREE WEIGHT»** con suelo de caucho: al menos 3 jaulas/medias jaulas con discos, una multipower o estación guiada, bancos ajustables (más de 10), dos racks largos de mancuernas ZIVA (vistas hasta 14 kg en primer plano) y **máquinas de discos** negras a la izquierda (palancas con cuernos de carga, tipo Hammer Strength Plate-Loaded; marca no legible).
- **Polea doble / estaciones de cable**: torres altas con dos poleas en la zona de máquinas.
- **Zona funcional** con jaula amarilla y saco «BOX»; **terraza exterior** con césped, jaulas, air bikes, bancos y mancuernas hexagonales; discos bumper de 15 kg.
- Cardio Life Fitness (cintas, elípticas) y bicis de ciclo ICG/Life Fitness.

Con eso: los tipos de `equipment.json` (`placas`, `discos`, `polea`, `multipower`, `libre`) cubren todo lo que hay. Lo que no puedo sacar de fotos de este tamaño: modelo exacto de cada máquina de discos y de la multipower.

## 3. Qué hay, por tipo

### Selectorizadas Life Fitness (`placas`)
Vistas: Mariposa pectoral, Curl de bíceps, Elevación lateral, Remo, Aducción de cadera. Todas con QR «LFCONNECT», icono NFC y una pantallita con dos lecturas (iconos de contador y de cronómetro) — VERIFICADO (fotos).

**Línea: probablemente Insignia Series** — SIN VERIFICAR. Indicios: Insignia trae «rep counter» integrado (VERIFICADO https://www.lifefitness.com/en-eu/catalog/strength-training/selectorized/insignia-series), su demo muestra «rep timer/counter, QR Code and LF Connect App» (https://www.youtube.com/watch?v=TlU_a9epGC0), y el vídeo al que apunta el QR es «Insignia Series Pectoral Fly/Rear Deltoid» (https://www.youtube.com/watch?v=4s3rkgBX5So). Para confirmarlo: mirar la placa de serie de la máquina.

Carga de Insignia (VERIFICADO):
- Torre estándar 130 kg (260 lb) o pesada 152 kg (305 lb) en Chest Press y Pec Fly — https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/insignia-series-chest-press
- Incrementos opcionales: dos de 2,5 kg (5 lb), o uno de 3,75 kg (7,5 lb) según configuración — https://support.lifefitness.com/hc/en-us/articles/4421250882327-Life-Fitness-Insignia-Strength-Customization-Options. En la foto de Elevación lateral se ven pomos amarillos marcados «2.5»: encaja con la opción de dos incrementos de 2,5 kg (SIN VERIFICAR).
- **Peso de cada placa de la torre: NO ENCONTRADO.** Que Alex lo mire en la pegatina de la torre.
- Resistencia: «variable strength profiles», movimientos convergentes/divergentes — VERIFICADO (página de la serie). → `resistance_profile: variable`.

### Polea doble DAP (`polea`)
Rótulo «DUAL ADJUSTABLE PULLEY · DAP» con logo y marca **ENCORE**, no Life Fitness — VERIFICADO (foto `20261120_213646`). Fabricante, relación de polea y peso de placa: NO ENCONTRADO. Referencia: la DAP de Life Fitness es 4:1 (195 kg de torre → ~49 kg efectivos) — VERIFICADO https://www.lifefitness.com/en-us/catalog/strength-training/cable-machines-functional-trainers/life-fitness-dual-adjustable-pulley — pero **no es esta máquina**. Consecuencia práctica: el número de la torre no son kilos reales en la mano; registra siempre el número de placa y no compares con otra polea.

### Peso libre (`libre`)
- Mancuernas ZIVA redondas: vistas 2, 4, 8 y 10 kg — VERIFICADO (foto). Salto de 2 kg en la zona vista; por encima, SIN VERIFICAR.
- Barra Z con discos — VERIFICADO (foto, aunque movida). Discos de 2,5 kg como mínimo: SIN VERIFICAR.

### Multipower y Plate-Loaded Hammer Strength (`multipower`, `discos`)
No aparecen en las fotos. Alex dice que hay Hammer Strength; no se ha visto cuál. Datos de catálogo por si es Hammer:
- Smith Hammer Strength contrapesada: barra de inicio 13,6 kg (30 lb) — VERIFICADO https://www.lifefitness.com/en-us/catalog/strength-training/benches/smith-machine. La Smith Life Fitness: barra de 9 kg (20 lb) — https://www.lifefitness.com/en-us/catalog/strength-training/benches/life-fitness-smith-machine. **Esto cambia el kilo real**: apunta cuál es.
- Plate-Loaded Iso-Lateral: brazos independientes, 3,2 kg de resistencia inicial por brazo — VERIFICADO https://www.lifefitness.com/en-us/catalog/strength-training/plate-loaded/plate-loaded-iso-lateral-bench-press. Perfil variable por la palanca (inferencia).
- Hammer Strength Select: incrementos 3,4 kg o 2×2,5 kg — VERIFICADO https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/hammer-strength-select

Para completar `equipment.json` falta una foto de: el multipower, cada Hammer Strength de discos, la prensa, el jalón, y la pegatina de la torre de cualquier selectorizada.

## 4. El QR y LFconnect

`referer-link` decodificado (VERIFICADO, `base64 -d`): `https://lfconnect.com/q?t=s&m=ssfly`.
- `t=s`: coincide con `referer-type=STRENGTH` (inferencia).
- `m=ssfly`: código de máquina. No documentado. Hipótesis: «selectorized strength fly». El vídeo `4s3rkgBX5So` es el Pec Fly/Rear Delt de Insignia — VERIFICADO (YouTube, canal Life Fitness Training, 2-sep-2014).
- **Choque**: el QR se dijo de la máquina «REMO», pero su código y vídeo son de la Mariposa/Pec Fly. O se escaneó la de al lado, o el QR está mal puesto. Escanear de nuevo el de Remo.

Qué da LFconnect (Life Fitness Connect App):
- Al escanear el QR, el ejercicio se añade al entreno activo — VERIFICADO https://support.lifefitness.com/hc/en-us/articles/25251119102487-Life-Fitness-Connect-App-New-Start-a-Workout-Fast
- Series, reps y peso se meten **a mano** (o se acepta el peso recordado) — VERIFICADO https://support.lifefitness.com/hc/en-us/articles/35175203274519-Life-Fitness-Connect-App-New-Software-Release-Notes-v1-9-0. Que lea solo el contador de la máquina: NO ENCONTRADO (requiere el «Connect Kit» en la torre).
- Integraciones: Apple Health, Google Health, Samsung Health, MyFitnessPal; Strava y Fitbit desde v1.10.0, y a Strava solo llega la duración, sin series ni peso — VERIFICADO https://support.lifefitness.com/hc/en-us/articles/4407252268695-Life-Fitness-Connect-App-3rd-Party-App-Compatibility y https://support.lifefitness.com/hc/en-us/articles/35932675587735-Life-Fitness-Connect-App-New-Software-Release-Notes-v1-10-0
- **API pública para un usuario: NO ENCONTRADO.** Exportación CSV: NO ENCONTRADO. Existen Halo Fitness for Developers (https://developers.halo.fitness/) y LFopen (2013, consolas de cardio), pensados para operadores e integradores; acceso individual sin verificar.

**Conclusión:** LFconnect no aporta nada que la app no tenga ya; duplicaría el registro de series. Lo útil del QR es el **código de máquina** (`ssfly`…) como identificador estable. Propuesta: guardar ese código en `equipment.json` cuando Alex escanee cada máquina, para poder identificar la máquina con una foto del QR.

## 5. Máquina → ejercicio existente (`data/seed/exercises.base.json`)

Propuesta; no se ha tocado el fichero de ejercicios.

| `equipment.json` | Ejercicio existente | Encaja | Nota |
|---|---|---|---|
| `lf-insignia-mariposa-pectoral` | `contractora-pectoral` y `contractora-posterior` | Sí | La misma máquina hace los dos (Pec Fly/Rear Delt) |
| `lf-insignia-curl-biceps` | — | No hay | Lo más cercano es `curl-scott-polea`; falta un «curl de bíceps en máquina» |
| `lf-insignia-elevacion-lateral` | `elevaciones-laterales-maquina` | Sí | |
| `lf-insignia-remo` | `remo-pecho-apoyado-maquina` | Probable | Si tiene apoyo de pecho (SIN VERIFICAR) |
| `lf-insignia-aduccion-cadera` | `aductor-maquina` | Sí | |
| `encore-dap-polea-doble` | `elevaciones-laterales-polea`, `extension-triceps-katana`, `triceps-cuerda`, `face-pull`, `curl-bayesian-unilateral`, `curl-inverso-polea`, `crunch-polea`, `pallof-press`, `remo-unilateral-polea`, `pull-over-polea` | Sí | `jalon-prono` y `curl-scott-polea` necesitan banco o estación propia |
| `ziva-mancuernas` | `press-inclinado-mancuerna`, `elevaciones-laterales-mancuerna`, `curl-martillo`, `encogimientos-trapecio`, `pajaros-deltoide-posterior` | Sí | |
| `barra-z-discos` | `curl-barra-z-scott` | Sí | |
| `hs-smith-contrapesada` | `sentadilla-multipower`, `bulgaras-multipower`, `jm-press-multipower`, `press-inclinado-multipower` | Si es esa Smith | Fija el peso real de la barra |
| `hs-plate-loaded-iso-lateral` | `press-inclinado-hammer`, `remo-hammer-unilateral` | Si existen | Sin foto |

Hueco de modelo: `exercises.base.json` usa `equipment: maquina` para placas **y** discos. Para distinguirlo como pide Alex harían falta `maquina_placas` y `maquina_discos` (o un `equipment_slug` que apunte a este fichero). Es un cambio de esquema: no se ha hecho.
