-- RLS estricto. El servidor ejecuta cada petición dentro de una transacción con
--   set local role authenticated;  set_config('request.jwt.claims', '{"sub": "<uuid>"}', true)
-- de modo que auth.uid() es el atleta y las políticas filtran por fila.
-- `anon` no tiene ningún permiso sobre el esquema.

revoke all on schema fit from public;
revoke all on schema fit from anon;
grant usage on schema fit to authenticated;

-- 1) Tablas de datos del atleta: solo su propia fila, para leer y para escribir.
do $$
declare t text;
begin
  foreach t in array array[
    'schedule_blocks','injuries','injury_logs','athlete_volume_targets',
    'macrocycles','mesocycles','microcycles','session_templates','prescriptions',
    'workouts','workout_sets','soreness_logs','checkins','poms_tests','body_metrics',
    'progress_photos','videos','cardio_sessions','daily_activity','health_samples',
    'nutrition_targets','food_logs','meal_templates','shopping_lists','caffeine_logs',
    'annotations','weekly_reviews'
  ] loop
    execute format('alter table fit.%I enable row level security', t);
    execute format('alter table fit.%I force row level security', t);
    execute format('create policy own_rows on fit.%I for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
    execute format('grant select, insert, update, delete on fit.%I to authenticated', t);
  end loop;
end $$;

-- 2) El atleta ve y edita su ficha; no puede crear ni borrar atletas.
alter table fit.athletes enable row level security;
create policy self_select on fit.athletes for select to authenticated using (id = auth.uid());
create policy self_update on fit.athletes for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
grant select, update on fit.athletes to authenticated;

-- 3) Catálogos con filas comunes (user_id null) y propias: se lee lo común y lo propio; se escribe solo lo propio.
do $$
declare t text;
begin
  foreach t in array array['exercises','foods'] loop
    execute format('alter table fit.%I enable row level security', t);
    execute format('create policy read_common_or_own on fit.%I for select to authenticated using (user_id is null or user_id = auth.uid())', t);
    execute format('create policy insert_own on fit.%I for insert to authenticated with check (user_id = auth.uid())', t);
    execute format('create policy update_own on fit.%I for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
    execute format('create policy delete_own on fit.%I for delete to authenticated using (user_id = auth.uid())', t);
    execute format('grant select, insert, update, delete on fit.%I to authenticated', t);
  end loop;
end $$;

-- 4) Catálogos de solo lectura.
alter table fit.muscle_groups enable row level security;
create policy read_all on fit.muscle_groups for select to authenticated using (true);
grant select on fit.muscle_groups to authenticated;
alter table fit.glossary enable row level security;
create policy read_all on fit.glossary for select to authenticated using (true);
grant select on fit.glossary to authenticated;

-- 5) Registro de auditoría: el atleta lee el suyo y añade; nunca modifica ni borra.
alter table fit.audit_log enable row level security;
alter table fit.audit_log force row level security;
create policy read_own on fit.audit_log for select to authenticated using (user_id = auth.uid());
create policy append_own on fit.audit_log for insert to authenticated with check (user_id = auth.uid());
grant select, insert on fit.audit_log to authenticated;

-- 6) Tablas de acceso: RLS activado y sin políticas → invisibles para `authenticated`.
alter table fit.oauth_clients enable row level security;
alter table fit.oauth_codes enable row level security;
alter table fit.oauth_tokens enable row level security;
alter table fit.ingest_tokens enable row level security;
alter table fit.login_attempts enable row level security;
