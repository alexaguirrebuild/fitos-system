"""Genera las semillas base: grupos musculares, ejercicios del plan de la app, plantilla torso/pierna y glosario.
Uso: python -I -X utf8 scripts/build_base_seed.py data/seed
"""
import json, os, sys

out = sys.argv[1]

# id | nombre | región | MEV | MRV | semivida h.  MEV/MRV: hoja «VOL SEMANAL» de Gorilangel donde existe (*); el resto, valor de arranque editable.
MUSCLES = """
biceps|Bíceps|brazo|12|24|24|*
triceps|Tríceps|brazo|8|18|24|*
deltoides_lateral|Deltoides lateral|torso|14|28|24|*
deltoides_posterior|Deltoides posterior|torso|6|12|24|*
deltoides_anterior|Deltoides anterior|torso|0|12|24|
pectoral|Pectoral|torso|10|20|30|*
espalda|Espalda|torso|16|36|30|*
trapecio|Trapecio|torso|4|16|30|
erectores|Erectores espinales|torso|2|10|48|
antebrazo|Antebrazo|brazo|2|12|24|
cuadriceps|Cuádriceps|pierna|6|12|48|*
isquios|Isquiosurales|pierna|6|18|48|*
gluteos|Glúteos|pierna|4|16|48|*
aductores|Aductores|pierna|4|12|48|*
abductores|Abductores|pierna|4|12|48|
gemelos|Gemelos|pierna|6|16|48|
core|Core|core|4|16|24|
"""

# slug|nombre|principal|secundarios|tipo|patrón|equipo|estabilidad|perfil|coste|salto|calentamiento|tobillo|impacto|alias[|tipo_de_equipo]
# El tipo de equipo es opcional: si falta, la carga lo deduce del equipo (equipmentTypeFrom).
EX = """
press-banca|Press banca|pectoral|triceps,deltoides_anterior|compuesto|empuje_h|barra|bilateral_libre|constante|1.2|2.5|completo|ninguna|0|press de banca;bench
press-inclinado-mancuerna|Press inclinado con mancuernas|pectoral|deltoides_anterior,triceps|compuesto|empuje_h|mancuernas|bilateral_libre|constante|1|2|reducido|ninguna|0|press incl mancuerna
press-inclinado-hammer|Press inclinado en máquina Hammer|pectoral|deltoides_anterior,triceps|compuesto|empuje_h|maquina|bilateral_guiado|variable|1|2.5|reducido|ninguna|0|press incl en maq hammer;press inclinado maquina
press-plano-maquina|Press plano en máquina|pectoral|triceps,deltoides_anterior|compuesto|empuje_h|maquina|bilateral_guiado|variable|1|2.5|reducido|ninguna|0|press plano en maquina polea;press plano maquina
contractora-pectoral|Contractora de pecho (pec deck)|pectoral||aislamiento|aduccion_h|maquina|bilateral_guiado|variable|1|2.5|reducido|ninguna|0|contractora;pec deck;contractora pectoral
press-militar-maquina|Press militar en máquina|deltoides_anterior|triceps|compuesto|empuje_v|maquina|bilateral_guiado|variable|1|2.5|reducido|ninguna|0|press militar
fondos-maquina|Fondos en máquina|triceps|pectoral|compuesto|empuje_v|maquina|bilateral_guiado|variable|1|2.5|reducido|ninguna|0|fondos maquina
fondos|Fondos en paralelas|triceps|pectoral,deltoides_anterior|compuesto|empuje_v|peso_corporal|bilateral_libre|constante|1|2.5|reducido|ninguna|0|fondos propio peso;fondos
elevaciones-laterales-polea|Elevaciones laterales en polea|deltoides_lateral||aislamiento|abduccion_hombro|polea|unilateral_guiado|constante|1|1.25|reducido|ninguna|0|elvs lat polea;elevs lat polea detras;elvs lat polea uni detras espalda
elevaciones-laterales-maquina|Elevaciones laterales en máquina|deltoides_lateral||aislamiento|abduccion_hombro|maquina|bilateral_guiado|variable|1|2.5|reducido|ninguna|0|elevs laq maquina;elvs lat en maquina poleas;elevs lat maquina
elevaciones-laterales-mancuerna|Elevaciones laterales con mancuernas|deltoides_lateral||aislamiento|abduccion_hombro|mancuernas|bilateral_libre|constante|1|1|reducido|ninguna|0|elvs lat sentado manc;elevaciones laterales
extension-triceps-katana|Extensión de tríceps katana en polea|triceps||aislamiento|extension_codo|polea|unilateral_guiado|constante|1|1.25|reducido|ninguna|0|katana;triceps polea alta y katana;katana unilateral
triceps-cuerda|Tríceps en polea con cuerda|triceps||aislamiento|extension_codo|polea|bilateral_guiado|constante|1|2.5|reducido|ninguna|0|triceps cuerda;triceps polea cuerda;triceps polea alta
jm-press-multipower|JM press en multipower|triceps|pectoral|compuesto|extension_codo|multipower|bilateral_guiado|constante|1|2.5|reducido|ninguna|0|jm press;mp jm press
sentadilla-high-bar|Sentadilla high bar|cuadriceps|gluteos,erectores|compuesto|dominante_rodilla|barra|bilateral_libre|constante|1.5|2.5|completo|alta|0|sq hb;sentadilla;sentadilla libre;squat
sentadilla-multipower|Sentadilla en multipower|cuadriceps|gluteos|compuesto|dominante_rodilla|multipower|bilateral_guiado|constante|1.3|2.5|completo|alta|0|sentadilla mp;sq multipower
prensa|Prensa de piernas|cuadriceps|gluteos|compuesto|dominante_rodilla|maquina|bilateral_guiado|constante|1.1|5|completo|baja|0|prensa;hack squat
prensa-unilateral|Prensa unilateral|cuadriceps|gluteos|compuesto|dominante_rodilla|maquina|unilateral_guiado|constante|1|5|reducido|baja|0|prensa uni
extension-cuadriceps|Extensión de cuádriceps|cuadriceps||aislamiento|extension_rodilla|maquina|bilateral_guiado|variable|1|2.5|reducido|ninguna|0|ext cuads;extension cuads
bulgaras-multipower|Búlgaras en multipower|gluteos|cuadriceps|compuesto|dominante_rodilla|multipower|unilateral_guiado|constante|1.1|2.5|reducido|alta|0|bulgaras
hip-thrust|Hip thrust|gluteos|isquios|compuesto|bisagra|barra|bilateral_libre|constante|1.1|2.5|reducido|baja|0|hip thrust
peso-muerto-rumano|Peso muerto rumano|isquios|gluteos,erectores|compuesto|bisagra|barra|bilateral_libre|constante|1.4|2.5|completo|baja|0|rumano;pm rumano
femoral-sentado|Curl femoral sentado|isquios||aislamiento|flexion_rodilla|maquina|bilateral_guiado|variable|1|2.5|reducido|ninguna|0|fem sentado;femoral sentado
femoral-tumbado|Curl femoral tumbado|isquios||aislamiento|flexion_rodilla|maquina|bilateral_guiado|variable|1|2.5|reducido|ninguna|0|fem tumbado
abduccion-maquina|Abducción en máquina|abductores|gluteos|aislamiento|abduccion_cadera|maquina|bilateral_guiado|variable|1|2.5|reducido|ninguna|0|abduccion
aductor-maquina|Aductor en máquina|aductores||aislamiento|aduccion_cadera|maquina|bilateral_guiado|variable|1|2.5|reducido|ninguna|0|aductor;aduccion
gemelo-de-pie|Gemelo de pie|gemelos||aislamiento|flexion_plantar|maquina|bilateral_guiado|constante|1|5|reducido|alta|0|gemelo de pie
gemelo-sentado|Gemelo sentado|gemelos||aislamiento|flexion_plantar|maquina|bilateral_guiado|constante|1|2.5|reducido|alta|0|gemelo sentado
movilidad-tobillo|Movilidad de tobillo|gemelos||core|movilidad|peso_corporal|unilateral_libre|constante|0.3|1|no|baja|0|movilidad tobillo
jalon-prono|Jalón al pecho prono|espalda|biceps|compuesto|traccion_v|polea|bilateral_guiado|constante|1|2.5|completo|ninguna|0|jalon prono;jalon
remo-pecho-apoyado-maquina|Remo con pecho apoyado en máquina|espalda|biceps,deltoides_posterior|compuesto|traccion_h|maquina|bilateral_guiado|variable|1|2.5|reducido|ninguna|0|remo doble raw en maq;remo maquina
remo-hammer-unilateral|Remo Hammer unilateral|espalda|biceps,deltoides_posterior|compuesto|traccion_h|maquina|unilateral_guiado|variable|1|2.5|reducido|ninguna|0|remo hammer
remo-unilateral-polea|Remo unilateral en polea|espalda|biceps,deltoides_posterior|compuesto|traccion_h|polea|unilateral_guiado|constante|1|2.5|reducido|ninguna|0|remo uni polea
pull-over-polea|Pull-over en polea|espalda||aislamiento|extension_hombro|polea|bilateral_guiado|constante|1|2.5|reducido|ninguna|0|pull over barra recta polea;pullover
encogimientos-trapecio|Encogimientos de trapecio|trapecio||aislamiento|elevacion_escapular|mancuernas|bilateral_libre|constante|1|2.5|reducido|ninguna|0|encogimientos
pajaros-deltoide-posterior|Pájaros de deltoides posterior|deltoides_posterior||aislamiento|abduccion_h|mancuernas|bilateral_libre|constante|1|1|reducido|ninguna|0|pajaros
contractora-posterior|Contractora inversa (deltoides posterior)|deltoides_posterior|trapecio|aislamiento|abduccion_h|maquina|bilateral_guiado|variable|1|2.5|reducido|ninguna|0|contractora posterior;co tractora posterior
face-pull|Face pull|deltoides_posterior|trapecio|aislamiento|abduccion_h|polea|bilateral_guiado|constante|1|2.5|reducido|ninguna|0|facepull;cuerda facepull en gironda
curl-barra-z-scott|Curl con barra Z en banco Scott|biceps||aislamiento|flexion_codo|barra|bilateral_libre|constante|1|2.5|reducido|ninguna|0|curl scott
curl-scott-polea|Curl Scott en polea|biceps||aislamiento|flexion_codo|polea|bilateral_guiado|constante|1|2.5|reducido|ninguna|0|curl scott polea
curl-bayesian-unilateral|Curl bayesian unilateral en polea|biceps||aislamiento|flexion_codo|polea|unilateral_guiado|constante|1|1.25|reducido|ninguna|0|bayesian uni polea;curl bayesian uni elevado polea;bayesain uni polea
curl-martillo|Curl martillo|biceps|antebrazo|aislamiento|flexion_codo|mancuernas|bilateral_libre|constante|1|1|reducido|ninguna|0|braquial mancuerna;martillo
curl-inverso-polea|Curl inverso en polea|antebrazo|biceps|aislamiento|flexion_codo|polea|bilateral_guiado|constante|1|2.5|reducido|ninguna|0|curl inverso polea barra
plancha|Plancha frontal y lateral|core||core|anti_extension|peso_corporal|bilateral_libre|constante|0.5|1|no|ninguna|0|plancha
crunch-polea|Crunch en polea|core||core|flexion_tronco|polea|bilateral_guiado|constante|0.6|2.5|no|ninguna|0|crunch polea;crunch
elevacion-piernas-colgado|Elevación de piernas colgado|core||core|flexion_cadera|peso_corporal|bilateral_libre|constante|0.6|1|no|ninguna|0|elevacion piernas;dragonfly
pallof-press|Pallof press|core||core|anti_rotacion|polea|unilateral_guiado|constante|0.5|2.5|no|ninguna|0|pallof
hiperextensiones|Hiperextensiones|erectores|gluteos,isquios|aislamiento|bisagra|peso_corporal|bilateral_libre|constante|0.8|2.5|reducido|ninguna|0|hiperextensiones
dominadas|Dominadas|espalda|biceps|compuesto|traccion_v|peso_corporal|bilateral_libre|constante|1.1|2.5|completo|ninguna|0|dominadas;dominada
peso-muerto|Peso muerto convencional|isquios|gluteos,erectores,espalda|compuesto|bisagra|barra|bilateral_libre|constante|1.5|2.5|completo|baja|0|peso muerto;peso muerto normal
press-inclinado-multipower|Press inclinado en multipower|pectoral|deltoides_anterior,triceps|compuesto|empuje_h|multipower|bilateral_guiado|constante|1.1|2.5|completo|ninguna|0|press incl mp;press incl multipower;multipower press incl;press inclinado mp
z2-bici|Z2 en bici estática|||cardio|cardio|bici|bilateral_guiado|constante|0.3|1|no|ninguna|0|bici;z2 bici
z2-eliptica|Z2 en elíptica|||cardio|cardio|eliptica|bilateral_guiado|constante|0.3|1|no|ninguna|0|eliptica
z2-cinta-inclinada|Z2 andando en cinta inclinada|||cardio|cardio|cinta|bilateral_libre|constante|0.4|1|no|baja|0|z2 cinta inclinada;cinta
carrera|Carrera continua|||cardio|cardio|ninguno|bilateral_libre|constante|0.8|1|no|alta|1|correr;carrera
hiit-bici|HIIT en bici (sin impacto)|||cardio|cardio|bici|bilateral_guiado|constante|0.7|1|no|ninguna|0|hiit bici
ytwl-banco-discos|Y-T-W-L tumbado en banco con discos|deltoides_posterior|trapecio|aislamiento|abduccion_h|discos|bilateral_libre|constante|0.8|1.25|no|ninguna|0|ytwl;y t w l;ytwl con discos|libre
press-militar-hammer|Press militar en máquina Hammer|deltoides_anterior|triceps|compuesto|empuje_v|maquina|bilateral_guiado|variable|1|2.5|reducido|ninguna|0|press militar hammer;press militar en hammer|discos
press-militar-mancuernas|Press militar con mancuernas|deltoides_anterior|triceps,deltoides_lateral|compuesto|empuje_v|mancuernas|bilateral_libre|constante|1.1|2|reducido|ninguna|0|press militar mancuernas;press hombro mancuernas
curl-barra-polea-baja|Curl con barra en polea baja|biceps|antebrazo|aislamiento|flexion_codo|polea|bilateral_guiado|constante|1|2.5|reducido|ninguna|0|curl barra polea;curl polea baja
elevacion-frontal-banco-inclinado|Elevación frontal tumbado en banco inclinado|deltoides_anterior||aislamiento|flexion_hombro|mancuernas|bilateral_libre|constante|0.8|1.25|no|ninguna|0|elevacion frontal en banco;elevaciones frontales banco inclinado
remo-con-barra|Remo con barra|espalda|biceps,deltoides_posterior,erectores|compuesto|traccion_h|barra|bilateral_libre|constante|1.3|2.5|completo|baja|0|remo barra;remo libre con barra
"""

# sesión | slug | series | rep_min | rep_max | RIR | descanso s | calentamiento | tope % | nota
PLAN = """
Torso A|press-banca|4|4|6|2|180|completo||Top set y back-off. Lift estrella.
Torso A|press-inclinado-mancuerna|3|8|10|2|150|reducido||Estiramiento abajo.
Torso A|press-militar-maquina|3|8|10|2|150|reducido||Control.
Torso A|fondos-maquina|3|8|12|1|120|reducido||Profundidad.
Torso A|elevaciones-laterales-polea|4|12|15|1|75|reducido||Tensión continua.
Torso A|extension-triceps-katana|3|10|12|1|75|reducido||Cabeza larga.
Torso A|triceps-cuerda|3|12|15|1|75|no||Abrir abajo.
Pierna A|movilidad-tobillo|3|10|10|4|30|no||Por lado, rango sin dolor. Antes de la sentadilla.
Pierna A|sentadilla-multipower|4|6|8|3|180|completo|75|Profundidad completa sin forzar el tobillo. Tope de carga al 75 % mientras el tobillo esté en vigilancia.
Pierna A|extension-cuadriceps|4|12|15|1|90|reducido||Parciales en la última.
Pierna A|hip-thrust|3|10|12|2|150|reducido||Pausa arriba.
Pierna A|prensa-unilateral|3|10|10|2|120|reducido||Sustituye a las búlgaras mientras moleste el tobillo. Pies altos si tira.
Pierna A|femoral-sentado|3|10|12|1|90|reducido||Pausa arriba.
Pierna A|gemelo-de-pie|4|12|15|1|75|reducido||Bajada de 3 s y pausa abajo. Si duele, fuera.
Cardio + Core|z2-bici|1|35|45|||no||Minutos. Z2 por FC de reserva; bici o elíptica (sin impacto).
Cardio + Core|plancha|3|45|45|||no||Segundos. Frontal y lateral.
Cardio + Core|crunch-polea|3|12|15|2|60|no||Sin flexores de cadera.
Cardio + Core|elevacion-piernas-colgado|3|12|15|2|60|no||Abdomen inferior.
Cardio + Core|pallof-press|3|10|10|3|45|no||Por lado. Anti-rotación.
Torso B|jalon-prono|4|8|10|2|150|completo||Excéntrica controlada.
Torso B|remo-pecho-apoyado-maquina|4|8|10|2|150|reducido||Juntar escápulas.
Torso B|remo-hammer-unilateral|3|10|12|1|120|reducido||Hacia el ombligo.
Torso B|pull-over-polea|3|12|15|1|75|reducido||Estiramiento dorsal.
Torso B|encogimientos-trapecio|3|12|15|1|75|reducido||
Torso B|pajaros-deltoide-posterior|4|15|20|1|60|no||
Torso B|face-pull|3|15|20|1|60|no||Salud postural.
Pierna B|movilidad-tobillo|3|10|10|4|30|no||Por lado, rango sin dolor.
Pierna B|sentadilla-high-bar|4|4|6|3|210|completo||Rodilleras solo en el top set. Si el tobillo dolió al día siguiente de la última pierna, hoy sin top set.
Pierna B|prensa|3|10|12|2|150|reducido||Pies altos si el tobillo tira.
Pierna B|femoral-tumbado|3|10|12|1|90|reducido||
Pierna B|extension-cuadriceps|3|12|15|1|90|no||Fluido.
Pierna B|aductor-maquina|3|12|15|1|75|no||Rango completo.
Pierna B|gemelo-sentado|4|12|15|1|75|reducido||Pausa abajo.
Brazo + Hombro|curl-barra-z-scott|3|8|10|1|90|reducido||Codos fijos.
Brazo + Hombro|curl-bayesian-unilateral|3|12|15|1|75|no||Estiramiento.
Brazo + Hombro|curl-martillo|3|10|12|1|75|no||Braquial.
Brazo + Hombro|triceps-cuerda|3|12|15|1|75|reducido||Abrir abajo.
Brazo + Hombro|extension-triceps-katana|3|12|15|1|75|no||Cabeza larga.
Brazo + Hombro|elevaciones-laterales-mancuerna|4|15|20|0|60|no||Fallo en la última.
"""
FOCUS = {"Torso A": "Fuerza de empuje", "Pierna A": "Cuádriceps y glúteo, tobillo protegido", "Cardio + Core": "Base aeróbica sin impacto",
         "Torso B": "Tirón y hombro", "Pierna B": "Fuerza, sentadilla high bar", "Brazo + Hombro": "Día de disfrute"}

GLOSSARY = [
    ("rir", "RIR (repeticiones en reserva)", "intensidad", "Cuántas repeticiones te quedaban antes del fallo al acabar la serie. RIR 1 = podías una más.", "Se estima con ±1 hasta RIR 3; más lejos del fallo el error sube a 2-3 repeticiones."),
    ("rpe", "RPE (esfuerzo percibido)", "intensidad", "Escala 1-10 del esfuerzo de la serie. RPE = 10 − RIR.", None),
    ("e1rm", "e1RM (1RM estimado)", "intensidad", "Peso que podrías levantar una vez, calculado con la carga y las repeticiones al fallo (reps + RIR).", "Epley hasta 10 repeticiones al fallo; media Epley-Brzycki hasta 15; por encima no se estima."),
    ("serie-efectiva", "Serie efectiva", "volumen", "Serie a 3 o menos del fallo. Las de aproximación no cuentan.", None),
    ("repeticiones-efectivas", "Repeticiones efectivas", "volumen", "Las ~5 últimas repeticiones antes del fallo, que concentran el estímulo.", "Modelo práctico, no medición."),
    ("doble-progresion", "Doble progresión", "intensidad", "Con una carga, suma repeticiones hasta el techo del rango; al llegar en todas las series, sube carga y vuelve al suelo del rango.", None),
    ("srpe", "sRPE (esfuerzo de la sesión)", "recuperacion", "Nota 1-10 de lo dura que fue la sesión entera. Multiplicada por los minutos da la carga de la sesión.", None),
    ("acwr", "ACWR (carga aguda : crónica)", "recuperacion", "Compara la carga de la última semana con la del último mes. Sirve para ver picos de carga.", "Es un semáforo, no una probabilidad de lesión. Aquí se calcula con medias exponenciales (EWMA) por día de calendario."),
    ("ewma", "EWMA (media móvil exponencial)", "recuperacion", "Media que da más peso a los días recientes: λ = 2/(N+1).", None),
    ("tonelaje", "Tonelaje", "volumen", "Suma de kg × repeticiones. Describe el trabajo, no el esfuerzo.", None),
    ("nl", "NL (número de levantamientos)", "volumen", "Repeticiones totales de un ejercicio o sesión.", None),
    ("imr", "IMR (intensidad media relativa)", "intensidad", "Carga media por repetición dividida entre el 1RM.", None),
    ("indice-de-estres", "Índice de estrés", "recuperacion", "Suma por serie según lo cerca del fallo: 1,6 a RIR 0 … 0,6 a RIR 4. Más de 26 en una semana para un grupo es una semana dura.", "Heurística (tabla de Robert Frederick)."),
    ("ref", "REF (ratio estímulo-fatiga del Excel)", "volumen", "Repeticiones entre los puntos de % que faltan hasta el 1RM. Por sesión: 0,4-1,3 bueno y recuperable.", "Descriptivo: no tiene en cuenta el RIR."),
    ("sfr", "SFR (estímulo entre fatiga)", "volumen", "Repeticiones efectivas divididas entre el coste del ejercicio (básico pesado, estabilidad, perfil). Compara ejercicios del mismo músculo.", "Heurística."),
    ("readiness", "Readiness", "recuperacion", "Nota 0-100 del check-in: sueño, estrés, motivación, dolor y fatiga. Por debajo de 50, una más en reserva; por debajo de 30, solo Z2.", None),
    ("descarga", "Descarga (deload)", "recuperacion", "Una semana con un 40 % menos de series, misma carga y 2 repeticiones más en reserva.", "Se propone cuando coinciden dos señales, no por calendario."),
    ("microciclo", "Microciclo", "volumen", "Vuelta completa a todas las sesiones del plan. No tiene por qué durar 7 días.", None),
    ("dia-on-off", "Día On / día Off", "nutricion", "Día de pesas (más calorías, sobre todo hidratos) y día sin pesas (menos). El total de la semana no cambia.", None),
    ("tdee", "TDEE (gasto diario)", "nutricion", "Calorías que gastas al día. Al empezar se estima; a partir de 14 días se mide con lo que comes y lo que cambia tu peso.", None),
    ("tendencia-de-peso", "Tendencia de peso", "nutricion", "Peso suavizado. El dato de un día baila ±1 kg por agua; el ritmo se mide con la tendencia.", None),
    ("semana-de-mantenimiento", "Semana a mantenimiento (diet break)", "nutricion", "Una semana comiendo lo que gastas, para recuperar rendimiento y adherencia.", "No acelera la pérdida de grasa; ayuda a sostenerla."),
    ("z2", "Zona 2", "cardio", "Cardio suave: puedes hablar. 55-70 % de tu frecuencia cardiaca de reserva.", "Con el tobillo en vigilancia: bici o elíptica."),
    ("fc-reserva", "FC de reserva (Karvonen)", "cardio", "FC máxima menos FC en reposo. Las zonas se calculan como un % de esa reserva más la FC en reposo.", "FC máxima estimada: 208 − 0,7 × edad."),
    ("neat", "NEAT (pasos)", "cardio", "Lo que gastas moviéndote fuera del entreno. En déficit es lo primero que se sube.", None),
    ("ecos", "ECOS", "cardio", "Carga del cardio: minutos × factor de zona.", None),
    ("corte-de-cafeina", "Corte de cafeína", "recuperacion", "Última hora para tomar cafeína: 9 horas antes de acostarte.", "400 mg a 6 h de dormir ya alteran el sueño."),
    ("poms", "POMS (perfil de estados de ánimo)", "recuperacion", "Cuestionario de 52 adjetivos. Perfil «iceberg» (vigor alto, lo demás bajo) = bien; invertido = alerta.", "Chequeo ocasional; el diario es el check-in."),
    ("regla-del-tobillo", "Regla del tobillo", "recuperacion", "Con dolor por encima de 3: cero carrera, saltos y HIIT con impacto; Z2 en bici o elíptica; sentadilla guiada con tope del 75 %.", "Si duele al día siguiente de pierna, fuera el top set de la próxima."),
]


# Alias sacados de los nombres en texto libre del histórico (frecuentes y con erratas).
EXTRA_ALIASES = {
    "femoral-tumbado": ["femoral echado", "fem echado", "femoral tumbado"],
    "femoral-sentado": ["fem sentadi"],
    "elevaciones-laterales-polea": ["elvs lat", "elcs lat", "elevs lat", "elvs lat uni", "elvs lat uni detras polea", "elvs lat doble polea", "elevs lat polea doble"],
    "elevaciones-laterales-maquina": ["elvs lat maq polea", "elvs lat maq"],
    "gemelo-de-pie": ["gemelo", "gemelo maq"],
    "curl-bayesian-unilateral": ["bayesian", "bayesian uni", "bayesian doble", "curl doble polea bayesian"],
    "curl-inverso-polea": ["curl inverso", "curl inverso barra z"],
    "contractora-posterior": ["cobtractora posteruir", "posterior en polea", "contractora post"],
    "contractora-pectoral": ["contrac", "contractora pecho"],
    "press-banca": ["banca"],
    "encogimientos-trapecio": ["trapecio", "multipower trapecio", "barra hexagonal trapecio"],
    "crunch-polea": ["abs cuerda", "abs polea"],
    "remo-unilateral-polea": ["remo polea"],
    "sentadilla-high-bar": ["sq raw", "sentsdilla high bar", "high bar"],
    "curl-martillo": ["braquial", "braquial mancudnra"],
    "remo-hammer-unilateral": ["iso lateral hammer"],
    "jm-press-multipower": ["guillotina", "triceps guillotina", "trigeps guillotina"],
    "press-inclinado-hammer": ["press maquina hammer superior"],
}

rows = lambda s: [l.split("|") for l in s.strip().splitlines()]
muscles = [dict(id=r[0], name=r[1], region=r[2], default_mev=float(r[3]), default_mrv=float(r[4]), half_life_h=int(r[5]),
                source="Gorilangel VOL SEMANAL" if r[6] else "valor de arranque") for r in rows(MUSCLES)]
exercises = []
for r in rows(EX):
    exercises.append(dict(slug=r[0], name=r[1], aliases=[a for a in r[14].split(";") if a], primary_muscle=r[2] or None,
                          secondary_muscles=[x for x in r[3].split(",") if x], kind=r[4], movement_pattern=r[5], equipment=r[6] or None,
                          stability=r[7], resistance_profile=r[8], stretch_bias=False, base_cost=float(r[9]), load_step=float(r[10]),
                          per_side="unilateral" in r[7], warmup_kind=r[11], ankle_load=r[12], impact=r[13] == "1", video_urls=[], cues=None,
                          **({"equipment_type": r[15]} if len(r) > 15 and r[15] else {})))
for e in exercises:
    e["aliases"] += [a for a in EXTRA_ALIASES.get(e["slug"], []) if a not in e["aliases"]]
assert set(EXTRA_ALIASES) <= {e["slug"] for e in exercises}
slugs = {e["slug"] for e in exercises}
sessions, order = {}, []
for r in rows(PLAN):
    assert r[1] in slugs, r[1]
    if r[0] not in sessions:
        sessions[r[0]] = []; order.append(r[0])
    i = lambda x: int(x) if x else None
    sessions[r[0]].append(dict(exercise=r[1], sets=int(r[2]), rep_min=i(r[3]), rep_max=i(r[4]), rir_target=float(r[5]) if r[5] else None,
                               rest_seconds=i(r[6]), tempo="controlado", warmup_kind=r[7], technique=None, load_cap_pct=i(r[8]), notes=r[9] or None))
sess = [dict(name=n, focus=FOCUS[n], is_rest=False, is_cardio=n.startswith("Cardio"), planned_minutes=60 if n.startswith("Cardio") else 85, exercises=sessions[n]) for n in order]
sess.append(dict(name="Descanso", focus="Pasos y caminar", is_rest=True, is_cardio=False, planned_minutes=0, exercises=[]))
program = dict(slug="torso-pierna-6d", name="Torso / pierna 6 días (plan de la app, tobillo protegido)", goal="definicion",
               source="Plan de SISTEMA-ALEX-APP de junio de 2026 + ajustes de tobillo de julio (VIDA/entrenamiento/rutina.md y lesiones.md)",
               mesocycles=[dict(name="Definición · bloque 1", block_type="hipertrofia", focus="intensidad", microcycle_days=7, microcycles_planned=6, sessions=sess)])
glossary = [dict(slug=g[0], term=g[1], category=g[2], definition=g[3], notes=g[4], source="Motor de la app") for g in GLOSSARY]

os.makedirs(os.path.join(out, "programs"), exist_ok=True)
w = lambda n, o: json.dump(o, open(os.path.join(out, n), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
w("muscle_groups.json", muscles); w("exercises.base.json", exercises); w("glossary.base.json", glossary); w("programs/torso-pierna-6d.json", program)
print(len(muscles), "grupos |", len(exercises), "ejercicios |", len(glossary), "términos |", [(s["name"], len(s["exercises"])) for s in sess])
