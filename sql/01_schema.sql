-- Alta de eventos · esquema de Supabase
-- Correr una vez en Supabase → SQL Editor. Es idempotente (se puede volver a correr).
--
-- Seguridad:
--   * Solo usuarios logueados con mail @uade.edu.ar leen y escriben.
--   * Cada REN ve todos los eventos (para detectar duplicados) pero solo edita/cancela los suyos.
--   * Las columnas del proceso (estado, id_actividad, intranet_*, umbraco_*, avisos) solo las cambia el
--     proceso automático (service_role). Un trigger lo garantiza aunque alguien llame a la API a mano.
--   * Nadie borra: se cancela.

create extension if not exists pgcrypto;

create table if not exists public.eventos (
  id                    uuid primary key default gen_random_uuid(),
  creado_por            uuid not null default auth.uid() references auth.users(id),
  creado_email          text not null default (auth.jwt() ->> 'email'),
  creado_at             timestamptz not null default now(),
  actualizado_at        timestamptz not null default now(),

  -- lo que carga el REN
  tipo                  text not null check (tipo in ('ri_grado', 'ri_posgrado', 'otro')),
  carreras              jsonb not null default '[]'::jsonb,
  sede                  char(1) not null check (sede in ('M', 'R', 'C', 'B', 'O')),
  fecha                 date not null,
  hora_ini              text not null check (hora_ini ~ '^([01][0-9]|2[0-3]):(00|15|30|45)$'),
  hora_fin              text not null check (hora_fin ~ '^([01][0-9]|2[0-3]):(00|15|30|45)$'),
  categ                 int[] not null default '{}',
  perfil                int[] not null default '{}',
  sector                int[] not null default '{}',
  origen_crm            char(1) check (origen_crm in ('R', 'A', 'O')),
  categ_crm             int,
  requiere_inscripcion  boolean not null default false,
  titulo                text not null check (char_length(titulo) between 3 and 100),
  titulo_manual         boolean not null default false,
  copete                text not null default '',
  descripcion           text not null default '' check (char_length(descripcion) <= 3000),
  desc_manual           boolean not null default false,
  cupo                  int check (cupo is null or cupo > 0),

  -- proceso automático
  tanda_id              uuid not null,
  estado                text not null default 'confirmado'
                        check (estado in ('confirmado', 'en_intranet', 'error_intranet', 'alta_manual',
                                          'en_umbraco', 'error_umbraco', 'cancelado')),
  accion_pendiente      text default 'alta' check (accion_pendiente in ('alta', 'modificar', 'baja')),
  confirmado_at         timestamptz not null default now(),
  id_actividad          int unique,
  intranet_at           timestamptz,
  error                 text,
  umbraco_id            int,
  umbraco_at            timestamptz,
  avisos_enviados       int not null default 0,
  ultimo_aviso_at       timestamptz,

  check (hora_fin > hora_ini)
);

create index if not exists eventos_cola_idx on public.eventos (accion_pendiente) where accion_pendiente is not null;
create index if not exists eventos_fecha_idx on public.eventos (fecha);
create index if not exists eventos_tanda_idx on public.eventos (tanda_id);

-- ---------- helpers ----------
create or replace function public.es_uade() returns boolean
language sql stable as $$
  select coalesce(auth.jwt() ->> 'email', '') ilike '%@uade.edu.ar'
$$;

-- ---------- trigger: protege columnas y decide la acción pendiente ----------
create or replace function public.eventos_antes_de_guardar() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  es_proceso boolean := coalesce(auth.role(), '') = 'service_role';
begin
  new.actualizado_at := now();
  if es_proceso then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.creado_por := auth.uid();
    new.creado_email := auth.jwt() ->> 'email';
    new.creado_at := now();
    new.confirmado_at := now();
    new.estado := 'confirmado';
    new.accion_pendiente := 'alta';
    new.id_actividad := null; new.intranet_at := null; new.error := null;
    new.umbraco_id := null; new.umbraco_at := null;
    new.avisos_enviados := 0; new.ultimo_aviso_at := null;
    if new.fecha < (now() at time zone 'America/Argentina/Buenos_Aires')::date then
      raise exception 'La fecha del evento ya pasó.';
    end if;
    return new;
  end if;

  -- UPDATE de un REN: no puede tocar dueño ni columnas del proceso
  new.creado_por := old.creado_por; new.creado_email := old.creado_email; new.creado_at := old.creado_at;
  new.tanda_id := old.tanda_id; new.confirmado_at := old.confirmado_at;
  new.id_actividad := old.id_actividad; new.intranet_at := old.intranet_at;
  new.umbraco_id := old.umbraco_id; new.umbraco_at := old.umbraco_at;
  new.avisos_enviados := old.avisos_enviados; new.ultimo_aviso_at := old.ultimo_aviso_at;

  if old.estado = 'cancelado' then
    raise exception 'El evento está cancelado.';
  end if;

  if new.estado = 'cancelado' then
    new.accion_pendiente := case when old.id_actividad is not null then 'baja' else null end;
    new.error := null;
  else
    -- cualquier otro cambio = editar: se reenvía a Intranet
    new.estado := case when old.id_actividad is not null then old.estado else 'confirmado' end;
    if new.estado like 'error%' then new.estado := 'confirmado'; end if;
    new.accion_pendiente := case when old.id_actividad is not null then 'modificar' else 'alta' end;
    new.error := null;
    new.avisos_enviados := 0; new.ultimo_aviso_at := null; new.confirmado_at := now();
  end if;
  return new;
end $$;

drop trigger if exists eventos_antes_de_guardar on public.eventos;
create trigger eventos_antes_de_guardar
  before insert or update on public.eventos
  for each row execute function public.eventos_antes_de_guardar();

-- ---------- RLS ----------
alter table public.eventos enable row level security;

drop policy if exists eventos_leer on public.eventos;
create policy eventos_leer on public.eventos
  for select to authenticated using (public.es_uade());

drop policy if exists eventos_crear on public.eventos;
create policy eventos_crear on public.eventos
  for insert to authenticated with check (public.es_uade() and creado_por = auth.uid());

drop policy if exists eventos_editar_propios on public.eventos;
create policy eventos_editar_propios on public.eventos
  for update to authenticated
  using (public.es_uade() and creado_por = auth.uid())
  with check (public.es_uade() and creado_por = auth.uid());

-- sin policy de delete: nadie borra desde la API pública
revoke delete on public.eventos from anon, authenticated;
revoke all on public.eventos from anon;

-- ---------- realtime (el proceso de la PC escucha los cambios) ----------
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'eventos') then
    alter publication supabase_realtime add table public.eventos;
  end if;
end $$;
