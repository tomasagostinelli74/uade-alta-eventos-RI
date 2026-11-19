// Capa de datos. Sin SUPABASE en config.js → modo prueba (localStorage). Con SUPABASE → base real.
// Las dos implementaciones tienen la misma interfaz; app.js no sabe cuál usa.
import { SUPABASE } from "./config.js";

const K_EVENTOS = "uade_alta_eventos";
const K_TANDA = "uade_alta_tanda";

function leer(k, def) {
  try { return JSON.parse(localStorage.getItem(k)) ?? def; } catch { return def; }
}
function escribir(k, v) {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* navegador sin storage: se pierde al recargar */ }
}

export const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : "x" + Date.now().toString(36) + Math.random().toString(36).slice(2));

export const modoPrueba = !(SUPABASE.url && SUPABASE.anonKey);

// La tanda (borradores) vive siempre en el navegador del REN hasta que confirma.
export const tanda = {
  get: () => leer(K_TANDA, []),
  set: (lista) => escribir(K_TANDA, lista),
};

// Columnas que escribe el REN. Lo demás (estado, id_actividad, etc.) lo decide la base.
const CAMPOS_REN = [
  "tipo", "carreras", "sede", "fecha", "hora_ini", "hora_fin", "categ", "perfil", "sector", "origen_crm",
  "categ_crm", "requiere_inscripcion", "titulo", "titulo_manual", "copete", "descripcion", "desc_manual", "cupo",
];
const soloRen = (e) => Object.fromEntries(CAMPOS_REN.map((k) => [k, e[k] ?? null]));

/* ---------------- modo prueba ---------------- */
const local = {
  async sesion() { return { email: null, prueba: true }; },
  async entrar() { return null; },
  async salir() {},
  async listar() { return leer(K_EVENTOS, []); },
  async confirmar(eventos) {
    const ahora = new Date().toISOString();
    const tandaId = uid();
    const nuevos = eventos.map((e) => ({
      ...soloRen(e), id: uid(), tanda_id: tandaId, estado: "para_revisar", accion_pendiente: null,
      confirmado_at: ahora, actualizado_at: ahora, id_actividad: null, creado_email: null, propio: true,
      revision_comentario: null, revisado_por: null, revisado_at: null, aprobado_at: null,
    }));
    escribir(K_EVENTOS, [...nuevos, ...leer(K_EVENTOS, [])]);
    return nuevos;
  },
  async actualizar(ev) {
    const lista = leer(K_EVENTOS, []);
    const i = lista.findIndex((x) => x.id === ev.id);
    if (i < 0) throw new Error("No se encontró el evento.");
    if (lista[i].estado === "cancelado") throw new Error("El evento está cancelado.");
    const ahora = new Date().toISOString();
    lista[i] = {
      ...lista[i], ...soloRen(ev), actualizado_at: ahora, confirmado_at: ahora,
      estado: "para_revisar", accion_pendiente: null, error: null, aprobado_at: null,
    };
    escribir(K_EVENTOS, lista);
    return lista[i];
  },
  async cancelar(id) {
    const lista = leer(K_EVENTOS, []);
    const ev = lista.find((x) => x.id === id);
    if (!ev) throw new Error("No se encontró el evento.");
    ev.accion_pendiente = ev.id_actividad ? "baja" : null;
    ev.estado = "cancelado";
    ev.actualizado_at = new Date().toISOString();
    escribir(K_EVENTOS, lista);
    return ev;
  },
  escuchar() { return () => {}; },

  // ---- panel de control ----
  async esRevisor() { return true; },
  async corregir(ev) { // el revisor corrige: sigue para revisar
    const lista = leer(K_EVENTOS, []);
    const x = lista.find((y) => y.id === ev.id);
    if (!x) throw new Error("No se encontró el evento.");
    if (x.estado !== "para_revisar") throw new Error("Este evento ya no está para revisar.");
    Object.assign(x, soloRen(ev), { actualizado_at: new Date().toISOString() });
    escribir(K_EVENTOS, lista);
    return x;
  },
  async aprobar(ids) {
    const lista = leer(K_EVENTOS, []);
    const ahora = new Date().toISOString();
    const hechos = [];
    for (const x of lista) {
      if (!ids.includes(x.id) || x.estado !== "para_revisar") continue;
      Object.assign(x, { estado: "aprobado", accion_pendiente: x.id_actividad ? "modificar" : "alta",
        aprobado_at: ahora, revisado_at: ahora, revisado_por: "modo prueba", actualizado_at: ahora, error: null });
      hechos.push(x);
    }
    escribir(K_EVENTOS, lista);
    return hechos;
  },
  async devolver(id, comentario) {
    if (!String(comentario || "").trim()) throw new Error("Escribí un comentario para el REN.");
    const lista = leer(K_EVENTOS, []);
    const x = lista.find((y) => y.id === id);
    if (!x || x.estado !== "para_revisar") throw new Error("Este evento ya no está para revisar.");
    const ahora = new Date().toISOString();
    Object.assign(x, { estado: "devuelto", accion_pendiente: null, revision_comentario: comentario.trim(),
      revisado_at: ahora, revisado_por: "modo prueba", actualizado_at: ahora });
    escribir(K_EVENTOS, lista);
    return x;
  },
};

/* ---------------- Supabase ---------------- */
function crearSupabase() {
  let sb = null;
  let yo = null;
  const cliente = async () => {
    if (!sb) {
      const { createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.50.0/+esm");
      sb = createClient(SUPABASE.url, SUPABASE.anonKey, { auth: { persistSession: true, autoRefreshToken: true } });
    }
    return sb;
  };
  const ok = ({ data, error }) => {
    if (error) throw new Error(traducir(error.message));
    return data;
  };
  const marcar = (filas) => filas.map((f) => ({ ...f, propio: f.creado_por === yo?.id }));

  return {
    async sesion() {
      const { data } = await (await cliente()).auth.getSession();
      yo = data.session?.user || null;
      return yo ? { email: yo.email, prueba: false } : null;
    },
    async entrar(email, clave) {
      if (!/@uade\.edu\.ar$/i.test(email.trim())) throw new Error("Usá tu mail @uade.edu.ar.");
      const data = ok(await (await cliente()).auth.signInWithPassword({ email: email.trim(), password: clave }));
      yo = data.user;
      return { email: yo.email, prueba: false };
    },
    async salir() { await (await cliente()).auth.signOut(); yo = null; },
    async listar() {
      const desde = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10); // último mes en adelante
      return marcar(ok(await (await cliente()).from("eventos").select("*").gte("fecha", desde).order("fecha")));
    },
    async confirmar(eventos) {
      const tandaId = uid();
      const filas = eventos.map((e) => ({ ...soloRen(e), tanda_id: tandaId }));
      return marcar(ok(await (await cliente()).from("eventos").insert(filas).select()));
    },
    async actualizar(ev) {
      return marcar(ok(await (await cliente()).from("eventos").update(soloRen(ev)).eq("id", ev.id).select()))[0];
    },
    async cancelar(id) {
      return ok(await (await cliente()).from("eventos").update({ estado: "cancelado" }).eq("id", id).select())[0];
    },
    // ---- panel de control (lo permite el trigger solo a los revisores) ----
    async esRevisor() {
      const c = await cliente();
      const { data, error } = await c.rpc("es_revisor");
      if (error) throw new Error(traducir(error.message));
      return data === true;
    },
    async corregir(ev) {
      return marcar(ok(await (await cliente()).from("eventos").update(soloRen(ev)).eq("id", ev.id).eq("estado", "para_revisar").select()))[0]
        || Promise.reject(new Error("Este evento ya no está para revisar."));
    },
    async aprobar(ids) {
      return marcar(ok(await (await cliente()).from("eventos").update({ estado: "aprobado" }).in("id", ids).eq("estado", "para_revisar").select()));
    },
    async devolver(id, comentario) {
      if (!String(comentario || "").trim()) throw new Error("Escribí un comentario para el REN.");
      const filas = ok(await (await cliente()).from("eventos")
        .update({ estado: "devuelto", revision_comentario: comentario.trim() }).eq("id", id).eq("estado", "para_revisar").select());
      if (!filas.length) throw new Error("Este evento ya no está para revisar.");
      return filas[0];
    },
    /** Avisa cuando el proceso automático cambia un estado (para refrescar "Mis eventos"). */
    escuchar(alCambiar) {
      let canal = null;
      cliente().then((c) => {
        canal = c.channel("eventos").on("postgres_changes", { event: "*", schema: "public", table: "eventos" }, alCambiar).subscribe();
      });
      return () => canal && sb.removeChannel(canal);
    },
  };
}

function traducir(msg) {
  if (/Invalid login credentials/i.test(msg)) return "Mail o contraseña incorrectos.";
  if (/Email not confirmed/i.test(msg)) return "La cuenta no está activada. Avisale al administrador.";
  if (/row-level security/i.test(msg)) return "No tenés permiso para esta acción.";
  if (/function public\.es_revisor|es_revisor\(\) does not exist|Could not find the function/i.test(msg)) return "Falta instalar el panel en Supabase (sql/04_panel_revision.sql).";
  if (/Failed to fetch|NetworkError/i.test(msg)) return "Sin conexión. Probá de nuevo.";
  return msg;
}

export const store = modoPrueba ? local : crearSupabase();
