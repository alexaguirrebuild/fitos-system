# Motor científico

Código en `src/engine/` (TypeScript puro, sin dependencias). Tests en `src/engine/__tests__/engine.test.ts`.
La ingeniería inversa de los Excels, la evidencia con sus PMID y las decisiones están en
`CEREBRO/research/_inbox/2026-11-20-sistema-fitness-arquitectura/01_ingenieria_inversa_excels.md`. Aquí va solo el mapa.

Cada regla lleva su grado: **evidencia** (ensayo o metaanálisis comprobado), **fórmula** (ecuación publicada) o **heurística** (criterio de entrenador, editable).

| Módulo | Función | Qué hace | Grado |
|---|---|---|---|
| `strength` | `estimate1RM`, `rmFactor` | e1RM con reps + RIR. Epley ≤ 10, media Epley-Brzycki 11-15, nada por encima. Confianza según RIR | fórmula |
| | `pctFromRpe`, `RPE_TABLE` | Tabla RPE × reps → % 1RM (hoja de prescripción) | heurística (datos de usuarios RTS) |
| | `suggestNext` | Doble progresión con RIR: sube carga al completar el techo; +1 rep dentro del rango; repite o baja 5 % por debajo del suelo; readiness y descarga mandan | heurística |
| | `warmupLadder`, `platesPerSide` | Aproximaciones y discos por lado | heurística |
| `load` | `acwr`, `ewma`, `dailyLoads` | Carga sRPE × min por día de calendario, EWMA 7/28. Sin ratio hasta 21 días | fórmula (el ratio como predictor de lesión está discutido: es un semáforo) |
| | `weeklyStress`, `setStress` | Estrés por serie según RIR, sumado por grupo | heurística |
| | `tonnage`, `liftCount`, `meanRelativeIntensity` | Descriptores | fórmula |
| `volume` | `hardSetsByMuscle`, `volumeStatus`, `volumeAdvice` | Series efectivas (RIR ≤ 3), 0,5 a sinergistas, frente a MEV/MRV | evidencia para «≥ 10 series/semana»; MEV/MRV heurística |
| | `stimulusFatigue`, `refIndex` | Ratio estímulo-fatiga y REF del Excel | heurística |
| `recovery` | `readiness` | Fórmula de la app antigua (histórico comparable) | heurística |
| | `scorePoms` | POMS de 52 ítems con el mapa de escalas corregido y TMD | fórmula |
| | `deloadDecision` | Descarga con dos señales; exámenes solos = mantenimiento | heurística |
| | `ankleRule` | Tobillo > 3: sin impacto, Z2 en bici o elíptica, tope 75 % | regla propia (script de julio) |
| `nutrition` | `mifflin`, `adaptiveTdee` | Gasto estimado y, con 14 días de datos, medido | fórmula |
| | `planTargets` | Déficit por ritmo (tope 25 % del gasto), proteína 2,3 g/kg magro, grasa 0,8 g/kg, On/Off con el total semanal fijo | evidencia (ritmo y proteína); On/Off sin ventaja demostrada |
| | `weeklyDecision` | Cruza peso, rendimiento, cintura, recuperación y adherencia | heurística |
| | `caffeineCutoff`, `caffeineMaxMg` | Corte 9 h antes de dormir; 3 mg/kg | evidencia (sueño) |
| `cardio` | `hrZones`, `zoneOf`, `ecos` | Tanaka + Karvonen (tabla ESEN) | fórmula |
| `assessment` | `trainingLevel` | Fuerza relativa y 4 criterios más | heurística |
| | `oneRmFromVelocity` | Perfil carga-velocidad (necesita sensor) | fórmula |

## Parámetros que más mueven el plan

| Parámetro | Valor | Dónde |
|---|---|---|
| Proteína | 2,3 g por kg de masa magra | `planTargets({ proteinPerLeanKg })`, columna `nutrition_targets.protein_per_lean_kg` |
| Grasa | 0,8 g por kg | `fatPerKg` |
| Ritmo | 0,8 %/semana a más de 4 kg del objetivo; 0,5 % después | `targetRatePct` |
| Diferencia On − Off | 12 % de la media | `onOffSpread` |
| Subida de carga | 2,5 % compuestos, 5 % aislamientos, mínimo un salto real | `suggestNext` |
| Tope útil por sesión | 10 series efectivas por grupo | `SESSION_CAP` |
| MEV / MRV | por grupo, editables | `fit.muscle_groups`, `fit.athlete_volume_targets` |
| Corte de cafeína | 9 h antes de acostarse | `caffeineCutoff` |

Cambiar un parámetro es cambiar un número: ninguna pantalla lo lleva escrito.
