"""Extrae el programa de Gorilangel (Excel) a semillas JSON: plantilla de programa, ejercicios y glosario.

Uso: python -I -X utf8 scripts/extract_gorilangel.py <carpeta_con_el_xlsx> <carpeta_salida>
El Excel no se guarda en el repo. Se exporta solo la estructura del programa (ejercicios, rangos, notas técnicas);
las cargas anotadas en él son de otra persona y no salen de aquí.
"""
import datetime as dt
import json
import os
import re
import sys
import unicodedata
import warnings

import openpyxl

warnings.filterwarnings("ignore")
src, out = sys.argv[1], sys.argv[2]
path = [os.path.join(src, f) for f in os.listdir(src) if "gorilangel" in f.lower() and f.endswith(".xlsx")][0]
wb = openpyxl.load_workbook(path, data_only=True)


def slug(s):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")[:70]


def rng(v):
    """Excel convirtió '8-10' en fecha (10 de agosto): día-mes es el rango."""
    if isinstance(v, (dt.datetime, dt.date)):
        return (v.day, v.month) if v.day <= v.month else (v.month, v.day)
    if v is None:
        return None
    m = re.findall(r"\d+", str(v))
    if len(m) >= 2:
        return (int(m[0]), int(m[1]))
    if len(m) == 1:
        return (int(m[0]), int(m[0]))
    return None


def rir(v):
    r = rng(v)
    if r is None:
        return None
    return (r[0] + r[1]) / 2


def num(v):
    if isinstance(v, (int, float)):
        return float(v)
    if v is None:
        return None
    m = re.match(r"\s*(\d+(?:[.,]\d+)?)", str(v))
    return float(m.group(1).replace(",", ".")) if m else None


def secs(v):
    if not v:
        return None
    s = str(v).lower()
    n = [float(x.replace(",", ".")) for x in re.findall(r"\d+(?:[.,]\d+)?", s)]
    if not n:
        return None
    avg = sum(n) / len(n)
    return int(avg * 60) if "min" in s else int(avg)


MUSCLE = {
    "biceps": "biceps", "triceps": "triceps", "espalda": "espalda", "deltoides l": "deltoides_lateral",
    "deltoides p": "deltoides_posterior", "deltoides a": "deltoides_anterior", "pectoral": "pectoral",
    "cuadriceps": "cuadriceps", "isquio": "isquios", "gluteo": "gluteos", "aductor": "aductores",
    "abductor": "abductores", "gemelo": "gemelos", "core": "core", "abdom": "core", "trapecio": "trapecio",
    "antebrazo": "antebrazo", "cardio": None, "lumbar": "erectores",
}


def muscles(text):
    t = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode().lower()
    found = []
    for k, v in MUSCLE.items():
        if k in t and v and v not in found:
            found.append((t.index(k), v))
    found.sort()
    return [v for _, v in found]


def classify(name, primary):
    n = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    uni = any(w in n for w in ("unilateral", " uni ", "a una mano", "bulgara", "zancada"))
    guided = any(w in n for w in ("polea", "maquina", " mp", "multipower", "hammer", "smith", "prensa", "hack", "pec dec", "contractora", "jalon", "extension de", "curl femoral", "abduc", "aduc"))
    free_compound = any(w in n for w in ("sentadilla", "peso muerto", "rumano", "press", "remo", "dominada", "fondos", "hip thrust", "zancada", "bulgara", "jalon", "prensa", "hack"))
    stability = ("unilateral_" if uni else "bilateral_") + ("guiado" if guided else "libre")
    kind = "compuesto" if free_compound else "aislamiento"
    leg = primary in ("cuadriceps", "isquios", "gluteos", "gemelos", "aductores", "abductores")
    ankle = "alta" if any(w in n for w in ("sentadilla", "zancada", "bulgara", "gemelo", "talones", "salto")) else ("baja" if leg else "ninguna")
    base = 1.5 if ("sentadilla" in n or "peso muerto" in n) and not guided else 1.2 if "press" in n and "banca" in n else 1.0
    step = 2.5 if any(w in n for w in ("barra", " mp", "multipower", "prensa", "hack", "sentadilla", "peso muerto")) else 1.0 if "mancuerna" in n else 2.5
    equip = "polea" if "polea" in n else "multipower" if (" mp" in n or "multipower" in n) else "maquina" if guided else "mancuernas" if "mancuerna" in n else "barra" if "barra" in n else "otro"
    return dict(kind=kind, stability=stability, resistance_profile="variable" if "polea" in n or "maquina" in n else "constante",
                ankle_load=ankle, base_cost=base, load_step=step, equipment=equip, per_side=uni,
                stretch_bias=any(w in n for w in ("inclinado", "bayesian", "rumano", "oh ", "overhead", "estiramiento", "pull over", "pullover")))


WARM = {"no": "no", "reducido": "reducido", "completo": "completo"}
exercises = {}
micro = []
for ws in wb.worksheets:
    m = re.match(r"MICROCICLO (\d+)$", ws.title.strip())
    if not m:
        continue
    idx = int(m.group(1))
    links = {}
    for row in ws.iter_rows():
        for c in row:
            if c.hyperlink and c.hyperlink.target:
                links.setdefault(c.row, []).append(c.hyperlink.target)
    sessions, cur = [], None
    title = ws["B2"].value
    objective = ws["B3"].value
    for r in range(4, ws.max_row + 1):
        b, c, d = ws.cell(r, 2).value, ws.cell(r, 3).value, ws.cell(r, 4).value
        if isinstance(b, str) and " - " in b and ws.cell(r + 1, 2).value in ("Nº", "N°", "Nº "):
            name, _, focus = b.partition(" - ")
            cur = {"name": name.strip().title(), "focus": focus.strip(), "exercises": []}
            sessions.append(cur)
            continue
        if cur is None or not isinstance(d, str) or not isinstance(c, str) or c.strip().upper() == "GRUPO MUSCULAR DIANA":
            continue
        if c.strip().lower() == "cardio":
            cur.setdefault("cardio_note", str(ws.cell(r, 28).value or d))
            continue
        ms = muscles(c)
        if not ms:
            continue
        name = re.sub(r"\s+", " ", d).strip()
        sl = slug(name)
        reps = rng(ws.cell(r, 7).value)
        sets = int(num(ws.cell(r, 6).value) or 0)
        logged, rirs = [], []
        for k in range(4):
            reps_v, load, rr, tech = (ws.cell(r, 8 + 4 * k + j).value for j in range(4))
            if rr is not None and str(rr).strip().upper() != "N/A":
                x = rir(rr)
                if x is not None:
                    rirs.append(x)
            if isinstance(reps_v, (int, float)) and load is not None:
                kg = num(load)
                if kg is not None:
                    logged.append({"kg": kg, "reps": int(reps_v), "rir": rir(rr), "per_side": "x2" in str(load).lower(),
                                   "technique": None if str(tech).strip().upper() in ("N/A", "NONE") else str(tech)})
        warm = str(ws.cell(r, 5).value or "").strip().lower().split(" ")[0]
        notes = ws.cell(r, 28).value
        if sl not in exercises:
            exercises[sl] = dict(slug=sl, name=name, aliases=[], primary_muscle=ms[0], secondary_muscles=ms[1:],
                                 movement_pattern=None, warmup_kind=WARM.get(warm, "reducido"), impact=False,
                                 video_urls=links.get(r, []), cues=str(notes).strip() if notes else None,
                                 **classify(name, ms[0]))
        cur["exercises"].append({
            "exercise": sl, "sets": sets, "rep_min": reps[0] if reps else None, "rep_max": reps[1] if reps else None,
            "rir_target": min(rirs) if rirs else 1, "rest_seconds": secs(ws.cell(r, 25).value),
            "tempo": str(ws.cell(r, 24).value).strip().lower() if ws.cell(r, 24).value else None,
            "warmup_kind": WARM.get(warm, "reducido"), "technique": None, "load_cap_pct": None,
            "notes": str(notes).strip() if notes else None, "logged": logged,
        })
    sessions = [s for s in sessions if s["exercises"]]
    micro.append({"index": idx, "title": title, "objective": objective, "sessions": sessions})

micro.sort(key=lambda x: x["index"])


def block(ms, name, focus, days):
    base = ms[-1]  # el último microciclo del bloque es el más completo (el volumen sube dentro del bloque)
    sess = []
    for s in base["sessions"]:
        ex = [{k: v for k, v in e.items() if k != "logged"} for e in s["exercises"]]
        sess.append({"name": s["name"], "focus": s["focus"], "is_rest": False, "is_cardio": False, "planned_minutes": 80, "exercises": ex})
    return {"name": name, "block_type": "hipertrofia", "focus": focus, "microcycle_days": days,
            "microcycles_planned": len(ms), "sessions": sess}


b1 = [m for m in micro if m["index"] <= 4]
b2 = [m for m in micro if m["index"] >= 5]
program = {
    "slug": "gorilangel-bro-split", "name": "Bro split · Gorilangel (bloques 1 y 2)", "goal": "definicion",
    "source": "Entrenamiento 1 - Ángel Gorilangel.xlsx (extraído el 2026-11-20)",
    "mesocycles": [block(b1, "Bloque 1 · progresión de intensidad", "intensidad", 7),
                   block(b2, "Bloque 2 · progresión de volumen", "volumen", 14)],
}

# Cargas anotadas en el Excel: referencia para arrancar sin «primera vez».
logged = [{"microcycle": m["index"], "session": s["name"], "exercise": e["exercise"], "sets": e["logged"]}
          for m in micro for s in m["sessions"] for e in s["exercises"] if e["logged"]]

# Glosario
g = wb["GLOSARIO"]
rows = [str(g.cell(r, 2).value).strip() for r in range(3, g.max_row + 1) if g.cell(r, 2).value]
glossary, cur = [], None
for t in rows:
    low = t.lower()
    if low.startswith("definici"):
        cur and cur.update(definition=t.split(":", 1)[1].strip())
    elif low.startswith("notas") or low.startswith("conteo"):
        if cur:
            cur["notes"] = ((cur.get("notes") or "") + " " + t).strip()
    elif t.isupper() or re.match(r"^[A-ZÁÉÍÓÚ0-9¼½ /()\-–]+$", t):
        cur = {"slug": slug(t), "term": t.title() if not re.search(r"\(", t) else t, "category": "tecnica", "definition": None,
               "notes": None, "source": "Glosario de Gorilangel"}
        glossary.append(cur)
glossary = [x for x in glossary if x["definition"]]

a = wb["ANOTACIONES"]
texts = [str(a.cell(r, 2).value).strip() for r in range(3, a.max_row + 1) if a.cell(r, 2).value]
for i, t in enumerate(texts):
    if re.search(r"\((MRV|MEV|MAV|MV)\)$", t) and i + 1 < len(texts):
        glossary.append({"slug": slug(re.search(r"\((\w+)\)", t).group(1)), "term": t, "category": "volumen",
                         "definition": texts[i + 1], "notes": None, "source": "Anotaciones de Gorilangel"})

os.makedirs(os.path.join(out, "programs"), exist_ok=True)
dump = lambda name, obj: json.dump(obj, open(os.path.join(out, name), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
dump("programs/gorilangel-bro-split.json", program)
dump("exercises.gorilangel.json", sorted(exercises.values(), key=lambda e: e["slug"]))
dump("glossary.gorilangel.json", glossary)
# Las cargas anotadas en el Excel son de otra persona: no se exportan.
print("microciclos:", [(m["index"], len(m["sessions"]), sum(len(s["exercises"]) for s in m["sessions"])) for m in micro])
print("ejercicios únicos:", len(exercises), "| con vídeo:", sum(1 for e in exercises.values() if e["video_urls"]))
print("glosario:", len(glossary), "| series anotadas:", sum(len(x["sets"]) for x in logged))
from collections import Counter
print("músculos:", dict(Counter(e["primary_muscle"] for e in exercises.values())))
print("sesiones bloque 2:", [s["name"] for s in program["mesocycles"][1]["sessions"]])
