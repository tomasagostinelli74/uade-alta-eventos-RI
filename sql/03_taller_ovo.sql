-- Nuevo tipo de evento: Taller OVO (orientación vocacional). Idempotente.
alter table public.eventos drop constraint if exists eventos_tipo_check;
alter table public.eventos add constraint eventos_tipo_check check (tipo in ('ri_grado', 'ri_posgrado', 'ovo', 'otro'));
