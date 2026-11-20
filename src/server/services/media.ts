/**
 * Medios: vídeos de entreno y fotos de progreso. La app guarda los metadatos; el fichero vive en Google Drive.
 * Sin Drive configurado la fila queda como 'pendiente' y se dice claro que el fichero no se ha guardado.
 */
import { z } from "zod";
import { withUser, type Db, type Tx } from "@/db/client";
import { ensureFolderPath, isDriveConfigured, missingDriveEnv, uploadFile, type DriveOptions } from "@/server/drive";
import { AppError, notFound } from "@/server/errors";
import { todayIn } from "@/server/time";
import { Id, IsoDate, IsoDateTime, athleteTz, parseInput, toIso } from "./annotations";

export const DRIVE_APP_FOLDER = "Sistema Físico";
export const PHOTO_POSES = ["frontal", "lateral", "trasera", "otra"] as const;

/* ------------------------------- Rutas en Drive ------------------------------- */

/** Nombre de carpeta legible: sin caracteres que rompen rutas, sin espacios dobles. */
function folderName(s: string, fallback: string): string {
  const t = String(s ?? "").normalize("NFC").replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .split(/\s+/).filter((w) => w && !/^\.+$/.test(w)).join(" ") // fuera «.» y «..»: nada de subir de carpeta
    .replace(/^\.+|\.+$/g, "").slice(0, 80).trim();
  return t || fallback;
}
/** Trozo de nombre de fichero: minúsculas, sin acentos, con guiones. */
function fileSlug(s: string, fallback: string): string {
  const t = String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
  return t || fallback;
}
const cleanExt = (ext: string | undefined, fallback: string) => (ext ?? "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5) || fallback;

export type MediaPath = { folders: string[]; fileName: string; path: string };

export function buildVideoPath(i: { macrocycleName: string; exerciseName: string; date: string; kg?: number | null; reps?: number | null; ext?: string }): MediaPath {
  const folders = [DRIVE_APP_FOLDER, folderName(i.macrocycleName, "Sin macrociclo"), "Vídeos", folderName(i.exerciseName, "Ejercicio")];
  const kg = i.kg != null && Number.isFinite(i.kg) ? `${Math.round(i.kg * 100) / 100}kg` : "";
  const reps = i.reps != null && Number.isFinite(i.reps) ? `x${Math.round(i.reps)}` : "";
  const fileName = `${[i.date, fileSlug(i.exerciseName, "ejercicio"), kg + reps].filter(Boolean).join("_")}.${cleanExt(i.ext, "mp4")}`;
  return { folders, fileName, path: [...folders, fileName].join("/") };
}

export function buildPhotoPath(i: { macrocycleName: string; date: string; pose: string; ext?: string }): MediaPath {
  const folders = [DRIVE_APP_FOLDER, folderName(i.macrocycleName, "Sin macrociclo"), "Fotos"];
  const fileName = `${i.date}_${fileSlug(i.pose, "otra")}.${cleanExt(i.ext, "jpg")}`;
  return { folders, fileName, path: [...folders, fileName].join("/") };
}

const EXT_BY_MIME: Record<string, string> = {
  "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm", "video/x-matroska": "mkv", "video/3gpp": "3gp",
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "image/heif": "heif",
};
const extOf = (file: UploadFile) => EXT_BY_MIME[file.mimeType.toLowerCase()] ?? (/\.([A-Za-z0-9]{2,5})$/.exec(file.name ?? "")?.[1]);

export type UploadFile = { name?: string; mimeType: string; body: ReadableStream<Uint8Array> | Buffer | Uint8Array };
export type UploadStatus = "subido" | "pendiente" | "error";

/* ----------------------------------- Vídeos ----------------------------------- */

export type Video = {
  id: string;
  workoutId: string | null;
  workoutSetId: string | null;
  exerciseId: string | null;
  exerciseName: string | null;
  recordedAt: string;
  driveFileId: string | null;
  driveUrl: string | null;
  drivePath: string | null;
  status: UploadStatus;
  angle: string | null;
  kg: number | null;
  reps: number | null;
  rir: number | null;
  kneeSleeves: boolean | null;
  belt: boolean | null;
  straps: boolean | null;
  caffeineMg: number | null;
  tags: string[];
  techniqueNotes: string | null;
};

type VideoRow = {
  id: string; workout_id: string | null; workout_set_id: string | null; exercise_id: string | null; exercise_name?: string | null; recorded_at: Date | string;
  drive_file_id: string | null; drive_url: string | null; drive_path: string | null; status: UploadStatus; angle: string | null; kg: number | null;
  reps: number | null; rir: number | null; knee_sleeves: boolean | null; belt: boolean | null; straps: boolean | null; caffeine_mg: number | null;
  tags: string[]; technique_notes: string | null;
};

const toVideo = (r: VideoRow, exerciseName?: string | null): Video => ({
  id: r.id, workoutId: r.workout_id, workoutSetId: r.workout_set_id, exerciseId: r.exercise_id, exerciseName: exerciseName ?? r.exercise_name ?? null,
  recordedAt: toIso(r.recorded_at)!, driveFileId: r.drive_file_id, driveUrl: r.drive_url, drivePath: r.drive_path, status: r.status, angle: r.angle,
  kg: r.kg, reps: r.reps, rir: r.rir, kneeSleeves: r.knee_sleeves, belt: r.belt, straps: r.straps, caffeineMg: r.caffeine_mg, tags: r.tags ?? [],
  techniqueNotes: r.technique_notes,
});

export const RegisterVideoInput = z.object({
  workoutId: Id.optional().describe("Id de la sesión a la que pertenece el vídeo."),
  workoutSetId: Id.optional().describe("Id de la serie grabada: de ella salen kg, repeticiones y RIR si no se indican."),
  exerciseId: Id.optional().describe("Id del ejercicio grabado."),
  kg: z.number().min(0).max(1000).optional().describe("Kilos de la serie."),
  reps: z.number().int().min(0).max(200).optional().describe("Repeticiones de la serie."),
  rir: z.number().min(0).max(10).optional().describe("Repeticiones en reserva."),
  angle: z.string().trim().max(40).optional().describe("Ángulo de cámara (lateral, frontal, 45°…)."),
  kneeSleeves: z.boolean().optional().describe("Con rodilleras."),
  belt: z.boolean().optional().describe("Con cinturón."),
  straps: z.boolean().optional().describe("Con straps."),
  caffeineMg: z.number().int().min(0).max(1000).optional().describe("Cafeína tomada antes de la sesión, en mg."),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional().describe("Etiquetas libres."),
  techniqueNotes: z.string().trim().max(2000).optional().describe("Notas de técnica."),
  driveFileId: z.string().trim().max(200).optional().describe("Id del fichero en Drive, si ya está subido."),
  driveUrl: z.string().trim().max(500).optional().describe("Enlace al fichero en Drive."),
  drivePath: z.string().trim().max(500).optional().describe("Ruta del fichero dentro de Drive."),
  recordedAt: IsoDateTime.optional().describe("Cuándo se grabó (ISO 8601). Por defecto, ahora."),
});
export type RegisterVideoInput = z.input<typeof RegisterVideoInput>;
type VideoIn = z.output<typeof RegisterVideoInput>;

type VideoContext = { meta: VideoIn; exerciseName: string | null; macrocycleName: string | null; date: string };

/** Completa lo que falta con la serie y la sesión, y saca los nombres para la ruta de Drive. */
async function videoContextTx(tx: Tx, i: VideoIn): Promise<VideoContext> {
  const meta = { ...i };
  if (i.workoutSetId) {
    const s = (await tx.query<{ workout_id: string; exercise_id: string | null; kg: number | null; reps: number | null; rir: number | null }>(
      "select workout_id, exercise_id, kg, reps, rir from fit.workout_sets where id = $1::uuid", [i.workoutSetId]))[0];
    if (!s) throw notFound("La serie");
    meta.workoutId ??= s.workout_id;
    meta.exerciseId ??= s.exercise_id ?? undefined;
    meta.kg ??= s.kg ?? undefined;
    meta.reps ??= s.reps ?? undefined;
    meta.rir ??= s.rir ?? undefined;
  }
  let date: string | null = null;
  let macrocycleName: string | null = null;
  if (meta.workoutId) {
    const w = (await tx.query<{ date: string; knee_sleeves: boolean; belt: boolean; straps: boolean; caffeine_mg: number | null; macro: string | null }>(
      `select w.date, w.knee_sleeves, w.belt, w.straps, w.caffeine_mg, ma.name as macro
         from fit.workouts w
         left join fit.microcycles mi on mi.id = w.microcycle_id
         left join fit.mesocycles me on me.id = mi.mesocycle_id
         left join fit.macrocycles ma on ma.id = me.macrocycle_id
        where w.id = $1::uuid`, [meta.workoutId]))[0];
    if (!w) throw notFound("La sesión");
    date = w.date;
    macrocycleName = w.macro;
    meta.kneeSleeves ??= w.knee_sleeves;
    meta.belt ??= w.belt;
    meta.straps ??= w.straps;
    meta.caffeineMg ??= w.caffeine_mg ?? undefined;
  }
  let exerciseName: string | null = null;
  if (meta.exerciseId) {
    const e = (await tx.query<{ name: string }>("select name from fit.exercises where id = $1::uuid", [meta.exerciseId]))[0];
    if (!e) throw notFound("El ejercicio");
    exerciseName = e.name;
  }
  macrocycleName ??= await activeMacrocycleTx(tx);
  const tz = await athleteTz(tx);
  date ??= todayIn(tz, i.recordedAt ? new Date(i.recordedAt) : new Date());
  return { meta, exerciseName, macrocycleName, date };
}

async function activeMacrocycleTx(tx: Tx): Promise<string | null> {
  const r = await tx.query<{ name: string }>("select name from fit.macrocycles where status = 'activo' order by start_date desc, created_at desc limit 1");
  return r[0]?.name ?? null;
}

async function insertVideoTx(tx: Tx, userId: string, c: VideoContext, status: UploadStatus): Promise<Video> {
  const m = c.meta;
  const rows = await tx.query<VideoRow>(
    `insert into fit.videos (user_id, workout_id, workout_set_id, exercise_id, recorded_at, drive_file_id, drive_url, drive_path, status, angle, kg, reps, rir,
       knee_sleeves, belt, straps, caffeine_mg, tags, technique_notes)
     values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, coalesce($5::timestamptz, now()), $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::text[], $19)
     returning *`,
    [userId, m.workoutId ?? null, m.workoutSetId ?? null, m.exerciseId ?? null, m.recordedAt ? new Date(m.recordedAt).toISOString() : null,
      m.driveFileId ?? null, m.driveUrl ?? null, m.drivePath ?? null, status, m.angle ?? null, m.kg ?? null, m.reps ?? null, m.rir ?? null,
      m.kneeSleeves ?? null, m.belt ?? null, m.straps ?? null, m.caffeineMg ?? null, m.tags ?? [], m.techniqueNotes ?? null],
  );
  return toVideo(rows[0], c.exerciseName);
}

/** Guarda los metadatos de un vídeo. Kg, repeticiones, RIR y material salen de la serie y la sesión si no se indican. */
export async function registerVideo(userId: string, input: RegisterVideoInput, db?: Db): Promise<Video> {
  const i = parseInput(RegisterVideoInput, input);
  return withUser(userId, async (tx) => insertVideoTx(tx, userId, await videoContextTx(tx, i), i.driveFileId ? "subido" : "pendiente"), db);
}

export type UploadVideoResult = { video: Video; status: UploadStatus; message: string; missing: string[] };

const NOT_CONFIGURED = "Drive no está configurado: queda apuntado como pendiente, pero el fichero NO se ha guardado. Súbelo otra vez cuando Drive esté conectado.";

/** Sube el vídeo a Drive (Sistema Físico/<macrociclo>/Vídeos/<ejercicio>/) y guarda sus metadatos. */
export async function uploadVideo(userId: string, meta: RegisterVideoInput, file: UploadFile, db?: Db, opts: DriveOptions = {}): Promise<UploadVideoResult> {
  const i = parseInput(RegisterVideoInput, meta);
  const ctx = await withUser(userId, (tx) => videoContextTx(tx, i), db);
  const p = buildVideoPath({ macrocycleName: ctx.macrocycleName ?? "", exerciseName: ctx.exerciseName ?? "", date: ctx.date, kg: ctx.meta.kg, reps: ctx.meta.reps, ext: extOf(file) });
  ctx.meta.drivePath = p.path;
  const save = (status: UploadStatus) => withUser(userId, (tx) => insertVideoTx(tx, userId, ctx, status), db);

  if (!isDriveConfigured()) return { video: await save("pendiente"), status: "pendiente", message: NOT_CONFIGURED, missing: missingDriveEnv() };
  try {
    const parentId = await ensureFolderPath(p.folders, opts);
    const up = await uploadFile({ name: p.fileName, mimeType: file.mimeType, body: file.body, parentId }, opts);
    ctx.meta.driveFileId = up.id;
    ctx.meta.driveUrl = up.webViewLink ?? undefined;
  } catch (e) {
    if (!(e instanceof AppError) || e.code !== "externo") throw e;
    return { video: await save("error"), status: "error", message: `${e.message} El fichero no se ha guardado.`, missing: [] };
  }
  return { video: await save("subido"), status: "subido", message: `Subido a ${p.path}.`, missing: [] };
}

export const ListVideosInput = z.object({
  exerciseId: Id.optional().describe("Solo los vídeos de este ejercicio."),
  limit: z.number().int().min(1).max(200).optional().describe("Máximo de vídeos. Por defecto, 50."),
});
export type ListVideosInput = z.input<typeof ListVideosInput>;

export async function listVideos(userId: string, input: ListVideosInput = {}, db?: Db): Promise<Video[]> {
  const i = parseInput(ListVideosInput, input);
  return withUser(userId, async (tx) => {
    const rows = await tx.query<VideoRow>(
      `select v.*, e.name as exercise_name from fit.videos v left join fit.exercises e on e.id = v.exercise_id
        where ($1::uuid is null or v.exercise_id = $1::uuid) order by v.recorded_at desc limit $2::int`,
      [i.exerciseId ?? null, i.limit ?? 50],
    );
    return rows.map((r) => toVideo(r));
  }, db);
}

/* ------------------------------------ Fotos ------------------------------------ */

export type ProgressPhoto = {
  id: string;
  date: string;
  pose: (typeof PHOTO_POSES)[number];
  driveFileId: string | null;
  driveUrl: string | null;
  drivePath: string | null;
  note: string | null;
};

type PhotoRow = { id: string; date: string; pose: ProgressPhoto["pose"]; drive_file_id: string | null; drive_url: string | null; drive_path: string | null; note: string | null };
const toPhoto = (r: PhotoRow): ProgressPhoto => ({ id: r.id, date: r.date, pose: r.pose, driveFileId: r.drive_file_id, driveUrl: r.drive_url, drivePath: r.drive_path, note: r.note });

export const RegisterPhotoInput = z.object({
  date: IsoDate.optional().describe("Día de la foto (AAAA-MM-DD). Por defecto, hoy."),
  pose: z.enum(PHOTO_POSES).describe("Pose: frontal, lateral, trasera u otra."),
  driveFileId: z.string().trim().max(200).optional().describe("Id del fichero en Drive, si ya está subido."),
  driveUrl: z.string().trim().max(500).optional().describe("Enlace al fichero en Drive."),
  drivePath: z.string().trim().max(500).optional().describe("Ruta del fichero dentro de Drive."),
  note: z.string().trim().max(1000).optional().describe("Nota libre (luz, hora, en ayunas…)."),
});
export type RegisterPhotoInput = z.input<typeof RegisterPhotoInput>;

async function insertPhotoTx(tx: Tx, userId: string, i: z.output<typeof RegisterPhotoInput>, date: string): Promise<ProgressPhoto> {
  const rows = await tx.query<PhotoRow>(
    "insert into fit.progress_photos (user_id, date, pose, drive_file_id, drive_url, drive_path, note) values ($1::uuid, $2::date, $3, $4, $5, $6, $7) returning *",
    [userId, date, i.pose, i.driveFileId ?? null, i.driveUrl ?? null, i.drivePath ?? null, i.note ?? null],
  );
  return toPhoto(rows[0]);
}

export async function registerPhoto(userId: string, input: RegisterPhotoInput, db?: Db): Promise<ProgressPhoto> {
  const i = parseInput(RegisterPhotoInput, input);
  return withUser(userId, async (tx) => insertPhotoTx(tx, userId, i, i.date ?? todayIn(await athleteTz(tx))), db);
}

export type UploadPhotoResult = { photo: ProgressPhoto; status: UploadStatus; message: string; missing: string[] };

/** Sube la foto a Drive (Sistema Físico/<macrociclo>/Fotos/AAAA-MM-DD_<pose>.jpg) y la registra con registerPhoto. */
export async function uploadPhoto(userId: string, meta: RegisterPhotoInput, file: UploadFile, db?: Db, opts: DriveOptions = {}): Promise<UploadPhotoResult> {
  const i = parseInput(RegisterPhotoInput, meta);
  const ctx = await withUser(userId, async (tx) => ({ date: i.date ?? todayIn(await athleteTz(tx)), macro: await activeMacrocycleTx(tx) }), db);
  const p = buildPhotoPath({ macrocycleName: ctx.macro ?? "", date: ctx.date, pose: i.pose, ext: extOf(file) });
  const base = { ...i, date: ctx.date, drivePath: p.path };
  if (!isDriveConfigured()) return { photo: await registerPhoto(userId, base, db), status: "pendiente", message: NOT_CONFIGURED, missing: missingDriveEnv() };
  try {
    const parentId = await ensureFolderPath(p.folders, opts);
    const up = await uploadFile({ name: p.fileName, mimeType: file.mimeType, body: file.body, parentId }, opts);
    const photo = await registerPhoto(userId, { ...base, driveFileId: up.id, driveUrl: up.webViewLink ?? undefined }, db);
    return { photo, status: "subido", message: `Subida a ${p.path}.`, missing: [] };
  } catch (e) {
    if (!(e instanceof AppError) || e.code !== "externo") throw e;
    return { photo: await registerPhoto(userId, base, db), status: "error", message: `${e.message} El fichero no se ha guardado.`, missing: [] };
  }
}

export const ListPhotosInput = z.object({
  pose: z.enum(PHOTO_POSES).optional().describe("Solo las de esta pose."),
  limit: z.number().int().min(1).max(200).optional().describe("Máximo de fotos. Por defecto, 60."),
});
export type ListPhotosInput = z.input<typeof ListPhotosInput>;

export async function listPhotos(userId: string, input: ListPhotosInput = {}, db?: Db): Promise<ProgressPhoto[]> {
  const i = parseInput(ListPhotosInput, input);
  return withUser(userId, async (tx) => {
    const rows = await tx.query<PhotoRow>(
      "select * from fit.progress_photos where ($1::text is null or pose = $1) order by date desc, created_at desc limit $2::int", [i.pose ?? null, i.limit ?? 60]);
    return rows.map(toPhoto);
  }, db);
}

/* ------------------------------ Material y cafeína ------------------------------ */

export const GearPatternsInput = z.object({
  exerciseId: Id.describe("Id del ejercicio que se analiza."),
});
export type GearPatternsInput = z.input<typeof GearPatternsInput>;

/** Hacen falta al menos estas sesiones a cada lado para decir algo. */
export const GEAR_MIN_SESSIONS = 3;

export type GearGroup = { n: number; avgE1rm: number | null };
export type GearComparison = {
  factor: "rodilleras" | "cinturon" | "cafeina";
  with: GearGroup;
  without: GearGroup;
  diffPct: number | null;
  enoughData: boolean;
  /** null si no hay datos suficientes: no se concluye nada. */
  conclusion: string | null;
};
export type GearPatternsResult = { exerciseId: string; sessions: number; enoughData: boolean; comparisons: GearComparison[] };

/** Compara el mejor e1RM de cada sesión con y sin rodilleras, cinturón y cafeína. Es una asociación, no una prueba. */
export async function gearPatterns(userId: string, input: GearPatternsInput, db?: Db): Promise<GearPatternsResult> {
  const i = parseInput(GearPatternsInput, input);
  return withUser(userId, async (tx) => {
    const rows = await tx.query<{ best: number; knee_sleeves: boolean; belt: boolean; caffeine: boolean }>(
      `select max(s.e1rm) as best, w.knee_sleeves, w.belt, (coalesce(w.caffeine_mg, 0) > 0) as caffeine
         from fit.workout_sets s join fit.workouts w on w.id = s.workout_id
        where s.exercise_id = $1::uuid and s.e1rm is not null and s.set_type <> 'aproximacion' and w.status <> 'saltada'
        group by w.id, w.knee_sleeves, w.belt, w.caffeine_mg`,
      [i.exerciseId],
    );
    const labels = { rodilleras: "Con rodilleras", cinturon: "Con cinturón", cafeina: "Con cafeína" } as const;
    const compare = (factor: GearComparison["factor"], on: (r: (typeof rows)[number]) => boolean): GearComparison => {
      const group = (xs: number[]): GearGroup => ({ n: xs.length, avgE1rm: xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null });
      const a = group(rows.filter(on).map((r) => r.best));
      const b = group(rows.filter((r) => !on(r)).map((r) => r.best));
      const enoughData = a.n >= GEAR_MIN_SESSIONS && b.n >= GEAR_MIN_SESSIONS;
      const diffPct = enoughData && b.avgE1rm ? Math.round(((a.avgE1rm! - b.avgE1rm) / b.avgE1rm) * 1000) / 10 : null;
      const conclusion = diffPct == null ? null
        : Math.abs(diffPct) < 1 ? `${labels[factor]} o sin ello, tu mejor e1RM por sesión es prácticamente el mismo (${a.n} sesiones frente a ${b.n}).`
        : `${labels[factor]}, tu mejor e1RM por sesión es un ${String(Math.abs(diffPct)).replace(".", ",")} % ${diffPct > 0 ? "más alto" : "más bajo"} (${a.n} sesiones frente a ${b.n}). Es una asociación, no una prueba.`;
      return { factor, with: a, without: b, diffPct, enoughData, conclusion };
    };
    const comparisons = [compare("rodilleras", (r) => r.knee_sleeves), compare("cinturon", (r) => r.belt), compare("cafeina", (r) => r.caffeine)];
    return { exerciseId: i.exerciseId, sessions: rows.length, enoughData: comparisons.some((c) => c.enoughData), comparisons };
  }, db);
}
