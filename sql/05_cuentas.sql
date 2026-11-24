-- Cuentas de los RENs: qué puede cargar cada mail. Reemplaza la lista que estaba en config.js.
-- Correr en Supabase → SQL Editor. Es idempotente. Los mails NO van acá (el repo es público):
-- se cargan aparte con privado/cuentas.sql.
--
-- nivel:    grado (RI de grado, Taller OVO, Evento) · posgrado (RI de posgrado, Evento) · todos
-- variante: versión de la carrera que se propone primero: normal · online · costa
-- Quien no tiene cuenta activa no lee ni carga eventos. Los revisores entran al panel igual.

create table if not exists public.cuentas (
  email      text primary key check (email = lower(email)),
  nombre     text not null,
  nivel      text not null check (nivel in ('grado', 'posgrado', 'todos')),
  variante   text not null default 'normal' check (variante in ('normal', 'online', 'costa')),
  activa     boolean not null default true,
  creado_at  timestamptz not null default now()
);
alter table public.cuentas enable row level security;
grant select on public.cuentas to authenticated;
grant all on public.cuentas to service_role;

-- ---------- helpers ----------
create or replace function public.mi_email() returns text
language sql stable as $$ select lower(coalesce(auth.jwt() ->> 'email', '')) $$;

create or replace function public.tiene_cuenta() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.cuentas where email = public.mi_email() and activa)
$$;

create or replace function public.puede_cargar(p_tipo text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.cuentas c
                 where c.email = public.mi_email() and c.activa
                   and case c.nivel
                         when 'grado' then p_tipo in ('ri_grado', 'ovo', 'otro')
                         when 'posgrado' then p_tipo in ('ri_posgrado', 'otro')
                         else true
                       end)
$$;

-- La cuenta del que está logueado (vacío si no tiene o está desactivada)
create or replace function public.mi_cuenta() returns setof public.cuentas
language sql stable security definer set search_path = public as $$
  select * from public.cuentas where email = public.mi_email() and activa
$$;

revoke all on function public.tiene_cuenta() from public, anon;
revoke all on function public.puede_cargar(text) from public, anon;
revoke all on function public.mi_cuenta() from public, anon;
grant execute on function public.tiene_cuenta() to authenticated;
grant execute on function public.puede_cargar(text) to authenticated;
grant execute on function public.mi_cuenta() to authenticated;

-- Cada uno ve su cuenta; los revisores ven todas
drop policy if exists cuentas_leer on public.cuentas;
create policy cuentas_leer on public.cuentas
  for select to authenticated using (email = public.mi_email() or public.es_revisor());

-- ---------- eventos: sin cuenta activa no se lee ni se carga ----------
drop policy if exists eventos_leer on public.eventos;
create policy eventos_leer on public.eventos
  for select to authenticated using (public.es_uade() and (public.tiene_cuenta() or public.es_revisor()));

create or replace function public.eventos_validar_cuenta() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(auth.role(), '') = 'service_role' then return new; end if;   -- proceso de la PC
  if tg_op = 'UPDATE' and public.es_revisor() then return new; end if;    -- revisor en el panel
  if not public.tiene_cuenta() then
    raise exception 'Tu cuenta no está habilitada para cargar eventos. Pedile acceso a Marketing.';
  end if;
  if (tg_op = 'INSERT' or new.tipo is distinct from old.tipo) and not public.puede_cargar(new.tipo) then
    raise exception 'Tu cuenta no puede cargar este tipo de evento.';
  end if;
  return new;
end $$;

drop trigger if exists eventos_validar_cuenta on public.eventos;
create trigger eventos_validar_cuenta
  before insert or update on public.eventos
  for each row execute function public.eventos_validar_cuenta();
