// Lo que comparten el formulario (app.js) y el panel de control (panel.js):
// utilidades, diálogo, mayúsculas, ortografía, estados y la simulación de Intranet y Umbraco.
import {
  SEDES, CATEG, PERFIL, SECTORES, ORIGEN_CRM, CATEG_CRM, SITES_UMBRACO,
} from "./config.js";

/* ================= utilidades ================= */
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
export const sedeLabel = (c) => SEDES.find((s) => s.code === c)?.label || c || "—";
export const hoyISO = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
export const ddmm = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : "dd/mm");
export const fechaLarga = (iso) => {
  if (!iso) return "—";
  const dia = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"][new Date(iso + "T12:00:00").getDay()];
  return `${dia} ${ddmm(iso)}`;
};
export const aMin = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
export const aHHMM = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
export const HORAS = []; for (let m = 7 * 60; m <= 23 * 60 + 45; m += 15) HORAS.push(aHHMM(m));
export const esRI = (tipo) => tipo === "ri_grado" || tipo === "ri_posgrado";
export const VAR_LABEL = { normal: "Presencial", online: "Online", costa: "Costa" };

export function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 2600);
}

export function dialogo({ titulo, html, botones }) {
  return new Promise((res) => {
    const d = $("#dlg");
    $("#dlg-title").textContent = titulo;
    $("#dlg-content").innerHTML = html;
    $("#dlg-actions").innerHTML = botones.map((b, i) =>
      `<button value="${i}" class="${b.primary ? "primary" : "ghost"}" style="${b.primary ? "" : "padding:10px 14px"}">${esc(b.label)}</button>`).join("");
    d.onclose = () => res(d.returnValue === "" ? -1 : Number(d.returnValue));
    d.returnValue = "";
    d.showModal();
  });
}

/* ================= título automático de las RI ================= */
export function tituloAuto(e) {
  const fecha = ddmm(e.fecha);
  if (!esRI(e.tipo)) return "";
  const online = e.sede === "O";
  const prefijo = online ? "Reunión Informativa Online" : "Reunión Informativa";
  // la versión de la carrera se aclara solo si suma: "Online" no se repite si la reunión ya es online
  const nombres = e.carreras.map((c) => c.corto + (c.variante === "costa" ? " Costa" : c.variante === "online" && !online ? " Online" : ""));
  return `${prefijo}: ${nombres.join(" + ") || "[carrera]"} (${fecha})`;
}

/* ================= UADE siempre en mayúsculas ================= */
// "uade" suelto → "UADE". No toca mails ni webs (face@uade.edu.ar, www.uade.edu.ar).
const RX_UADE = /(?<![\p{L}\p{N}@./_-])uade(?![\p{L}\p{N}@_-]|\.[\p{L}])/giu;
export const uadeMayus = (s) => String(s ?? "").replace(RX_UADE, "UADE");
/** Corrige "uade" mientras se escribe, sin mover el cursor (el largo no cambia). */
export function uadeEnVivo(el) {
  const v = uadeMayus(el.value);
  if (v === el.value) return;
  const a = el.selectionStart, b = el.selectionEnd;
  el.value = v;
  try { el.setSelectionRange(a, b); } catch { /* campos sin cursor */ }
}

/* ================= mayúsculas del título ================= */
// Misma regla que usamos al cargar en Umbraco: cada palabra del título con mayúscula, salvo los conectores.
export const CONECTORES = new Set(["a", "al", "de", "del", "e", "el", "en", "la", "las", "lo", "los", "o", "u", "y", "con",
  "para", "por", "sin", "sobre", "entre", "in", "of", "and", "the", "for"]);
const PALABRA = /\p{L}[\p{L}\p{N}'.]*/gu;
const esMinuscula = (c) => c !== c.toUpperCase() && c === c.toLowerCase();

export function corregirMayusculas(titulo) {
  // Si el título es una pregunta o exclamación ("Charla: ¿Cómo ...?"), solo se corrige lo que va antes de ":".
  let cabeza = titulo, frase = "";
  if (/[¿?¡!]/.test(titulo)) {
    const sep = [":", " - "].find((s) => titulo.includes(s));
    if (!sep) return titulo;
    const i = titulo.indexOf(sep);
    cabeza = titulo.slice(0, i); frase = titulo.slice(i);
  }
  let primera = true;
  return cabeza.replace(PALABRA, (w) => {
    const esPrimera = primera; primera = false;
    if (w.toLowerCase() === "uade") return "UADE";
    if (esMinuscula(w[0]) && (esPrimera || !CONECTORES.has(w.toLowerCase().replace(/\.$/, "")))) return w[0].toUpperCase() + w.slice(1);
    return w;
  }) + frase;
}

/* ================= ortografía (LanguageTool) ================= */
const LT_URL = "https://api.languagetool.org/v2/check";
const LT_TIPOS = new Set(["misspelling", "grammar", "inconsistency"]);
const cacheLT = new Map();
let conocidas = null;

/** Palabras que el corrector no conoce pero están bien (nombres de carreras, sedes, siglas propias). */
function palabrasConocidas(carreras) {
  if (conocidas) return conocidas;
  conocidas = new Set(["uade", "ubs", "online", "campus", "webinar", "workshop"]);
  const sumar = (s) => (String(s || "").match(PALABRA) || []).forEach((w) => conocidas.add(w.replace(/\.$/, "").toLowerCase()));
  carreras.forEach((c) => { sumar(c.base); sumar(c.corto); Object.values(c.variantes || {}).forEach((v) => sumar(v?.nombre)); });
  SEDES.forEach((s) => sumar(s.label));
  return conocidas;
}

/** Devuelve los errores de ortografía/gramática de cada campo, o null si el corrector no respondió. */
export async function revisarOrtografia(campos, carreras = []) {
  const claves = Object.keys(campos).filter((k) => campos[k].trim());
  if (!claves.length) return [];
  let texto = ""; const inicio = {};
  claves.forEach((k) => { inicio[k] = texto.length; texto += campos[k] + "\n\n"; });

  let matches = cacheLT.get(texto);
  if (!matches) {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await fetch(LT_URL, { method: "POST", signal: ctrl.signal, body: new URLSearchParams({ language: "es-AR", text: texto }) });
      if (!r.ok) return null;
      matches = (await r.json()).matches || [];
      cacheLT.set(texto, matches);
    } catch { return null; } finally { clearTimeout(t); }
  }

  const conocidas = palabrasConocidas(carreras);
  const errores = [];
  for (const m of matches) {
    if (!LT_TIPOS.has(m.rule?.issueType) || m.rule?.category?.id === "CASING" || !m.replacements?.length) continue;
    const campo = [...claves].reverse().find((k) => inicio[k] <= m.offset);
    const valor = campos[campo];
    const ini = m.offset - inicio[campo];
    if (ini + m.length > valor.length) continue;
    const error = valor.slice(ini, ini + m.length);
    const ortografia = m.rule.issueType === "misspelling";
    if (ortografia && (/[\d@/]/.test(error) || /\p{Lu}.*\p{Lu}/u.test(error) || conocidas.has(error.toLowerCase()))) continue;
    errores.push({
      campo, ini, largo: m.length, error, ortografia,
      sugerencias: [...new Set(m.replacements.slice(0, 3).map((r) => r.value))],
      antes: valor.slice(Math.max(0, ini - 30), ini), despues: valor.slice(ini + m.length, ini + m.length + 30),
      recorteIni: ini > 30, recorteFin: ini + m.length + 30 < valor.length,
    });
  }
  return errores;
}

/* ================= estados del evento ================= */
// para_revisar → (devuelto) → aprobado → en_intranet → en_umbraco. Los de error y cancelado, aparte.
export const ESTADOS = {
  para_revisar: { label: "Para revisar", cls: "e-cola" },
  devuelto: { label: "Devuelto para corregir", cls: "e-err" },
  aprobado: { label: "Aprobado, en cola", cls: "e-cola" },
  en_intranet: { label: "En Intranet", cls: "e-info" },
  alta_manual: { label: "En Intranet (a mano)", cls: "e-info" },
  en_umbraco: { label: "Publicado en la web", cls: "e-ok" },
  error_intranet: { label: "Error en Intranet", cls: "e-err" },
  error_umbraco: { label: "Error en Umbraco", cls: "e-err" },
  cancelado: { label: "Cancelado", cls: "e-off" },
};

export function chipEstado(e) {
  const s = ESTADOS[e.estado] || { label: e.estado, cls: "e-off" };
  let label = s.label;
  if (e.estado === "para_revisar" && e.id_actividad) label = "Cambios para revisar";
  if (e.estado === "aprobado" && e.accion_pendiente === "modificar") label = "Cambios aprobados, en cola";
  if (e.accion_pendiente === "baja") label = "Baja en cola";
  const id = e.id_actividad ? ` <span class="muted">#${e.id_actividad}</span>` : "";
  return `<span class="estado ${e.accion_pendiente === "baja" ? "e-cola" : s.cls}">${esc(label)}</span>${id}`;
}

/* ================= simulación: cómo queda en Intranet y en Umbraco ================= */
const etiquetas = (lista, codes) => [].concat(codes ?? []).filter((c) => c !== null && c !== "")
  .map((c) => lista.find((o) => o.code === c)?.label || c).join(", ") || "—";
const conCodigo = (lista, codes) => {
  const cs = [].concat(codes ?? []).filter((c) => c !== null && c !== "");
  return cs.length ? `${etiquetas(lista, cs)} (${cs.join(", ")})` : "—";
};

/** Lo que se manda a GRABA_ACTIV.ASP, campo por campo: [parámetro, qué es, valor legible]. */
export function simularIntranet(e) {
  const [a, m, d] = (e.fecha || "").split("-");
  return [
    ["TitActiv", "Título", e.titulo],
    ["copete", "Copete", e.copete || "—"],
    ["DescActiv", "Descripción", e.descripcion || "—"],
    ["FID/FIM/FIA", "Fecha (inicio = fin)", e.fecha ? `${fechaLarga(e.fecha)} (${d}/${m}/${a})` : "—"],
    ["HoraIni / HoraFin", "Horario", `${e.hora_ini || "—"} a ${e.hora_fin || "—"}`],
    ["sede", "Sede", `${sedeLabel(e.sede)} (${e.sede || "—"})`],
    ["Categ", "Categoría", conCodigo(CATEG, e.categ)],
    ["Perfil", "Audiencia", conCodigo(PERFIL, e.perfil)],
    ["Sector", "Sector organizador", conCodigo(SECTORES, e.sector)],
    ["origencrm", "Origen CRM", conCodigo(ORIGEN_CRM, e.origen_crm)],
    ["CategCrm", "Categoría CRM", conCodigo(CATEG_CRM, e.categ_crm)],
    ["RequiereInscripcion", "Requiere inscripción", e.requiere_inscripcion ? "Sí" : "No"],
    ["Cupo", "Cupo", e.cupo || "Sin cupo"],
    ["fijos", "Valores fijos", "Libre (L) · Gratuita (G) · Español (E)"],
  ];
}

const facultadLinda = (f) => String(f || "").toLowerCase()
  .replace(/(^|\s)(\p{L})/gu, (_, s, l) => s + l.toUpperCase())
  .replace(/\b(De|Del|Y|La|Las|Los|En)\b/g, (w) => w.toLowerCase());

/**
 * Lo que va a aplicar el paso de Umbraco cuando el evento llegue con la sincronización.
 * Se calcula antes del alta: la carrera y la sede las eligió el REN; la facultad sale de la carrera.
 */
export function simularUmbraco(e, catalogo = []) {
  const carreras = (e.carreras || []).map((c) => {
    const cat = catalogo.find((x) => x.key === c.key);
    const nodo = cat?.variantes?.[c.variante];
    return { pagina: nodo?.nombre || c.nombre, url: nodo?.url || "", version: VAR_LABEL[c.variante] || c.variante, facultad: c.facultad };
  });
  const schools = [...new Set(carreras.map((c) => c.facultad).filter(Boolean))].map(facultadLinda);
  const site = SITES_UMBRACO[e.sede];
  return {
    nombre: e.titulo,
    carreras,
    schools,
    site: site || null,
    siteNota: site ? "" : e.sede === "O" ? "Online no lleva sede en Sites" : e.sede === "M" ? "Monserrat no lleva sede en Sites" : "",
    switchTxt: "Apagado (así la sincronización no pisa la carrera)",
  };
}

/**
 * Controles del panel. "bloquea" = no se puede aprobar así; "aviso" = conviene mirarlo.
 * La ortografía va aparte (es asíncrona).
 */
export function alertasEvento(e) {
  const a = [];
  const bloquea = (txt) => a.push({ nivel: "bloquea", txt });
  const aviso = (txt, fix) => a.push({ nivel: "aviso", txt, fix });
  if (!e.fecha) bloquea("Falta la fecha.");
  else if (e.fecha < hoyISO()) bloquea("La fecha ya pasó.");
  if (e.hora_ini && e.hora_fin && aMin(e.hora_fin) <= aMin(e.hora_ini)) bloquea("La hora de fin es anterior a la de inicio.");
  if (esRI(e.tipo) && !e.carreras?.length) bloquea("Es una RI y no tiene carrera.");
  if (e.sede === "O" && !/^https?:\/\/\S+\.\S+$/i.test((e.copete || "").trim())) bloquea("Es online y el copete no tiene el link de la reunión.");
  const ph = `${e.titulo} ${e.copete} ${e.descripcion}`.match(/\[\[([^\]]+)\]\]/);
  if (ph) bloquea(`Falta completar "${ph[1]}" (está entre [[ ]]).`);
  if (/\[carrera\]|dd\/mm/.test(e.titulo || "")) bloquea("Al título le falta la carrera o la fecha.");
  if (!e.sector?.length) bloquea("No tiene sector organizador.");

  const tMay = corregirMayusculas(e.titulo || "");
  if (tMay !== e.titulo) aviso(`Mayúsculas del título. Quedaría: "${tMay}".`, "mayusculas");
  if (e.sede === "O" && esRI(e.tipo) && !/online/i.test(e.titulo || "")) aviso('Es online y el título no dice "Online".');
  if (e.sede && e.sede !== "O" && /reuni[oó]n informativa online/i.test(e.titulo || "")) aviso('El título dice "Online" pero la reunión es presencial.');
  if (e.sede === "O" && /te esperamos en/i.test(e.descripcion || "")) aviso("Es online y la descripción tiene una dirección.");
  if (e.fecha && e.titulo && esRI(e.tipo) && !(e.titulo || "").includes(`(${ddmm(e.fecha)})`)) aviso(`El título no tiene la fecha (${ddmm(e.fecha)}).`);
  return a;
}
