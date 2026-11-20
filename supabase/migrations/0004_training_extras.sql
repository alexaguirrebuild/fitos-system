-- Ejercicios de una sesión concreta. Al empezar la sesión se copian los del plan; aquí viven también
-- los añadidos a mano y los cambios (p. ej. sentadilla → prensa por el tobillo) antes de que haya series.
-- Solo aditivo: no toca ninguna tabla anterior.

create table fit.workout_exercises (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references fit.athletes(id) on delete cascade default auth.uid(),
  workout_id uuid not null references fit.workouts(id) on delete cascade,
  exercise_id uuid not null references fit.exercises(id),
  position smallint not null,
  prescription_id uuid references fit.prescriptions(id) on delete set null,  -- la pauta se conserva aunque se cambie el ejercicio
  replaces_exercise_id uuid references fit.exercises(id),                    -- el ejercicio del plan al que sustituye
  origin text not null default 'manual' check (origin in ('plan','manual','cambio')),
  note text,
  created_at timestamptz not null default now(),
  unique (workout_id, exercise_id)
);
create index workout_exercises_workout on fit.workout_exercises (workout_id, position);

alter table fit.workout_exercises enable row level security;
alter table fit.workout_exercises force row level security;
create policy own_rows on fit.workout_exercises for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, update, delete on fit.workout_exercises to authenticated;
