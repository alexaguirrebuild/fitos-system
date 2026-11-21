# Motor científico

Código en `src/engine/` (TypeScript puro, sin dependencias). Tests en `src/engine/__tests__/engine.test.ts` y `src/engine/__tests__/reglamento.test.ts` (el cruce con el reglamento de evidencia v1, con el caso real de Alex).
La ingeniería inversa de los Excels, la evidencia con sus PMID y las decisiones están en
`CEREBRO/research/_inbox/2026-11-20-sistema-fitness-arquitectura/01_ingenieria_inversa_excels.md`. Aquí va el mapa y los PMID de cada regla que se tocó en el cruce del 21-nov-2026.

Cada regla lleva su grado: **evidencia** (ensayo o metaanálisis comprobado), **fórmula** (ecuación publicada), **derivada** (cuenta o decisión de ingeniería sobre evidencia) o **heurística** (criterio de entrenador, editable).

| Módulo | Función | Qué hace | Grado |
|---|---|---|---|
| `strength` | `estimate1RM`, `rmFactor` | e1RM con reps + RIR. Epley ≤ 10, media Epley-Brzycki 11-15, nada por encima. Confianza según RIR | fórmula |
| | `pctFromRpe`, `RPE_TABLE` | Tabla RPE × reps → % 1RM (hoja de prescripción) | heurística (datos de usuarios RTS) |
| | `suggestNext` | Doble progresión con RIR: sube carga al completar el techo; +1 rep dentro del rango; repite o baja 5 % por debajo del suelo; readiness y descarga mandan. **En déficit, los compuestos van con RIR +1** (no se suma al +1 del readiness bajo). Con `holdProgression` (tobillo), repite en vez de progresar | evidencia (autorregulación frente a carga fija ES 0,64, PMID 33776802); RIR +1 en déficit: derivada (RIR-02; fuerza insensible al RIR, PMID 38970765; fallo frente a no fallo ES 0,19, PMID 36334240) |
| | `warmupLadder`, `platesPerSide` | Aproximaciones y discos por lado | heurística |
| `load` | `acwr`, `ewma`, `dailyLoads` | Carga sRPE × min por día de calendario, EWMA 7/28 con los días sin sesión a 0. Sin ratio hasta 21 días | fórmula (PMID 28003238). El ratio no es causal: es un semáforo (PMID 32502973) |
| | `acwrZone` | 0,8-1,3 óptimo · ≤ 1,5 precaución · ≤ 2,0 pico · **> 2,0 `pico_extremo`** | evidencia: menor riesgo en 0,8-1,3 (PMID 32158285); > 2,0 RR 6,5-21 (PMID 28003238) |
| | `weeklyStress`, `setStress` | Estrés por serie según RIR, sumado por grupo | heurística |
| | `tonnage`, `liftCount`, `meanRelativeIntensity` | Descriptores | fórmula |
| `volume` | `hardSetsByMuscle` | Series efectivas (RIR ≤ 3): 1 al principal, 0,5 a cada sinergista | evidencia: el conteo fraccional es el de más evidencia relativa (PMID 41343037) |
| | `volumeStatus`, `volumeAdvice` | Frente a MEV/MRV. **En déficit no se progresan series**: > 16 → bajar a 16; bajo el MEV → subir hasta el MEV; el resto, mantener y progresar carga y RIR | derivada (VOL-03): en déficit la ganancia de magra ya está deteriorada (PMID 34623696); dosis-respuesta +0,37 %/serie (PMID 27433992) |
| | `weeklySetsRange`, `DEFICIT_WEEKLY_SETS` | Rango semanal por nivel; en déficit, 12-16 | derivada |
| | `stimulusFatigue`, `refIndex` | Ratio estímulo-fatiga y REF del Excel | heurística |
| `recovery` | `readiness` | Fórmula de la app antigua (histórico comparable) | heurística |
| | `scorePoms` | POMS de 52 ítems con el mapa de escalas corregido y TMD | fórmula |
| | `deloadDecision` | Descarga con **dos señales**; exámenes solos = mantenimiento. Señales: e1RM cae dos sesiones, readiness 7 d < 50, estrés semanal > 26, ACWR > 1,5, exámenes, **sueño < 7 h en ≥ 3 de 7 noches**, **dolor tendinoso > 5/10** | heurística (dos señales: se mantiene frente al OR del reglamento, CAR-05). Sueño: la restricción seguida baja la fuerza en multiarticulares (PMID 29422383). Tendón: umbral del Pain-Monitoring Model (PMID 33632313) |
| | `ankleRule` | Tobillo > 3: sin impacto, Z2 en bici o elíptica, tope 75 %. **Si a la mañana siguiente de pierna duele más que antes de entrenar, `holdProgression`: la próxima pierna repite sin progresar** | regla propia (script de julio). **Se mantiene > 3**, más prudente que el ≤ 5 del modelo (PMID 33632313, 17307888) |
| `nutrition` | `mifflin`, `adaptiveTdee` | Gasto estimado y, con 14 días de datos, medido | fórmula (PMID 2305711) |
| | `bodyComposition` | % graso medido, Navy o RFM con su margen. **La bioimpedancia (InBody, Tanita…) entra como `bia`, ±4 puntos**; DXA u otro medido, ±2 | evidencia: BIA ±3-5 puntos frente a DXA |
| | `waistForWhtr` | Cintura máxima para un índice cintura/altura ≤ 0,50: con 174 cm, **87 cm** (88 da 0,506). `recalcTargets` avisa si la cintura objetivo de la ficha queda por encima | evidencia: frontera 0,50, AUROC 0,704 frente a 0,671 del IMC (PMID 20819243) |
| | `targetRatePct` | Ritmo pedido: **0,7 %**/semana a más de 4 kg del objetivo; 0,5 % después | evidencia: a 0,7 % se ganó magra (+2,1 %), a 1,4 % se perdió (PMID 21558571); modelo de Forbes/Hall (PMID 17367567) |
| | `planTargets` | Déficit por ritmo, techo de recomposición, tope del 25 % y suelo por día; devuelve la **tasa real**; proteína escalada; On/Off con el total semanal fijo. Ver abajo | evidencia (ritmo, proteína, reparto); suelo heurística del cuaderno; On/Off ±12 % sin ventaja demostrada |
| | `weeklyDecision` | Cruza peso, rendimiento, cintura, recuperación y adherencia. **Juzga contra la tasa real**, no pide bajar kcal en el suelo y propone **semana de mantenimiento tras ≥ 8 semanas en déficit** | heurística; pausa de dieta: PMID 28925405 (a favor), PMID 37181269 (en entrenados, solo adherencia) |
| | `caffeineCutoff`, `caffeineMaxMg` | Corte **9 h** antes de dormir; 3 mg/kg | evidencia: 400 mg a 6 h ya alteran el sueño (PMID 24235903). Se mantienen 9 h y no las 6 del reglamento por el 36 % de fase de sueño retrasada en adultos con TDAH (PMID 39354860) |
| `cardio` | `hrZones`, `zoneOf`, `ecos` | Tanaka + Karvonen (tabla ESEN) | fórmula |
| `assessment` | `trainingLevel` | Fuerza relativa y 4 criterios más | heurística |
| | `oneRmFromVelocity` | Perfil carga-velocidad (necesita sensor) | fórmula |

## `planTargets`, paso a paso

1. **Déficit pedido** = peso × ritmo × 7.700 / 7.
2. **Modo** (`mode`): `definicion` (por defecto) deja mandar al ritmo. `recomposicion` limita el déficit medio a **500 kcal**: por encima desaparece la ganancia de magra (ES −0,57; PMID 34623696). Son excluyentes: el motor no promedia.
3. **Tope**: el déficit no pasa del 25 % del gasto.
4. **Suelo**: **ningún día** baja de 24 kcal por kg de peso, **tampoco el Off**. Si la media cae por debajo, sube al suelo. Si es el Off el que cae, el Off se queda en el suelo y el On absorbe la diferencia, con el total semanal intacto (`offRaised`, `onOffSpreadApplied`).
5. **Tasa real** (`effectiveRatePct`) = déficit final × 7 / 7.700 / peso, y `limitedBy` dice qué la recortó (`tasa`, `recomposicion`, `tope` o `suelo`). Es contra la que juzga `weeklyDecision`: antes comparaba con la pedida y proponía `bajar_kcal` cuando el suelo ya lo impedía (bucle).
6. **Proteína**: k = 2,3 + 0,8 × min(1, déficit % / 30) g por kg de masa magra (2,3 sin déficit, 3,1 con un 30 % o más; PMID 24092765, 25014731; extremo alto en 6 días/semana, PMID 26817506). `proteinPerLeanKg` lo fija a mano. Se guarda el k usado en `nutrition_targets.protein_per_lean_kg`.
7. **Reparto**: `proteinPerMealG` = proteína / comidas (4 por defecto). Unos 30 g por comida en reparto homogéneo dieron un 25 % más de síntesis proteica que cargar la cena (PMID 24477298).

Caso real (21-nov-2026: 90,07 kg, 66,83 kg magros, TDEE de referencia 2.681): se piden 694 kcal; el tope deja 670 y el suelo, 519. Tasa real **0,52 %**/semana (0,47 kg), no 0,7. Todos los días a 2.162 kcal. Proteína k = 2,82 → **188 g**, 47 g en cada una de 4 comidas. En calibración (a mantenimiento) la proteína se queda en 2,3 → 154 g.

## Parámetros que más mueven el plan

| Parámetro | Valor | Dónde |
|---|---|---|
| Proteína | 2,3-3,1 g por kg de masa magra, según el déficit | `proteinPerLeanKgFor`, `planTargets({ proteinPerLeanKg })`, columna `nutrition_targets.protein_per_lean_kg` |
| Comidas para repartir la proteína | 4 | `DEFAULT_MEALS_PER_DAY`, `planTargets({ mealsPerDay })` |
| Grasa | 0,8 g por kg | `fatPerKg` |
| Ritmo | 0,7 %/semana a más de 4 kg del objetivo; 0,5 % después | `targetRatePct` |
| Modo | definición (ritmo) o recomposición (≤ 500 kcal de déficit medio) | `planTargets({ mode })`, `recalcTargets({ mode })` |
| Suelo | 24 kcal por kg, por día | `DEFAULT_FLOOR_KCAL_PER_KG`, `floorKcalPerKg` |
| Diferencia On − Off | 12 % de la media (menos si el Off toca el suelo) | `onOffSpread` |
| Pausa de dieta | 8 semanas seguidas en déficit | `DIET_BREAK_WEEKS` |
| Señales de descarga nuevas | 3 noches < 7 h en 7 días (check-in y, si no trae horas, el reloj); dolor tendinoso > 5/10 | `SHORT_SLEEP_NIGHTS`, `TENDON_PAIN_SIGNAL` |
| RIR en déficit | +1 en compuestos | `suggestNext({ inDeficit })` |
| Series en déficit | 12-16 por grupo y semana | `DEFICIT_WEEKLY_SETS` |
| Subida de carga | 2,5 % compuestos, 5 % aislamientos, mínimo un salto real | `suggestNext` |
| Tope útil por sesión | 10 series efectivas por grupo | `SESSION_CAP` |
| MEV / MRV | por grupo, editables | `fit.muscle_groups`, `fit.athlete_volume_targets` |
| Corte de cafeína | 9 h antes de acostarse | `caffeineCutoff` |

Cambiar un parámetro es cambiar un número: ninguna pantalla lo lleva escrito.

## Pendiente del cruce (no aplicado)

- On/Off 5+2 con los dos Off a mantenimiento (`structure: "refeed_5_2"`; PMID 33467235). Choca con el significado actual de On/Off (On = entreno): el refeed va en los días de pierna de más volumen (CIC-02). Es una decisión de Alex.
- Bloque HSR 3×/semana durante 12 semanas para el tobillo (PMID 26018970): va en el programa, no en el motor.
- Bici 10 min antes de estudiar (PMID 36829357), creatina (PMID 35986981) e intenciones «si-entonces» con revisión semanal (PMID 30427874): necesitan tabla o pantalla.
- `acwr` fiable desde 28 días en vez de 21 (criterio estricto del reglamento; 21 se considera aceptable).
- Aviso de que la cafeína no tiene beneficio significativo en tren inferior (PMID 29527137).
