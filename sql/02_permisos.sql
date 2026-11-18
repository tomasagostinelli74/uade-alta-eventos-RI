-- Permisos de tabla que faltaron en 01 (el proyecto no los otorga solo). Idempotente.
grant select, insert, update on public.eventos to authenticated;
grant all on public.eventos to service_role;
