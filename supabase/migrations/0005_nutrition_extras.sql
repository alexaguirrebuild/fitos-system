-- Tipo de día de nutrición (On/Off) cuando el atleta lo fuerza a mano.
-- Sin fila, el servidor lo deduce: sesión de pesas hecha o en curso ese día, o la prevista en el plan.
-- Solo aditivo: no toca ninguna tabla anterior.

create table fit.nutrition_days (
  user_id uuid not null references fit.athletes(id) on delete cascade default auth.uid(),
  date date not null,
  day_type text not null check (day_type in ('on','off')),
  forced boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (user_id, date)
);

alter table fit.nutrition_days enable row level security;
alter table fit.nutrition_days force row level security;
create policy own_rows on fit.nutrition_days for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, update, delete on fit.nutrition_days to authenticated;
