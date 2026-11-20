-- Id de cliente para la cola sin conexión: un reenvío con el mismo id no vuelve a insertar.
-- Solo aditivo: dos columnas nuevas y dos índices únicos parciales (las filas antiguas quedan con null).

alter table fit.workout_sets add column client_id text;
alter table fit.food_logs add column client_id text;

create unique index workout_sets_client_id on fit.workout_sets (user_id, client_id) where client_id is not null;
create unique index food_logs_client_id on fit.food_logs (user_id, client_id) where client_id is not null;
