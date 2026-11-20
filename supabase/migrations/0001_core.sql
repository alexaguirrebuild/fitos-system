-- Sistema Operativo Físico · esquema base
-- Todo vive en el esquema `fit`, que PostgREST no expone: la única puerta es el servidor de la app.
-- Cada tabla de datos lleva user_id y RLS (0003_rls.sql).

create schema if not exists fit;

-- ───────────────────────── Atleta y contexto ─────────────────────────

create table fit.athletes (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  name text,
  sex text not null default 'H' check (sex in ('H','M')),
  birth_date date,
  height_cm numeric(5,1),
  height_confirmed boolean not null default false,       -- 174 vs 164: no se usa en cálculos «firmes» hasta confirmarla
  timezone text not null default 'Europe/Madrid',
  bedtime time,
  wake_time time,
  hr_rest smallint check (hr_rest between 30 and 120),
  adhd boolean not null default false,
  adhd_medication boolean,                               -- solo sí/no: bloquea sugerencias de cafeína a ciegas
  goal_weight_kg numeric(5,2),
  goal_waist_cm numeric(5,1),
  steps_goal int not null default 10000,
  steps_off_extra int not null default 2000,
  weekly_food_budget_eur numeric(7,2),
  stores text[] not null default '{mercadona,lidl}',
  training_level smallint check (training_level between 1 and 4),
  onboarding jsonb not null default '{}'::jsonb,          -- respuestas crudas y qué falta por confirmar
  onboarded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Horario fijo (clases UCM, trabajo) y periodos especiales (exámenes = estresor externo alto).
create table fit.schedule_blocks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references fit.athletes(id) on delete cascade default auth.uid(),
  kind text not null check (kind in ('clase','examen','trabajo','otro')),
  title text not null,
  weekday smallint check (weekday between 0 and 6),       -- 0 = domingo; null si es un periodo por fechas
  start_time time,
  end_time time,
  date_from date,
  date_to date,
  high_stress boolean not null default false,
  created_at timestamptz not null default now()
);

create table fit.injuries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references fit.athletes(id) on delete cascade default auth.uid(),
  zone text not null,                                     -- 'tobillo'
  side text check (side in ('izquierdo','derecho','ambos')),
  started_on date,
  status text not null default 'abierta' check (status in ('abierta','vigilancia','cerrada')),
  limits text,                                            -- en palabras del atleta
  adjustments text,
  closed_on date,
  created_at timestamptz not null default now()
);

create table fit.injury_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references fit.athletes(id) on delete cascade default auth.uid(),
  injury_id uuid not null references fit.injuries(id) on delete cascade,
  date date not null,
  moment text not null default 'dia' check (moment in ('antes','despues','dia_siguiente','dia')),
  pain smallint not null check (pain between 0 and 10),
  note text,
  created_at timestamptz not null default now(),
  unique (injury_id, date, moment)
);

-- ───────────────────────── Librería ─────────────────────────

create table fit.muscle_groups (
  id text primary key,                                    -- 'biceps', 'deltoides_lateral'…
  name text not null,
  region text not null check (region in ('torso','brazo','pierna','core')),
  default_mev numeric(4,1) not null,
  default_mrv numeric(4,1) not null,
  half_life_h smallint not null default 30                -- recuperación estimada (heurística)
);

create table fit.athlete_volume_targets (
  user_id uuid not null references fit.athletes(id) on delete cascade default auth.uid(),
  muscle_id text not null references fit.muscle_groups(id),
  priority smallint,
  mev numeric(4,1) not null,
  mrv numeric(4,1) not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, muscle_id)
);

create table fit.exercises (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references fit.athletes(id) on delete cascade,  -- null = librería común
  slug text not null,
  name text not null,
  aliases text[] not null default '{}',                    -- nombres en texto libre del histórico
  primary_muscle text references fit.muscle_groups(id),
  secondary_muscles text[] not null default '{}',
  kind text not null default 'aislamiento' check (kind in ('compuesto','aislamiento','cardio','core')),
  movement_pattern text,                                   -- dominante_rodilla, bisagra, empuje_h, empuje_v, traccion_h, traccion_v…
  equipment text,
  stability text not null default 'bilateral_guiado'
    check (stability in ('unilateral_libre','bilateral_libre','unilateral_guiado','bilateral_guiado')),
  resistance_profile text not null default 'constante' check (resistance_profile in ('constante','variable')),
  stretch_bias boolean not null default false,             -- más tensión en estiramiento (más daño: cuenta en descargas)
  base_cost numeric(3,2) not null default 1.0,
  load_step numeric(5,2) not null default 2.5,
  per_side boolean not null default false,
  warmup_kind text not null default 'reducido' check (warmup_kind in ('no','reducido','completo')),
  ankle_load text not null default 'ninguna' check (ankle_load in ('ninguna','baja','alta')),
  impact boolean not null default false,
  video_urls text[] not null default '{}',
  cues text,
  created_at timestamptz not null default now()
);
create unique index exercises_slug_global on fit.exercises (slug) where user_id is null;
create unique index exercises_slug_user on fit.exercises (user_id, slug) where user_id is not null;
create index exercises_aliases on fit.exercises using gin (aliases);

create table fit.glossary (
  slug text primary key,
  term text not null,
  category text not null,                                  -- tecnica, volumen, intensidad, nutricion, cardio, recuperacion
  definition text not null,
  notes text,
  source text
);

-- ───────────────────────── Planificación ─────────────────────────

create table fit.macrocycles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references fit.athletes(id) on delete cascade default auth.uid(),
  name text not null,
  goal text not null check (goal in ('definicion','volumen','recomposicion','mantenimiento','fuerza')),
  start_date date not null,
  end_date date,
  start_weight_kg numeric(5,2),
  target_weight_kg numeric(5,2),
  start_waist_cm numeric(5,1),
  target_waist_cm numeric(5,1),
  status text not null default 'activo' check (status in ('borrador','activo','cerrado')),
  notes text,
  drive_folder_id text,
  created_at timestamptz not null default now()
);

create table fit.mesocycles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references fit.athletes(id) on delete cascade default auth.uid(),
  macrocycle_id uuid not null references fit.macrocycles(id) on delete cascade,
  position smallint not null,
  name text not null,
  block_type text not null default 'hipertrofia'
    check (block_type in ('hipertrofia','fuerza_base','volumen','intensificacion','peaking','tapering','pivot','descarga','mantenimiento')),
  focus text check (focus in ('intensidad','volumen','tecnica')),
  microcycle_days smallint not null default 7 check (microcycle_days between 3 and 21),  -- microciclos de N días
  microcycles_planned smallint not null default 4,
  start_date date,
  notes text,
  unique (macrocycle_id, position)
);

create table fit.microcycles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references fit.athletes(id) on delete cascade default auth.uid(),
  mesocycle_id uuid not null references fit.mesocycles(id) on delete cascade,
  position smallint not null,
  length_days smallint not null check (length_days between 3 and 21),
  start_date date,
  end_date date,
  is_deload boolean not null default false,
  objective text,
  unique (mesocycle_id, position)
);

-- Sesiones en rueda: se hacen en orden, sin día de la semana fijo.
create table fit.session_templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references fit.athletes(id) on delete cascade default auth.uid(),
  mesocycle_id uuid not null references fit.mesocycles(id) on delete cascade,
  position smallint not null,
  name text not null,
  focus text,
  is_rest boolean not null default false,
  is_cardio boolean not null default false,
  planned_minutes smallint,
  unique (mesocycle_id, position)
);

create table fit.prescriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references fit.athletes(id) on delete cascade default auth.uid(),
  session_template_id uuid not null references fit.session_templates(id) on delete cascade,
  exercise_id uuid not null references fit.exercises(id),
  position smallint not null,
  microcycle_position smallint,                            -- null = vale para todo el mesociclo; si no, pauta de ese microciclo
  sets smallint not null check (sets between 0 and 12),
  rep_min smallint,
  rep_max smallint,
  rir_target numeric(3,1),
  rest_seconds smallint,
  tempo text,
  technique text,                                          -- slug del glosario
  warmup_kind text check (warmup_kind in ('no','reducido','completo')),
  load_cap_pct smallint,                                   -- tope de carga (regla del tobillo: 75)
  notes text,
  check (rep_min is null or rep_max is null or rep_min <= rep_max)
);
create index prescriptions_template on fit.prescriptions (session_template_id, position);

-- ───────────────────────── Registro de entreno ─────────────────────────

create table fit.workouts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references fit.athletes(id) on delete cascade default auth.uid(),
  date date not null,
  started_at timestamptz,
  ended_at timestamptz,
  session_template_id uuid references fit.session_templates(id) on delete set null,
  microcycle_id uuid references fit.microcycles(id) on delete set null,
  name text,
  status text not null default 'en_curso' check (status in ('en_curso','hecha','saltada')),
  srpe numeric(3,1) check (srpe between 0 and 10),
  duration_min smallint check (duration_min between 0 and 600),
  load int generated always as ((round(srpe * duration_min))::int) stored,   -- sRPE × minutos
  tonnage numeric(10,1),
  hard_sets smallint,
  readiness_before smallint,
  recovery_after smallint,
  satisfaction smallint,
  caffeine_mg smallint,
  caffeine_at timestamptz,
  knee_sleeves boolean not null default false,
  belt boolean not null default false,
  straps boolean not null default false,
  notes text,
  source text not null default 'app' check (source in ('app','muse','legacy','import')),
  legacy_key text,                                         -- 'fecha|dia' de la app antigua: importación idempotente
  legacy jsonb,                                            -- fila original íntegra
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, legacy_key)
);
create index workouts_user_date on fit.workouts (user_id, date desc);

create table fit.workout_sets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references fit.athletes(id) on delete cascade default auth.uid(),
  workout_id uuid not null references fit.workouts(id) on delete cascade,
  exercise_id uuid references fit.exercises(id),
  exercise_name_raw text,                                  -- lo que escribió el atleta (histórico)
  exercise_position smallint not null default 1,
  set_index smallint not null,
  set_type text not null default 'normal'
    check (set_type in ('normal','aproximacion','top','backoff','dropset','myo','rest_pause','amrap','parcial','cluster')),
  kg numeric(6,2),
  reps smallint,
  rir numeric(3,1) check (rir between 0 and 10),
  kg_target numeric(6,2),
  reps_target smallint,
  rir_target numeric(3,1),
  per_side boolean not null default false,
  technique text,
  rest_seconds smallint,
  e1rm numeric(6,2),
  e1rm_confidence text check (e1rm_confidence in ('alta','media','baja')),
  effective_reps smallint,
  rule_applied text,                                       -- regla de progresión que generó el objetivo
  note text,
  done_at timestamptz,
  created_at timestamptz not null default now(),
  unique (workout_id, exercise_position, set_index)
);
create index workout_sets_exercise on fit.workout_sets (user_id, exercise_id, created_at desc);

create table fit.soreness_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references fit.athletes(id) on delete cascade default auth.uid(),
  date date not null,
  workout_id uuid references fit.workouts(id) on delete set null,
  muscle_id text not null references fit.muscle_groups(id),
  score smallint not null check (score between 1 and 5),   -- agujetas a las 48 h
  unique (user_id, date, muscle_id)
);

-- ───────────────────────── Bienestar ─────────────────────────

create table fit.checkins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references fit.athletes(id) on delete cascade default auth.uid(),
  date date not null,
  sleep_quality smallint check (sleep_quality between 1 and 10),
  sleep_hours numeric(3,1),
  stress smallint check (stress between 1 and 10),
  motivation smallint check (motivation between 1 and 10),
  pain smallint check (pain between 1 and 10),
  fatigue smallint check (fatigue between 1 and 10),
  ankle_pain smallint check (ankle_pain between 0 and 10),
  readiness smallint,                                      -- calculado por el motor al guardar
  note text,
  source text not null default 'app',
  created_at timestamptz not null default now(),
  unique (user_id, date)
);

create table fit.poms_tests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references fit.athletes(id) on delete cascade default auth.uid(),
  date date not null,
  answers smallint[] not null check (array_length(answers, 1) = 52),
  tension smallint not null,
  depression smallint not null,
  anger smallint not null,
  vigor smallint not null,
  fatigue smallint not null,
  tmd smallint not null,
  shape text not null check (shape in ('iceberg','plano','invertido')),
  created_at timestamptz not null default now(),
  unique (user_id, date)
);

create table fit.body_metrics (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references fit.athletes(id) on delete cascade default auth.uid(),
  date date not null,
  weight_kg numeric(5,2),
  waist_cm numeric(5,1),
  neck_cm numeric(5,1),
  abdomen_cm numeric(5,1),
  hip_cm numeric(5,1),
  chest_cm numeric(5,1),
  arm_cm numeric(5,1),
  thigh_cm numeric(5,1),
  calf_cm numeric(5,1),
  skinfolds jsonb,                                         -- {abdominal, suprailiaco, tricipital, subescapular, muslo, pantorrilla} en mm
  bf_pct numeric(4,1),
  bf_method text,
  note text,
  source text not null default 'app',
  created_at timestamptz not null default now(),
  unique (user_id, date)
);

create table fit.progress_photos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references fit.athletes(id) on delete cascade default auth.uid(),
  date date not null,
  pose text not null check (pose in ('frontal','lateral','trasera','otra')),
  drive_file_id text,
  drive_url text,
  drive_path text,
  note text,
  created_at timestamptz not null default now()
);

-- Vídeos de entreno en Drive: la app guarda metadatos, el fichero vive en Drive.
create table fit.videos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references fit.athletes(id) on delete cascade default auth.uid(),
  workout_id uuid references fit.workouts(id) on delete set null,
  workout_set_id uuid references fit.workout_sets(id) on delete set null,
  exercise_id uuid references fit.exercises(id),
  recorded_at timestamptz not null default now(),
  drive_file_id text,
  drive_url text,
  drive_path text,                                         -- Macrociclo/Ejercicio/AAAA-MM-DD_kg×reps.mp4
  status text not null default 'pendiente' check (status in ('pendiente','subido','error')),
  angle text,
  kg numeric(6,2),
  reps smallint,
  rir numeric(3,1),
  knee_sleeves boolean,
  belt boolean,
  straps boolean,
  caffeine_mg smallint,
  tags text[] not null default '{}',
  technique_notes text,
  analysis jsonb,
  created_at timestamptz not null default now()
);
create index videos_exercise on fit.videos (user_id, exercise_id, recorded_at desc);

-- ───────────────────────── Cardio y reloj ─────────────────────────

create table fit.cardio_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references fit.athletes(id) on delete cascade default auth.uid(),
  date date not null,
  started_at timestamptz,
  mode text not null check (mode in ('bici','eliptica','cinta_andando','caminar','remo','natacion','carrera','hiit','otro')),
  minutes numeric(5,1) not null,
  avg_hr smallint,
  max_hr smallint,
  zone smallint check (zone between 0 and 5),
  distance_km numeric(6,2),
  kcal smallint,
  ecos int,
  impact boolean not null default false,
  ankle_pain_before smallint check (ankle_pain_before between 0 and 10),
  ankle_pain_after smallint check (ankle_pain_after between 0 and 10),
  note text,
  source text not null default 'app',
  source_id text,
  created_at timestamptz not null default now(),
  unique (user_id, source, source_id)
);
create index cardio_user_date on fit.cardio_sessions (user_id, date desc);

create table fit.daily_activity (
  user_id uuid not null references fit.athletes(id) on delete cascade default auth.uid(),
  date date not null,
  steps int,
  active_kcal int,
  resting_hr smallint,
  hrv_ms numeric(5,1),
  sleep_minutes smallint,
  sleep_deep_min smallint,
  sleep_rem_min smallint,
  sleep_score smallint,
  bed_at timestamptz,
  woke_at timestamptz,
  screen_hours numeric(4,1),
  source text not null default 'app',
  updated_at timestamptz not null default now(),
  primary key (user_id, date)
);

-- Ingesta cruda del reloj / Health Connect: nada se pierde y se puede reprocesar.
create table fit.health_samples (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references fit.athletes(id) on delete cascade default auth.uid(),
  type text not null,                                      -- steps, heart_rate, resting_hr, sleep, exercise, weight, hrv…
  value numeric,
  unit text,
  started_at timestamptz not null,
  ended_at timestamptz,
  tz_offset_min smallint,
  source text not null,
  source_id text not null,
  raw jsonb,
  received_at timestamptz not null default now(),
  unique (user_id, source, source_id)
);
create index health_samples_type on fit.health_samples (user_id, type, started_at desc);

-- ───────────────────────── Nutrición ─────────────────────────

create table fit.foods (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references fit.athletes(id) on delete cascade,   -- null = catálogo común
  name text not null,
  brand text,
  barcode text,
  store text check (store in ('mercadona','lidl','otro')),
  category text,                                            -- proteina, hidrato, grasa, verdura, fruta, lacteo, otro
  source text not null default 'manual' check (source in ('manual','openfoodfacts','catalogo')),
  source_ref text,
  license text,                                             -- ODbL para Open Food Facts
  kcal_100 numeric(6,1) not null,
  protein_100 numeric(5,1) not null default 0,
  carbs_100 numeric(5,1) not null default 0,
  fat_100 numeric(5,1) not null default 0,
  fiber_100 numeric(5,1),
  sugar_100 numeric(5,1),
  salt_100 numeric(5,2),
  nutrients jsonb,
  is_liquid boolean not null default false,
  serving_g numeric(6,1),
  serving_label text,
  package_g numeric(7,1),
  price_eur numeric(7,2),
  price_per_kg numeric(7,2) generated always as
    (case when package_g > 0 and price_eur is not null then round(price_eur / package_g * 1000, 2) end) stored,
  price_checked_on date,                                    -- los precios caducan: sin fecha no se usan en presupuestos
  created_at timestamptz not null default now()
);
create unique index foods_barcode_global on fit.foods (barcode) where user_id is null and barcode is not null;
create unique index foods_barcode_user on fit.foods (user_id, barcode) where user_id is not null and barcode is not null;
create index foods_name on fit.foods (lower(name));

create table fit.nutrition_targets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references fit.athletes(id) on delete cascade default auth.uid(),
  valid_from date not null,
  phase text not null default 'calibracion' check (phase in ('calibracion','deficit','mantenimiento','superavit')),
  tdee int not null,
  tdee_method text not null check (tdee_method in ('mifflin','medido','manual')),
  lean_kg numeric(5,1),
  rate_pct_week numeric(3,2) not null default 0,
  avg_kcal int not null,
  on_off_spread numeric(3,2) not null default 0.12,
  on_kcal int not null, on_protein_g smallint not null, on_carbs_g smallint not null, on_fat_g smallint not null,
  off_kcal int not null, off_protein_g smallint not null, off_carbs_g smallint not null, off_fat_g smallint not null,
  protein_per_lean_kg numeric(3,2) not null default 2.3,
  fat_per_kg numeric(3,2) not null default 0.8,
  reason text,
  created_at timestamptz not null default now(),
  unique (user_id, valid_from)
);

create table fit.food_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references fit.athletes(id) on delete cascade default auth.uid(),
  date date not null,
  logged_at timestamptz not null default now(),
  meal text not null default 'comida' check (meal in ('desayuno','comida','cena','pre','intra','post','snack')),
  food_id uuid references fit.foods(id) on delete set null,
  description text,                                         -- texto libre («2 huevos y 80 g de avena»)
  grams numeric(7,1),
  kcal numeric(7,1) not null default 0,
  protein_g numeric(6,1) not null default 0,
  carbs_g numeric(6,1) not null default 0,
  fat_g numeric(6,1) not null default 0,
  estimated boolean not null default false,                 -- macros estimados, no pesados
  source text not null default 'app' check (source in ('app','barcode','muse','plantilla','import'))
);
create index food_logs_user_date on fit.food_logs (user_id, date desc);

-- Comidas ancla: se repiten con un toque (menos decisiones = más adherencia con TDAH).
create table fit.meal_templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references fit.athletes(id) on delete cascade default auth.uid(),
  name text not null,
  meal text not null default 'comida',
  day_type text check (day_type in ('on','off')),
  items jsonb not null default '[]'::jsonb,                 -- [{food_id, grams}]
  kcal numeric(7,1), protein_g numeric(6,1), carbs_g numeric(6,1), fat_g numeric(6,1),
  cost_eur numeric(6,2),
  created_at timestamptz not null default now()
);

create table fit.shopping_lists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references fit.athletes(id) on delete cascade default auth.uid(),
  week_start date not null,
  store text,
  budget_eur numeric(7,2),
  total_eur numeric(7,2),
  items jsonb not null default '[]'::jsonb,                 -- [{food_id, name, grams, packs, cost_eur, done}]
  created_at timestamptz not null default now(),
  unique (user_id, week_start, store)
);

create table fit.caffeine_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references fit.athletes(id) on delete cascade default auth.uid(),
  taken_at timestamptz not null default now(),
  mg smallint not null check (mg between 0 and 1000),
  source text,
  after_cutoff boolean not null default false
);

-- ───────────────────────── Automatización ─────────────────────────

-- Anotaciones automáticas del motor (y manuales): lo que la app «se dio cuenta».
create table fit.annotations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references fit.athletes(id) on delete cascade default auth.uid(),
  date date not null,
  origin text not null default 'motor' check (origin in ('motor','atleta','muse')),
  scope text not null check (scope in ('ejercicio','sesion','volumen','nutricion','recuperacion','tobillo','cardio','material')),
  rule text,
  severity text not null default 'info' check (severity in ('info','aviso','accion')),
  title text not null,
  body text,
  ref_table text,
  ref_id uuid,
  dismissed_at timestamptz,
  created_at timestamptz not null default now()
);
create index annotations_user_date on fit.annotations (user_id, date desc);

create table fit.weekly_reviews (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references fit.athletes(id) on delete cascade default auth.uid(),
  week_start date not null,
  weight_avg_kg numeric(5,2),
  weight_rate_pct numeric(4,2),
  waist_cm numeric(5,1),
  adherence_pct numeric(4,1),
  sessions_done smallint,
  sessions_planned smallint,
  action text,
  why text,
  data jsonb,
  created_at timestamptz not null default now(),
  unique (user_id, week_start)
);

create table fit.audit_log (
  id bigint generated always as identity primary key,
  user_id uuid references fit.athletes(id) on delete cascade,
  actor text not null,                                      -- 'app' | 'mcp:<client_id>' | 'ingest:<token>'
  action text not null,
  payload jsonb,
  created_at timestamptz not null default now()
);
create index audit_user_time on fit.audit_log (user_id, created_at desc);
