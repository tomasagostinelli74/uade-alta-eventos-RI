// Capa de datos. Hoy: modo prueba en localStorage. En la etapa Supabase se agrega el adaptador real
// con la misma interfaz (listar, confirmar, actualizar, cancelar), sin tocar app.js.
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

const local = {
  async usuario() { return { email: null, prueba: true }; },
  async listar() { return leer(K_EVENTOS, []); },
  async confirmar(eventos) {
    const ahora = new Date().toISOString();
    const tandaId = uid();
    const nuevos = eventos.map((e) => ({
      ...e, id: e.id || uid(), tanda_id: tandaId, estado: "confirmado", accion_pendiente: "alta",
      confirmado_at: ahora, actualizado_at: ahora, id_actividad: null,
    }));
    escribir(K_EVENTOS, [...nuevos, ...leer(K_EVENTOS, [])]);
    return nuevos;
  },
  async actualizar(ev) {
    const lista = leer(K_EVENTOS, []);
    const i = lista.findIndex((x) => x.id === ev.id);
    if (i < 0) throw new Error("No se encontró el evento.");
    const yaEnIntranet = !!lista[i].id_actividad;
    lista[i] = {
      ...lista[i], ...ev, actualizado_at: new Date().toISOString(),
      accion_pendiente: yaEnIntranet ? "modificar" : "alta",
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
};

export const store = local;
