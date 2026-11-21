-- Tipo de equipo, composición medida y día libre. Solo aditivo (más un check ampliado en nutrition_days).

-- 2. Tipo de equipo del ejercicio y del que se usó en cada serie.
alter table fit.exercises add column equipment_type text
  check (equipment_type in ('libre','multipower','polea','placas','discos','peso_corporal','cardio'));
update fit.exercises set equipment_type = case equipment
  when 'barra' then 'libre'
  when 'mancuernas' then 'libre'
  when 'multipower' then 'multipower'
  when 'polea' then 'polea'
  when 'maquina' then 'placas'
  when 'peso_corporal' then 'peso_corporal'
  when 'bici' then 'cardio'
  when 'eliptica' then 'cardio'
  when 'cinta' then 'cardio'
  when 'ninguno' then 'cardio'
  else null end
  where equipment_type is null;

alter table fit.workout_sets add column equipment_type text
  check (equipment_type in ('libre','multipower','polea','placas','discos','peso_corporal','cardio'));

-- 3. Composición medida.
alter table fit.body_metrics add column skeletal_muscle_kg numeric(5,2);
alter table fit.body_metrics add column forearm_cm numeric(5,1);
alter table fit.body_metrics add column shoulder_width_cm numeric(5,1);

-- 5. Día libre.
alter table fit.nutrition_days drop constraint nutrition_days_day_type_check;
alter table fit.nutrition_days add constraint nutrition_days_day_type_check check (day_type in ('on','off','libre'));
