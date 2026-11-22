"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { IconScan, IconSearch, IconSwap } from "@/components/icons";
import { Sheet } from "@/components/sheet";
import { Stepper } from "@/components/stepper";
import { scaleMacros } from "@/engine/nutrition";
import { backCameras, pickMainBackCamera, type Cam } from "@/lib/camera";
import { day, int, num, parseNum } from "@/lib/format";
import { isNetworkError, queueAdd } from "@/lib/offline-queue";
import { useQueue } from "@/lib/use-queue";
import type { Food } from "@/server/services/foods";
import type { LogFoodInput, Meal } from "@/server/services/nutrition";
import { createFoodAction, logFoodAction, logMealTemplateAction, repeatMealAction, searchFoodsAction } from "./actions";

type Mode = null | "scan" | "search" | "repeat" | { food: Food } | { create: string };
type Detector = { detect: (src: CanvasImageSource) => Promise<{ rawValue: string }[]> };
const MEALS: { v: Meal | ""; l: string }[] = [
  { v: "", l: "Según la hora" }, { v: "desayuno", l: "Desayuno" }, { v: "comida", l: "Comida" }, { v: "cena", l: "Cena" },
  { v: "pre", l: "Pre-entreno" }, { v: "intra", l: "Intra-entreno" }, { v: "post", l: "Post-entreno" }, { v: "snack", l: "Snack" },
];

export function AddFood({ today, templates, yesterday, yesterdayDate }: {
  today: string;
  templates: { id: string; name: string; kcal: number | null; proteinG: number | null }[];
  yesterday: { meal: Meal; label: string; kcal: number; items: number }[];
  yesterdayDate: string;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const queued = useQueue().filter((q) => q.kind === "food");
  const close = useCallback(() => setMode(null), []);
  const done = (text: string) => {
    setMode(null);
    setMsg(text);
    router.refresh();
  };

  return (
    <section className="mt-7" aria-label="Añadir comida">
      <div className="grid grid-cols-3 gap-2">
        <button type="button" className="btn btn-primary flex-col gap-1 px-1 py-3" onClick={() => setMode("scan")}>
          <IconScan /> Escanear
        </button>
        <button type="button" className="btn flex-col gap-1 px-1 py-3" onClick={() => setMode("search")}>
          <IconSearch /> Buscar
        </button>
        <button type="button" className="btn flex-col gap-1 px-1 py-3" onClick={() => setMode("repeat")}>
          <IconSwap /> Repetir
        </button>
      </div>
      {msg ? <p className="small muted mt-2" role="status">{msg}</p> : null}
      {queued.length ? (
        <ul className="mt-2">
          {queued.map((q) => (
            <li key={q.id} className="fig small flex justify-between border-b border-line py-2 text-fg-2">
              <span className="truncate">{q.label}</span>
              <span className="micro accent flex-none">sin enviar</span>
            </li>
          ))}
        </ul>
      ) : null}

      {mode === "scan" ? (
        <Sheet title="Escanear código" onClose={close}>
          <Scanner onFood={(food) => setMode({ food })} onMissing={(code) => setMode({ create: code })} />
        </Sheet>
      ) : null}
      {mode === "search" ? (
        <Sheet title="Buscar alimento" onClose={close}>
          <Search onPick={(food) => setMode({ food })} onCreate={() => setMode({ create: "" })} />
        </Sheet>
      ) : null}
      {mode === "repeat" ? (
        <Sheet title="Repetir" onClose={close}>
          <Repeat today={today} templates={templates} yesterday={yesterday} yesterdayDate={yesterdayDate} onDone={done} />
        </Sheet>
      ) : null}
      {mode && typeof mode === "object" && "food" in mode ? (
        <Sheet title={mode.food.name} onClose={close}>
          <Grams food={mode.food} onDone={done} />
        </Sheet>
      ) : null}
      {mode && typeof mode === "object" && "create" in mode ? (
        <Sheet title="Alta manual" onClose={close}>
          <CreateFood barcode={mode.create} onCreated={(food) => setMode({ food })} />
        </Sheet>
      ) : null}
    </section>
  );
}

/* ───────────────────────── Gramos y registro ───────────────────────── */

function Grams({ food, onDone }: { food: Food; onDone: (text: string) => void }) {
  const [grams, setGrams] = useState(num(food.servingG ?? 100, 0));
  const [meal, setMeal] = useState<Meal | "">("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const g = parseNum(grams) ?? 0;
  const m = scaleMacros({ kcal: food.kcal100, protein: food.protein100, carbs: food.carbs100, fat: food.fat100 }, g);
  const unit = food.isLiquid ? "ml" : "g";

  const submit = () => {
    if (g <= 0 || g > 5000) return setError(`Pon los ${unit === "ml" ? "mililitros" : "gramos"}.`);
    const input: LogFoodInput = { foodId: food.id, grams: g, ...(meal ? { meal } : {}), ...(food.barcode ? { source: "barcode" as const } : {}), clientId: crypto.randomUUID(), loggedAt: new Date().toISOString() };
    const label = `${food.name} · ${int(g)} ${unit}`;
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      queueAdd("food", input, label);
      return onDone("Sin conexión: guardado en el móvil. Se envía solo al volver la red.");
    }
    start(async () => {
      try {
        const r = await logFoodAction(input);
        if (!r.ok) setError(r.error.message);
        else if (!r.data.saved) setError(r.data.warnings.join(" "));
        else onDone(`Añadido: ${label}.${r.data.warnings.length ? ` ${r.data.warnings.join(" ")}` : ""}`);
      } catch (e) {
        if (isNetworkError(e)) {
          queueAdd("food", input, label);
          onDone("Sin conexión: guardado en el móvil. Se envía solo al volver la red.");
        } else setError("No se pudo guardar. Prueba otra vez.");
      }
    });
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <p className="fig small muted">
        {food.brand ? `${food.brand} · ` : ""}por 100 {unit}: {int(food.kcal100)} kcal · {num(food.protein100)} P · {num(food.carbs100)} H · {num(food.fat100)} G
      </p>
      <div className="mt-4">
        <Stepper label="Cantidad" unit={unit} value={grams} onChange={setGrams} step={10} min={0} max={5000} inputMode="numeric" decimals={0} />
      </div>
      {food.servingG || food.packageG ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {food.servingG ? (
            <button type="button" className="chip" onClick={() => setGrams(num(food.servingG, 0))}>
              {food.servingLabel ?? "Ración"} · {int(food.servingG)} {unit}
            </button>
          ) : null}
          {food.packageG ? (
            <button type="button" className="chip" onClick={() => setGrams(num(food.packageG, 0))}>
              Envase · {int(food.packageG)} {unit}
            </button>
          ) : null}
        </div>
      ) : null}
      <p className="mt-4">
        <span className="display text-[2rem]">{int(m.kcal)}</span> <span className="muted">kcal ·</span> <span className="fig">{num(m.protein)} g P · {num(m.carbs)} H · {num(m.fat)} G</span>
      </p>
      <div className="field mt-4">
        <label htmlFor="meal">Comida</label>
        <select id="meal" className="input" value={meal} onChange={(e) => setMeal(e.target.value as Meal | "")}>
          {MEALS.map((x) => <option key={x.v} value={x.v}>{x.l}</option>)}
        </select>
      </div>
      {error ? <p role="alert" className="err mt-3">{error}</p> : null}
      <button type="submit" className="btn btn-primary btn-lg btn-block mt-4" disabled={pending}>
        {pending ? "Guardando…" : "Añadir"}
      </button>
    </form>
  );
}

/* ───────────────────────── Buscar ───────────────────────── */

function Search({ onPick, onCreate }: { onPick: (f: Food) => void; onCreate: () => void }) {
  const [q, setQ] = useState("");
  const [store, setStore] = useState<"mercadona" | "lidl" | null>(null);
  const [items, setItems] = useState<Food[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const mine = ++seq.current;
    const t = window.setTimeout(() => {
      searchFoodsAction({ q: q.trim(), ...(store ? { store } : {}), limit: 30 })
        .then((r) => {
          if (mine !== seq.current) return;
          if (r.ok) {
            setItems(r.data);
            setError(null);
          } else setError(r.error.message);
        })
        .catch(() => mine === seq.current && setError("Sin conexión: no se puede buscar ahora."));
    }, 220);
    return () => window.clearTimeout(t);
  }, [q, store]);

  return (
    <div>
      <div className="field">
        <label htmlFor="food-q">Nombre o marca</label>
        <input id="food-q" className="input" value={q} autoComplete="off" placeholder="pollo, avena, yogur…" onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2" role="group" aria-label="Tienda">
        <button type="button" className="chip px-1" aria-pressed={store === null} onClick={() => setStore(null)}>Todas</button>
        <button type="button" className="chip px-1" aria-pressed={store === "mercadona"} onClick={() => setStore("mercadona")}>Mercadona</button>
        <button type="button" className="chip px-1" aria-pressed={store === "lidl"} onClick={() => setStore("lidl")}>Lidl</button>
      </div>
      {error ? <p role="alert" className="err mt-3">{error}</p> : null}
      {items == null && !error ? (
        <div className="mt-4 space-y-2" aria-busy="true"><div className="skel h-12" /><div className="skel h-12" /></div>
      ) : items && items.length === 0 ? (
        <div className="mt-4">
          <p className="font-medium">{q.trim() ? "Nada con ese nombre" : "El catálogo está vacío"}</p>
          <p className="small muted mt-1">Escanea el código del envase o da de alta el alimento con su etiqueta.</p>
        </div>
      ) : items ? (
        <ul className="rows mt-3">
          {items.map((f) => (
            <li key={f.id}>
              <button type="button" className="row" onClick={() => onPick(f)}>
                <span className="min-w-0">
                  <span className="block truncate">{f.name}</span>
                  <span className="micro faint">{[f.brand, f.store].filter(Boolean).join(" · ") || "sin marca"}</span>
                </span>
                <span className="fig small flex-none text-right">
                  {int(f.kcal100)} kcal<span className="micro faint block">{num(f.protein100)} g P / 100</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <button type="button" className="btn btn-block mt-4" onClick={onCreate}>
        Alta manual
      </button>
    </div>
  );
}

/* ───────────────────────── Repetir ───────────────────────── */

function Repeat({ today, templates, yesterday, yesterdayDate, onDone }: {
  today: string;
  templates: { id: string; name: string; kcal: number | null; proteinG: number | null }[];
  yesterday: { meal: Meal; label: string; kcal: number; items: number }[];
  yesterdayDate: string;
  onDone: (text: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const go = (fn: () => Promise<string | null>) =>
    start(async () => {
      try {
        const bad = await fn();
        if (bad) setError(bad);
      } catch {
        setError("Sin conexión: repetir una comida necesita red.");
      }
    });
  return (
    <div>
      <h3 className="label mb-1">Comidas ancla</h3>
      {templates.length === 0 ? (
        <p className="small muted">No tienes comidas ancla para este tipo de día. Se crean desde Muse o guardando una comida como plantilla.</p>
      ) : (
        <ul className="rows">
          {templates.map((t) => (
            <li key={t.id}>
              <button type="button" className="row" disabled={pending} onClick={() => go(async () => {
                const r = await logMealTemplateAction({ templateId: t.id });
                if (!r.ok) return r.error.message;
                onDone(`Añadida: ${t.name} (${r.data.copied} alimentos).`);
                return null;
              })}>
                <span className="min-w-0 truncate">{t.name}</span>
                <span className="fig small flex-none">{t.kcal != null ? `${int(t.kcal)} kcal` : "—"}{t.proteinG != null ? ` · ${int(t.proteinG)} g P` : ""}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <h3 className="label mb-1 mt-6">Ayer, {day(yesterdayDate, today)}</h3>
      {yesterday.length === 0 ? (
        <p className="small muted">Ayer no registraste nada.</p>
      ) : (
        <ul className="rows">
          {yesterday.map((y) => (
            <li key={y.meal}>
              <button type="button" className="row" disabled={pending} onClick={() => go(async () => {
                const r = await repeatMealAction({ fromDate: yesterdayDate, meal: y.meal });
                if (!r.ok) return r.error.message;
                if (r.data.problems.length) return r.data.problems.join(" ");
                onDone(`Repetido: ${y.label} de ayer (${r.data.copied} apuntes).`);
                return null;
              })}>
                <span>{y.label}</span>
                <span className="fig small">{int(y.kcal)} kcal · {y.items} {y.items === 1 ? "apunte" : "apuntes"}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {error ? <p role="alert" className="err mt-3">{error}</p> : null}
    </div>
  );
}

/* ───────────────────────── Escáner ───────────────────────── */

/** La cámara que eligió Alex con «Cambiar de cámara». Si no hay, la principal. */
const CAM_KEY = "sf.scanner.cam";
function loadCam(): string | null {
  try {
    return localStorage.getItem(CAM_KEY);
  } catch {
    return null;
  }
}
function saveCam(id: string | null) {
  try {
    if (id) localStorage.setItem(CAM_KEY, id);
    else localStorage.removeItem(CAM_KEY);
  } catch {
    /* sin almacenamiento, se elige cada vez */
  }
}

function Scanner({ onFood, onMissing }: { onFood: (f: Food) => void; onMissing: (code: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [code, setCode] = useState("");
  const [status, setStatus] = useState<"iniciando" | "camara" | "sin_soporte" | "sin_permiso" | "buscando">("iniciando");
  const [error, setError] = useState<string | null>(null);
  const [cams, setCams] = useState<Cam[]>([]);
  const [camId, setCamId] = useState<string | null>(null);
  const [activeCam, setActiveCam] = useState<string | null>(null);
  const busy = useRef(false);

  const lookup = useCallback(async (raw: string) => {
    const clean = raw.replace(/[^0-9]/g, "");
    if (clean.length < 8) return setError("El código tiene al menos 8 cifras.");
    if (busy.current) return;
    busy.current = true;
    setStatus("buscando");
    setError(null);
    try {
      const res = await fetch(`/api/foods/barcode/${encodeURIComponent(clean)}`, { cache: "no-store" });
      const body = (await res.json().catch(() => null)) as { food?: Food; reason?: string; cause?: string; barcode?: string; message?: string } | null;
      if (res.ok && body?.food) return onFood(body.food);
      if (res.status === 404 && body?.cause !== "externo") return onMissing(body?.barcode ?? clean);
      setError(body?.reason ?? body?.message ?? "No se pudo consultar el código.");
    } catch {
      setError("Sin conexión: el código no se puede consultar ahora.");
    }
    busy.current = false;
    setStatus((s) => (s === "buscando" ? "camara" : s));
  }, [onFood, onMissing]);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: number | undefined;
    let alive = true;
    const Ctor = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
    const open = (id: string | null) =>
      navigator.mediaDevices.getUserMedia({ video: id ? { deviceId: { exact: id } } : { facingMode: { ideal: "environment" } }, audio: false });
    (async () => {
      if (!Ctor || !navigator.mediaDevices?.getUserMedia) return setStatus("sin_soporte");
      let s: MediaStream;
      try {
        try {
          s = await open(camId);
        } catch (e) {
          if (!camId) throw e;
          saveCam(null); // la cámara guardada ya no existe: vuelve a la trasera por defecto
          s = await open(null);
        }
      } catch {
        return alive && setStatus("sin_permiso");
      }
      stream = s;
      if (!alive) return s.getTracks().forEach((t) => t.stop());
      const track = s.getVideoTracks()[0];
      const current = track?.getSettings().deviceId ?? null;
      if (camId === null) {
        // Con el permiso ya hay etiquetas. Si el navegador abrió la gran angular (0,5x), que no enfoca de cerca, se cambia a la principal.
        const backs = backCameras(await navigator.mediaDevices.enumerateDevices().catch(() => []));
        if (!alive) return s.getTracks().forEach((t) => t.stop());
        setCams(backs);
        const saved = loadCam();
        const pick = backs.find((c) => c.deviceId === saved) ?? pickMainBackCamera(backs);
        if (pick && current && pick.deviceId !== current) {
          s.getTracks().forEach((t) => t.stop());
          stream = null;
          return setCamId(pick.deviceId);
        }
      }
      setActiveCam(current);
      const caps = (track?.getCapabilities?.() ?? {}) as { focusMode?: string[] };
      if (caps.focusMode?.includes("continuous")) {
        await track.applyConstraints({ advanced: [{ focusMode: "continuous" } as unknown as MediaTrackConstraintSet] }).catch(() => undefined);
      }
      if (!alive || !video.current) return s.getTracks().forEach((t) => t.stop());
      video.current.srcObject = s;
      await video.current.play().catch(() => undefined);
      setStatus("camara");
      const detector = new Ctor({ formats: ["ean_13", "ean_8", "upc_a", "upc_e"] });
      timer = window.setInterval(async () => {
        if (busy.current || !video.current || video.current.readyState < 2) return;
        try {
          const hit = (await detector.detect(video.current))[0];
          if (hit?.rawValue) void lookup(hit.rawValue);
        } catch {
          /* un fotograma ilegible no es un error */
        }
      }, 350);
    })();
    return () => {
      alive = false;
      if (timer) window.clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [lookup, camId]);

  const camIndex = cams.findIndex((c) => c.deviceId === activeCam);
  const nextCam = () => {
    const next = cams[(camIndex + 1) % cams.length];
    if (!next) return;
    saveCam(next.deviceId);
    setStatus("iniciando");
    setCamId(next.deviceId);
  };

  return (
    <div>
      {status !== "sin_soporte" && status !== "sin_permiso" ? (
        <div className="relative aspect-[4/3] w-full overflow-hidden bg-bg">
          <video ref={video} className="h-full w-full object-cover" playsInline muted aria-label="Cámara para leer el código de barras" />
          <div className="pointer-events-none absolute inset-x-8 top-1/2 h-px bg-accent-ink" />
        </div>
      ) : null}
      <p className="small muted mt-2" role="status">
        {status === "iniciando" ? "Abriendo la cámara…" : status === "camara" ? "Apunta al código. Se lee solo." : status === "buscando" ? "Buscando el producto…" : status === "sin_permiso" ? "Sin permiso de cámara. Teclea el código." : "Este navegador no lee códigos con la cámara. Teclea el código."}
      </p>
      {cams.length > 1 && (status === "camara" || status === "iniciando") ? (
        <button type="button" className="link small mt-1" onClick={nextCam}>
          Cambiar de cámara ({camIndex >= 0 ? camIndex + 1 : 1} de {cams.length})
        </button>
      ) : null}
      <form
        className="mt-3 flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void lookup(code);
        }}
      >
        <div className="field flex-1">
          <label htmlFor="barcode">Código de barras</label>
          <input id="barcode" className="input input-fig" inputMode="numeric" autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} placeholder="8410000000000" />
        </div>
        <button type="submit" className="btn flex-none">Buscar</button>
      </form>
      {error ? <p role="alert" className="err mt-3">{error}</p> : null}
    </div>
  );
}

/* ───────────────────────── Alta manual ───────────────────────── */

function CreateFood({ barcode, onCreated }: { barcode: string; onCreated: (f: Food) => void }) {
  const [v, setV] = useState({ name: "", brand: "", barcode, kcal: "", protein: "", carbs: "", fat: "", pack: "", price: "" });
  const [store, setStore] = useState<"mercadona" | "lidl" | "otro" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value });

  const submit = () => {
    const n = { kcal: parseNum(v.kcal), protein: parseNum(v.protein), carbs: parseNum(v.carbs), fat: parseNum(v.fat) };
    if (!v.name.trim()) return setError("Pon el nombre.");
    if (n.kcal == null || n.protein == null || n.carbs == null || n.fat == null) return setError("Faltan las calorías o algún macro por 100 g. Están en la etiqueta.");
    const pack = v.pack.trim() ? parseNum(v.pack) : null;
    const price = v.price.trim() ? parseNum(v.price) : null;
    start(async () => {
      try {
        const r = await createFoodAction({
          name: v.name.trim(), kcal100: n.kcal!, protein100: n.protein!, carbs100: n.carbs!, fat100: n.fat!,
          ...(v.brand.trim() ? { brand: v.brand.trim() } : {}), ...(v.barcode.trim() ? { barcode: v.barcode.trim() } : {}), ...(store ? { store } : {}),
          ...(pack ? { packageG: pack } : {}), ...(price != null ? { priceEur: price } : {}),
        });
        if (r.ok) onCreated(r.data);
        else setError(r.error.message);
      } catch {
        setError("Sin conexión: dar de alta un alimento necesita red.");
      }
    });
  };
  const F = (k: keyof typeof v, label: string, unit?: string, numeric = true) => (
    <div className="field">
      <label htmlFor={`cf-${k}`}>{label}{unit ? <span className="faint"> · {unit}</span> : null}</label>
      <input id={`cf-${k}`} className={`input ${numeric ? "input-fig" : ""}`} inputMode={numeric ? "decimal" : undefined} autoComplete="off" value={v[k]} onChange={set(k)} />
    </div>
  );
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {barcode ? <p className="small muted">Ese código no está en el catálogo ni en Open Food Facts. Copia los datos de la etiqueta.</p> : null}
      {F("name", "Nombre", undefined, false)}
      {F("brand", "Marca (opcional)", undefined, false)}
      <div className="grid grid-cols-2 gap-3">
        {F("kcal", "Calorías", "kcal / 100 g")}
        {F("protein", "Proteína", "g / 100 g")}
        {F("carbs", "Hidratos", "g / 100 g")}
        {F("fat", "Grasa", "g / 100 g")}
        {F("pack", "Envase (opc.)", "g")}
        {F("price", "Precio (opc.)", "€")}
      </div>
      {F("barcode", "Código de barras (opcional)")}
      <div className="grid grid-cols-3 gap-2" role="group" aria-label="Tienda">
        {(["mercadona", "lidl", "otro"] as const).map((s) => (
          <button key={s} type="button" className="chip px-1 capitalize" aria-pressed={store === s} onClick={() => setStore(store === s ? null : s)}>{s === "otro" ? "Otra" : s}</button>
        ))}
      </div>
      {error ? <p role="alert" className="err">{error}</p> : null}
      <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={pending}>
        {pending ? "Guardando…" : "Guardar y elegir cantidad"}
      </button>
    </form>
  );
}
