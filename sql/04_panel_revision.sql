-- Panel de control: lo que confirma un REN queda "para revisar" y no va a Intranet hasta que un revisor lo aprueba.
-- Correr en Supabase → SQL Editor. Es idempotente. Los mails de los revisores NO van acá (el repo es público):
-- se cargan aparte con privado/revisores.sql.
--
-- Estados: para_revisar → devuelto (el REN corrige y vuelve a para_revisar) → aprobado → en_intranet → en_umbraco.
-- accion_pendiente solo se completa al aprobar (alta / modificar) o al cancelar algo que ya está en Intranet (baja):
-- es lo único que mira el proceso de la PC.

-- ---------- columnas de la revisión ----------
alter table public.eventos add column if not exists revision_comentario text;
alter table public.eventos add column if not exists revisado_por text;
alter table public.eventos add column if not exists revisado_at timestamptz;
alter table public.eventos add column if not exists aprobado_at timestamptz;

-- ---------- estados nuevos ----------
alter table public.eventos drop constraint if exists eventos_estado_check;
update public.eventos set estado = 'para_revisar', accion_pendiente = null where estado = 'confirmado';
alter table public.eventos alter column estado set default 'para_revisar';
alter table public.eventos alter column accion_pendiente set default null;
alter table public.eventos add constraint eventos_estado_check check (estado in (
  'para_revisar', 'devuelto', 'aprobado', 'en_intranet', 'error_intranet', 'alta_manual',
  'en_umbraco', 'error_umbraco', 'cancelado'));

-- ---------- revisores ----------
create table if not exists public.revisores (email text primary key);
alter table public.revisores enable row level security;  -- sin policies: nadie la lee desde la API
grant all on public.revisores to service_role;

create or replace function public.es_revisor() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.revisores
                 where lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')))
$$;
revoke all on function public.es_revisor() from public, anon;
grant execute on function public.es_revisor() to authenticated;

-- ---------- trigger: quién puede cambiar qué ----------
create or replace function public.eventos_antes_de_guardar() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  es_proceso boolean := coalesce(auth.role(), '') = 'service_role';
  revisor boolean := public.es_revisor();
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
    new.estado := 'para_revisar';
    new.accion_pendiente := null;
    new.id_actividad := null; new.intranet_at := null; new.error := null;
    new.umbraco_id := null; new.umbraco_at := null;
    new.avisos_enviados := 0; new.ultimo_aviso_at := null;
    new.revision_comentario := null; new.revisado_por := null; new.revisado_at := null; new.aprobado_at := null;
    if new.fecha < (now() at time zone 'America/Argentina/Buenos_Aires')::date then
      raise exception 'La fecha del evento ya pasó.';
    end if;
    return new;
  end if;

  -- UPDATE: nadie toca el dueño ni las columnas del proceso
  new.creado_por := old.creado_por; new.creado_email := old.creado_email; new.creado_at := old.creado_at;
  new.tanda_id := old.tanda_id;
  new.id_actividad := old.id_actividad; new.intranet_at := old.intranet_at;
  new.umbraco_id := old.umbraco_id; new.umbraco_at := old.umbraco_at;

  if old.estado = 'cancelado' then
    raise exception 'El evento está cancelado.';
  end if;

  -- cancelar (el REN dueño o un revisor)
  if new.estado = 'cancelado' then
    new.accion_pendiente := case when old.id_actividad is not null then 'baja' else null end;
    new.error := null;
    new.revision_comentario := old.revision_comentario; new.revisado_por := old.revisado_por;
    new.revisado_at := old.revisado_at; new.aprobado_at := old.aprobado_at;
    new.avisos_enviados := 0; new.ultimo_aviso_at := null; new.confirmado_at := now();
    return new;
  end if;

  -- revisor: aprobar o devolver lo que está para revisar
  if revisor and old.estado = 'para_revisar' and new.estado in ('aprobado', 'devuelto') then
    new.revisado_por := auth.jwt() ->> 'email';
    new.revisado_at := now();
    new.error := null;
    if new.estado = 'aprobado' then
      new.aprobado_at := now();
      new.accion_pendiente := case when old.id_actividad is not null then 'modificar' else 'alta' end;
      new.avisos_enviados := 0; new.ultimo_aviso_at := null;   -- los mails de 15/45/75 min cuentan desde acá
    else
      if coalesce(trim(new.revision_comentario), '') = '' then
        raise exception 'Para devolver un evento hay que escribir un comentario para el REN.';
      end if;
      new.accion_pendiente := null; new.aprobado_at := old.aprobado_at;
    end if;
    return new;
  end if;

  -- revisor corrigiendo en el panel: sigue para revisar
  if revisor and old.estado = 'para_revisar' then
    new.estado := 'para_revisar';
    new.accion_pendiente := old.accion_pendiente;
    new.revision_comentario := old.revision_comentario; new.revisado_por := old.revisado_por;
    new.revisado_at := old.revisado_at; new.aprobado_at := old.aprobado_at;
    new.avisos_enviados := old.avisos_enviados; new.ultimo_aviso_at := old.ultimo_aviso_at;
    new.confirmado_at := old.confirmado_at;
    return new;
  end if;

  -- cualquier otro cambio (el REN edita o corrige lo devuelto): vuelve a revisión.
  -- El comentario queda para que el revisor vea qué había pedido.
  new.estado := 'para_revisar';
  new.accion_pendiente := null;
  new.error := null;
  new.revision_comentario := old.revision_comentario; new.revisado_por := old.revisado_por;
  new.revisado_at := old.revisado_at; new.aprobado_at := null;
  new.avisos_enviados := 0; new.ultimo_aviso_at := null; new.confirmado_at := now();
  return new;
end $$;

-- ---------- RLS: los revisores editan cualquier evento ----------
drop policy if exists eventos_revisar on public.eventos;
create policy eventos_revisar on public.eventos
  for update to authenticated
  using (public.es_uade() and public.es_revisor())
  with check (public.es_uade() and public.es_revisor());
