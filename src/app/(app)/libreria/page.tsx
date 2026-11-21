import type { Metadata } from "next";
import Link from "next/link";
import { IconChevron } from "@/components/icons";
import { Empty, PageHeader } from "@/components/ui";
import { sessionOrLogin } from "@/app/_server/session";
import { getGlossary, listMuscleGroups, searchExercises } from "@/server/services/library";

export const metadata: Metadata = { title: "Librería" };

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v.trim().slice(0, 80) : "");

export default async function LibreriaPage({ searchParams }: PageProps<"/libreria">) {
  const userId = await sessionOrLogin("/libreria");
  const sp = await searchParams;
  const glossary = one(sp.ver) === "glosario";
  const q = one(sp.q);
  const muscle = one(sp.grupo);
  const safe = one(sp.tobillo) === "1";
  const muscles = await listMuscleGroups(userId);
  const validMuscle = muscles.some((m) => m.id === muscle) ? muscle : "";
  const [exercises, terms] = await Promise.all([
    glossary ? Promise.resolve([]) : searchExercises(userId, { ...(q ? { q } : {}), ...(validMuscle ? { muscle: validMuscle } : {}), ...(safe ? { ankleSafe: true } : {}), limit: q || validMuscle ? 80 : 200 }),
    glossary ? getGlossary(userId, q ? { q } : {}) : Promise.resolve([]),
  ]);
  const muscleName = (id: string | null) => muscles.find((m) => m.id === id)?.name ?? id ?? "—";

  return (
    <main className="page">
      <PageHeader title="Librería" back={{ href: "/mas", label: "Más" }} />
      <nav className="grid grid-cols-2 gap-2" aria-label="Sección">
        <Link href="/libreria" className="chip" aria-current={!glossary ? "page" : undefined}>Ejercicios</Link>
        <Link href="/libreria?ver=glosario" className="chip" aria-current={glossary ? "page" : undefined}>Glosario</Link>
      </nav>

      <form method="get" action="/libreria" className="mt-4 grid gap-3" role="search">
        {glossary ? <input type="hidden" name="ver" value="glosario" /> : null}
        <div className="field">
          <label htmlFor="q">{glossary ? "Buscar término" : "Buscar ejercicio"}</label>
          <input id="q" name="q" type="search" className="input" defaultValue={q} placeholder={glossary ? "RIR, descarga, MEV…" : "Da igual tildes y mayúsculas"} autoComplete="off" />
        </div>
        {!glossary ? (
          <>
            <div className="field">
              <label htmlFor="grupo">Grupo muscular</label>
              <select id="grupo" name="grupo" className="input" defaultValue={validMuscle}>
                <option value="">Todos</option>
                {muscles.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </div>
            <label className="flex min-h-12 items-center gap-3">
              <input type="checkbox" name="tobillo" value="1" defaultChecked={safe} className="h-5 w-5 accent-[var(--accent-ink)]" />
              Solo seguros para el tobillo
            </label>
          </>
        ) : null}
        <button type="submit" className="btn">Buscar</button>
      </form>

      <section className="mt-6" aria-label="Resultados">
        {glossary ? (
          terms.length === 0 ? (
            <Empty title="Ningún término con ese texto">Prueba con otra palabra o borra la búsqueda.</Empty>
          ) : (
            <dl>
              {terms.map((t) => (
                <div key={t.slug} className="border-b border-line py-3">
                  <dt className="font-medium">{t.term} <span className="micro faint font-normal">· {t.category}</span></dt>
                  <dd className="small muted mt-1">{t.definition}</dd>
                  {t.notes ? <dd className="micro faint mt-1">{t.notes}</dd> : null}
                </div>
              ))}
            </dl>
          )
        ) : exercises.length === 0 ? (
          <Empty title="Ningún ejercicio con esos filtros">Quita un filtro o busca por otro nombre.</Empty>
        ) : (
          <>
            <p className="fig micro faint mb-1">{exercises.length} ejercicios</p>
            <ul className="rows">
              {exercises.map((e) => (
                <li key={e.id}>
                  <Link href={`/libreria/${e.id}`} className="row">
                    <span className="min-w-0">
                      <span className="block truncate">{e.name}</span>
                      <span className="micro faint">
                        {muscleName(e.primaryMuscle)}{e.equipment ? ` · ${e.equipment.replace(/_/g, " ")}` : ""}
                        {e.ankleLoad === "alta" || e.impact ? <span className="accent"> · carga el tobillo</span> : null}
                      </span>
                    </span>
                    <IconChevron className="flex-none text-fg-3" />
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </main>
  );
}
