import {
  SEDES, TIPOS, CATEG, PERFIL, SECTORES, ORIGEN_CRM, CATEG_CRM, CATEG_POR_ORIGEN, defaultsPara, copyGeneral,
  CUENTAS, CUENTA_DEFECTO, TIPOS_POR_NIVEL, requiereInscripcion, SECTOR_SIN_CARRERA,
} from "./config.js";
import { store, tanda as tandaStore, uid, modoPrueba, soloMemoria } from "./store.js";
import {
  $, $$, esc, norm, sedeLabel, hoyISO, ddmm, fechaLarga, aMin, aHHMM, HORAS, esRI, VAR_LABEL, toast, dialogo,
  tituloAuto, uadeMayus, uadeEnVivo, corregirMayusculas, revisarOrtografia, ESTADOS, chipEstado, CONECTORES,
} from "./comun.js";

/* ================= catálogo de carreras ================= */
let CARRERAS = [];

/**
 * Versión de la carrera (página de Umbraco) que se propone al elegirla. NO depende de dónde se hace la reunión:
 * sale de la cuenta (Online → online, Costa → costa, el resto → presencial). El REN la cambia en el chip.
 */
function resolverVariante(c, preferida = perfil.variante) {
  const v = c.variantes;
  const elegida = [preferida, "normal", "costa", "online"].find((p) => v[p]);
  let nota = "";
  if (elegida !== preferida) {
    nota = preferida === "normal" ? `Solo existe la versión ${VAR_LABEL[elegida]}`
      : `No tiene versión ${VAR_LABEL[preferida]}: se usa la ${VAR_LABEL[elegida].toLowerCase()}`;
  }
  return { variante: elegida, nota };
}

function carreraSeleccion(c, variante, nota = "") {
  const r = variante && c.variantes[variante] ? { variante, nota } : resolverVariante(c);
  const nodo = c.variantes[r.variante];
  return {
    key: c.key, corto: c.corto, base: c.base, facultad: c.facultad, sector: c.sector, nivel: c.nivel,
    variante: r.variante, variante_manual: !!variante, nota: r.nota, id: nodo.id, udi: nodo.udi, nombre: nodo.nombre,
  };
}

/** Nivel de carreras que se puede elegir: el de la RI, o el de la cuenta en Talleres OVO y Eventos. */
const nivelCarreras = (tipo) => (tipo === "ri_grado" || tipo === "ovo") ? "grado" : tipo === "ri_posgrado" ? "posgrado"
  : perfil.nivel === "todos" ? null : perfil.nivel;

function buscarCarreras(q, tipo, excluir) {
  const tokens = norm(q).split(/\s+/).filter(Boolean);
  const soloNivel = nivelCarreras(tipo);
  const nivel = soloNivel || "grado";
  return CARRERAS
    .filter((c) => !excluir.has(c.key) && (!soloNivel || c.nivel === soloNivel))
    .map((c) => {
      const hay = norm(c.corto + " " + c.base);
      if (!tokens.every((t) => hay.includes(t))) return null;
      let score = 0;
      if (c.nivel === nivel) score -= 100;
      if (tokens.length && norm(c.corto).startsWith(tokens[0])) score -= 10;
      if (tokens.length && hay.split(/\s+/).some((w) => w.startsWith(tokens[0]))) score -= 5;
      return { c, score: score + (tokens.length ? c.corto.length / 100 : 0) };
    })
    .filter(Boolean)
    .sort((a, b) => a.score - b.score || norm(a.c.corto).localeCompare(norm(b.c.corto)))
    .slice(0, 40)
    .map((x) => x.c);
}

/* ================= estado del formulario ================= */
let perfil = CUENTA_DEFECTO; // qué puede cargar la cuenta (grado / posgrado / todos)
const tiposPermitidos = () => TIPOS.filter((t) => TIPOS_POR_NIVEL[perfil.nivel].includes(t.code));

const vacio = () => ({
  id: null, tipo: tiposPermitidos()[0].code, carreras: [], sede: "", fecha: "", hora_ini: "", hora_fin: "",
  categ: [8], perfil: [3, 100], sector: [], origen_crm: "R", categ_crm: 12, requiere_inscripcion: true,
  titulo: "", titulo_manual: false, copete: "", descripcion: "", desc_manual: false, cupo: null,
  tocados: [], // campos de "Más opciones" que el REN cambió a mano (no se recalculan solos)
});

let ev = vacio();
let editando = null; // { origen: "tanda" | "mis", id }
let tanda = tandaStore.get();
let misEventos = [];
let filtroMis = "todos";
let alcance = "mios"; // "mios" | "todos" (los eventos de todos los RENs)
let paso = 1;          // paso visible del formulario (1 a 5)
const PASOS = 5;
// En qué paso está cada campo (para saltar al error)
const PASO_DE = { carreras: 2, perfil: 3, sector: 3, sede: 4, fecha: 4, titulo: 5, copete: 5, descripcion: 5 };

function sectoresAuto(e) {
  const s = [...new Set(e.carreras.map((c) => c.sector).filter(Boolean))];
  if (!s.length && e.tipo === "ovo") s.push(SECTOR_SIN_CARRERA.ovo);
  if (!s.length && (e.tipo === "ri_posgrado" || perfil.nivel === "posgrado")) s.push(SECTOR_SIN_CARRERA.posgrado);
  if (e.sede === "C" && !s.includes(257)) s.push(257);
  return s;
}

/** Recalcula todo lo automático que el REN no tocó a mano. */
function recalcular() {
  const d = defaultsPara(ev.tipo);
  ev.categ = [...d.categ]; // fija
  for (const k of ["perfil", "origen_crm", "categ_crm"]) if (!ev.tocados.includes(k)) ev[k] = structuredClone(d[k]);
  ev.requiere_inscripcion = requiereInscripcion(ev.tipo); // fija según el tipo
  if (!ev.tocados.includes("sector")) ev.sector = sectoresAuto(ev);
  ev.carreras = ev.carreras.map((c) => {
    const cat = CARRERAS.find((x) => x.key === c.key);
    return cat ? carreraSeleccion(cat, c.variante, c.nota) : c;
  });
  if (!ev.titulo_manual) ev.titulo = tituloAuto(ev);
  if (!ev.desc_manual) ev.descripcion = ev.sede || !esRI(ev.tipo) ? copyGeneral(ev.tipo, ev.sede, ev.sector[0]) : "";
}

/* ================= render del formulario ================= */
function segmentado(el, opciones, actual, onPick, conHint = false) {
  el.innerHTML = opciones.map((o) =>
    `<button type="button" data-v="${o.code}" aria-pressed="${o.code === actual}">${esc(o.label)}${conHint ? `<small>${esc(o.hint)}</small>` : ""}</button>`).join("");
  el.onclick = (e) => { const b = e.target.closest("button"); if (b) onPick(b.dataset.v); };
}

function checks(el, opciones, seleccion, campo) {
  el.innerHTML = opciones.map((o) =>
    `<label><input type="checkbox" value="${o.code}" ${seleccion.includes(o.code) ? "checked" : ""}> ${esc(o.label)}</label>`).join("");
  el.onchange = () => {
    ev[campo] = $$("input:checked", el).map((i) => Number(i.value));
    if (!ev.tocados.includes(campo)) ev.tocados.push(campo);
    if (campo === "sector" && !ev.desc_manual) recalcular();
    render();
  };
}

function options(sel, opciones, actual) {
  sel.innerHTML = opciones.map((o) => `<option value="${o.code}" ${String(o.code) === String(actual) ? "selected" : ""}>${esc(o.label)}</option>`).join("");
}

function renderChips() {
  $("#chips").innerHTML = ev.carreras.map((c, i) => {
    const cat = CARRERAS.find((x) => x.key === c.key);
    const vs = cat ? Object.keys(cat.variantes) : [c.variante];
    const selector = vs.length > 1
      ? `<select data-i="${i}" aria-label="Versión">${vs.map((v) => `<option value="${v}" ${v === c.variante ? "selected" : ""}>${VAR_LABEL[v]}</option>`).join("")}</select>`
      : `<span class="tag">${VAR_LABEL[c.variante]}</span>`;
    return `<div class="chip">
      <span class="chip-name">${esc(c.corto)}</span>
      <button type="button" class="chip-x" data-quitar="${i}" title="Quitar">×</button>
      <span class="chip-node">${selector}<span title="Nodo de Umbraco">${esc(c.nombre)}</span>${c.nota ? `<span class="note">· ${esc(c.nota)}</span>` : ""}</span>
    </div>`;
  }).join("");
}

const NIVEL_TXT = { grado: "Tu cuenta carga eventos de carreras de grado.", posgrado: "Tu cuenta carga eventos de posgrado.",
  todos: "Tu cuenta puede cargar eventos de grado y de posgrado." };

function render() {
  segmentado($("#seg-tipo"), tiposPermitidos(), ev.tipo, (v) => {
    if (v === ev.tipo) return;
    ev.tipo = v;
    const nivel = nivelCarreras(v); // si cambia de grado a posgrado, las carreras elegidas ya no sirven
    if (nivel) ev.carreras = ev.carreras.filter((c) => c.nivel === nivel);
    recalcular(); render();
  }, true);
  $("#tipo-cuenta").textContent = NIVEL_TXT[perfil.nivel];
  segmentado($("#seg-sede"), SEDES, ev.sede, (v) => { ev.sede = v; recalcular(); render(); limpiarError("sede"); limpiarError("copete"); });
  $("#carrera-opcional").hidden = esRI(ev.tipo);
  renderChips();

  $("#fecha").value = ev.fecha;
  $("#hora-ini").value = ev.hora_ini;
  $("#hora-fin").value = ev.hora_fin;

  const t = $("#titulo");
  if (document.activeElement !== t) t.value = ev.titulo;
  t.placeholder = esRI(ev.tipo) ? "" : "Ej. Fashion Watch + Talk (27/11)";
  $("#titulo-count").textContent = `${ev.titulo.length}/100`;
  $("#titulo-auto").textContent = !esRI(ev.tipo) ? "" : ev.titulo_manual ? "· editado a mano" : "· automático";
  $("#btn-titulo-auto").hidden = !(ev.titulo_manual && esRI(ev.tipo));

  const online = ev.sede === "O";
  $("#copete-lbl").innerHTML = online ? 'Link de la reunión online <span class="muted">(obligatorio)</span>' : 'Copete <span class="muted">(opcional)</span>';
  $("#copete").placeholder = online ? "https://… (Zoom, Teams o Meet)" : "";
  $("#copete").spellcheck = !online;
  if (document.activeElement !== $("#copete")) $("#copete").value = ev.copete;
  const d = $("#descripcion");
  if (document.activeElement !== d) d.value = ev.descripcion;
  $("#desc-count").textContent = `${ev.descripcion.length}/3000`;

  $("#categ-fija").textContent = ev.categ.map((c) => CATEG.find((o) => o.code === c)?.label || c).join(", ");
  $("#insc-fija").textContent = ev.requiere_inscripcion ? "Sí (siempre, salvo en Talleres OVO)" : "No (los Talleres OVO no llevan inscripción)";
  checks($("#ck-perfil"), PERFIL, ev.perfil, "perfil");
  checks($("#ck-sector"), SECTORES, ev.sector, "sector");
  options($("#origen-crm"), ORIGEN_CRM, ev.origen_crm);
  options($("#categ-crm"), CATEG_CRM, ev.categ_crm);
  $("#cupo").value = ev.cupo ?? "";


  $("#form-title").textContent = editando ? "Editar evento" : "Nuevo evento";
  $("#btn-agregar").textContent = editando?.origen === "mis" ? "Guardar y reenviar"
    : editando ? "Guardar cambios" : "Agregar a la tanda";
  $("#btn-limpiar").textContent = editando ? "Cancelar edición" : "Limpiar";
  renderPaso();
  renderTanda();
}

/* ================= pasos ================= */
function renderPaso() {
  $$(".paso").forEach((f) => (f.hidden = Number(f.dataset.paso) !== paso));
  $$("#pasos button").forEach((b) => {
    const n = Number(b.dataset.paso);
    b.setAttribute("aria-current", n === paso ? "step" : "false");
    b.classList.toggle("hecho", n < paso);
  });
  $("#btn-anterior").hidden = paso === 1;
  $("#btn-siguiente").hidden = paso === PASOS;
  // al editar se puede guardar desde cualquier paso; al cargar uno nuevo, al final
  $("#btn-agregar").hidden = paso !== PASOS && !editando;
  $("#paso-de").textContent = `Paso ${paso} de ${PASOS}`;
}

function irAPaso(n, enfocar = true) {
  paso = Math.min(Math.max(n, 1), PASOS);
  renderPaso();
  if (enfocar) $("#form").scrollIntoView({ behavior: "smooth", block: "start" });
}

/** Errores de un paso (para no dejar avanzar con algo mal). */
function erroresDelPaso(n) {
  leerTextos();
  const err = validar(ev, ev.id);
  return Object.fromEntries(Object.entries(err).filter(([k]) => PASO_DE[k] === n));
}

/** Toma lo escrito en los campos de texto (con UADE en mayúsculas). */
function leerTextos() {
  ev.titulo = uadeMayus($("#titulo").value.trim());
  ev.copete = uadeMayus($("#copete").value.trim());
  ev.descripcion = uadeMayus($("#descripcion").value);
}

/* ================= combo de carreras ================= */
const facultadCorta = (f) => f.replace(/^FACULTAD DE /, "Fac. de ").toLowerCase()
  .replace(/\S+/g, (w, i) => (i > 0 && CONECTORES.has(w) ? w : w[0].toUpperCase() + w.slice(1)));

let sugActual = [];
let sugIdx = 0;
function abrirSugerencias(forzar = false) {
  const q = $("#buscar-carrera").value;
  const ul = $("#sugerencias");
  sugActual = buscarCarreras(q, ev.tipo, new Set(ev.carreras.map((c) => c.key)));
  sugIdx = 0;
  if (!q.trim() && forzar !== true) { ul.hidden = true; return; } // vacío: se abre solo con ↓
  ul.innerHTML = sugActual.length
    ? sugActual.map((c, i) => `<li role="option" data-i="${i}" aria-selected="${i === sugIdx}">
        <span>${esc(c.corto)}<span class="fac">${esc(facultadCorta(c.facultad))}</span></span>
        <span class="tags">${Object.keys(c.variantes).map((v) => `<span class="tag">${VAR_LABEL[v]}</span>`).join("")}</span>
      </li>`).join("")
    : `<li class="vacio">No hay carreras con "${esc(q)}"</li>`;
  ul.hidden = false;
}
function elegirSugerencia(i) {
  const c = sugActual[i];
  if (!c) return;
  ev.carreras.push(carreraSeleccion(c));
  $("#buscar-carrera").value = "";
  $("#sugerencias").hidden = true;
  recalcular(); render(); limpiarError("carreras");
  $("#buscar-carrera").focus();
}
function moverSug(delta) {
  const lis = $$("#sugerencias li[data-i]");
  if (!lis.length) return;
  sugIdx = (sugIdx + delta + lis.length) % lis.length;
  lis.forEach((li, i) => li.setAttribute("aria-selected", i === sugIdx));
  lis[sugIdx].scrollIntoView({ block: "nearest" });
}

/* ================= validación ================= */
function validar(e, idPropio) {
  const err = {};
  if (esRI(e.tipo) && !e.carreras.length) err.carreras = "Elegí al menos una carrera.";
  if (!e.sede) err.sede = "Elegí la sede o modalidad.";
  if (!e.fecha) err.fecha = "Poné la fecha.";
  else if (e.fecha < hoyISO()) err.fecha = "La fecha ya pasó.";
  else if (!e.hora_ini || !e.hora_fin) err.fecha = "Elegí hora de inicio y de fin.";
  else if (aMin(e.hora_fin) <= aMin(e.hora_ini)) err.fecha = "La hora de fin tiene que ser posterior a la de inicio.";
  const t = e.titulo.trim();
  if (t.length < 3) err.titulo = "El título es muy corto.";
  else if (t.length > 100) err.titulo = "El título no puede pasar los 100 caracteres.";
  else if (/\[carrera\]|dd\/mm/.test(t)) err.titulo = "Al título le falta la carrera o la fecha.";
  if (e.sede === "O" && !/^https?:\/\/\S+\.\S+$/i.test((e.copete || "").trim()))
    err.copete = "Pegá el link de la reunión online (empieza con https://).";
  if (e.descripcion.length > 3000) err.descripcion = "La descripción no puede pasar los 3000 caracteres.";
  const ph = e.descripcion.match(/\[\[([^\]]+)\]\]/);
  if (ph) err.descripcion = `Completá "${ph[1]}" en la descripción (está entre [[ ]]).`;
  if (!e.perfil.length) err.perfil = "Elegí al menos una audiencia.";
  if (!e.sector.length) err.sector = "Elegí el sector organizador.";

  if (!err.fecha && e.carreras.length) {
    const keys = new Set(e.carreras.map((c) => c.key));
    const choca = (x) => x.id !== idPropio && x.estado !== "cancelado" && x.fecha === e.fecha && x.hora_ini === e.hora_ini
      && (x.carreras || []).some((c) => keys.has(c.key));
    const dup = tanda.find(choca) || misEventos.find(choca);
    if (dup) err.fecha = `Ya existe "${dup.titulo}" con la misma carrera, fecha y hora.`;
  }
  return err;
}

function mostrarErrores(err, saltar = true) {
  $$("[data-err]").forEach((p) => { p.textContent = err[p.dataset.err] || ""; });
  $("#combo").classList.toggle("is-invalid", !!err.carreras);
  $("#titulo").classList.toggle("is-invalid", !!err.titulo);
  $("#copete").classList.toggle("is-invalid", !!err.copete);
  $("#descripcion").classList.toggle("is-invalid", !!err.descripcion);
  $("#fecha").classList.toggle("is-invalid", !!err.fecha && !ev.fecha);
  // marca en rojo los pasos con errores y lleva al primero
  const conError = new Set(Object.keys(err).map((k) => PASO_DE[k]).filter(Boolean));
  $$("#pasos button").forEach((b) => b.classList.toggle("con-error", conError.has(Number(b.dataset.paso))));
  if (saltar && conError.size) {
    const primero = Math.min(...conError);
    irAPaso(primero, false);
    const k = Object.keys(err).find((x) => PASO_DE[x] === primero);
    $(`[data-err="${k}"]`)?.closest(".paso")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}
function limpiarError(k) {
  const p = $(`[data-err="${k}"]`); if (p) p.textContent = "";
  if (k === "carreras") $("#combo").classList.remove("is-invalid");
  if (k === "copete") $("#copete").classList.remove("is-invalid");
  const n = PASO_DE[k];
  if (n && !$$(`.paso[data-paso="${n}"] .err`).some((x) => x.textContent)) $(`#pasos button[data-paso="${n}"]`)?.classList.remove("con-error");
}

const CAMPO_LABEL = { titulo: "Título", copete: "Copete", descripcion: "Descripción" };

/** Antes de agregar: avisa mayúsculas y errores de ortografía. true = seguir, false = volver a editar. */
async function revisarTextos() {
  const campos = ev.sede === "O" ? {} : { copete: ev.copete || "" }; // si es online, el copete es un link
  if (ev.titulo_manual || !esRI(ev.tipo)) campos.titulo = ev.titulo;
  if (ev.desc_manual) campos.descripcion = ev.descripcion;

  const btn = $("#btn-agregar"), txt = btn.textContent;
  btn.disabled = true; btn.textContent = "Revisando ortografía…";
  const errores = await revisarOrtografia(campos, CARRERAS);
  btn.disabled = false; btn.textContent = txt;
  if (errores === null) toast("No se pudo revisar la ortografía: revisala a ojo.");

  const lista = errores || [];
  const tituloMay = corregirMayusculas(ev.titulo);
  const faltanMay = tituloMay !== ev.titulo;
  if (!faltanMay && !lista.length) return true;

  const opcion = (valor, label, sel) =>
    `<button type="button" class="rev-opt" data-valor="${esc(valor)}" aria-pressed="${sel}">${esc(label)}</button>`;
  const items = [];
  if (faltanMay) {
    // marca en rojo las palabras que quedaron en minúscula (la corrección solo cambia letras, así que los tokens coinciden)
    const corr = tituloMay.split(/(\s+)/);
    const marcado = ev.titulo.split(/(\s+)/).map((w, i) => (w !== corr[i] ? `<mark>${esc(w)}</mark>` : esc(w))).join("");
    items.push(`<div class="rev-item" data-rev="may">
      <div class="rev-head"><b>Mayúsculas en el título</b><span class="muted small">En la web cada palabra del título va con mayúscula (salvo de, en, y…).</span></div>
      <div class="rev-mal"><span class="rev-lbl">Lo escribiste así:</span> ${marcado}</div>
      <div class="rev-bien"><span class="rev-lbl">Así queda:</span> ${esc(tituloMay)}</div>
      <div class="rev-opts">${opcion("si", "Aplicar mayúsculas", true)}${opcion("no", "Dejar así", false)}</div></div>`);
  }
  lista.forEach((e, i) => {
    items.push(`<div class="rev-item" data-rev="${i}">
      <div class="rev-head"><b>${e.ortografia ? "Ortografía" : "Gramática"} · ${CAMPO_LABEL[e.campo]}</b></div>
      <div class="rev-mal"><span class="rev-lbl">Lo escribiste así:</span> ${e.recorteIni ? "…" : ""}${esc(e.antes)}<mark>${esc(e.error)}</mark>${esc(e.despues)}${e.recorteFin ? "…" : ""}</div>
      <div class="rev-opts">${e.sugerencias.map((s, j) => opcion(s, s, j === 0 && e.ortografia)).join("")}${opcion("", "Dejar así", !e.ortografia)}</div></div>`);
  });

  // recordatorio sutil: cuenta cuántas veces se le marcaron errores en este navegador
  let veces = 1;
  try { veces = Number(localStorage.getItem("uade_alta_avisos_ortografia") || 0) + 1; localStorage.setItem("uade_alta_avisos_ortografia", veces); } catch { /* sin storage */ }
  const recordatorio = veces > 1
    ? `Ya te marcamos errores ${veces - 1 === 1 ? "una vez" : `${veces - 1} veces`}. Lo que cargás se publica tal cual en la web: prestá atención a la ortografía.`
    : "Lo que cargás se publica tal cual en la web: prestá atención a la ortografía.";

  const n = items.length;
  const r = await dialogo({
    titulo: n === 1 ? "Revisá este detalle antes de agregar" : `Revisá estos ${n} detalles antes de agregar`,
    html: `<p class="rev-nota">${esc(recordatorio)}</p><div class="rev">${items.join("")}</div>
      <p class="muted small" style="margin:10px 0 0">Elegí la corrección o dejalo como está.</p>`,
    botones: [{ label: "Volver a editar" }, { label: "Aplicar y agregar", primary: true }],
  });
  if (r !== 1) return false;

  const elegido = (k) => $(`#dlg-content [data-rev="${k}"] .rev-opt[aria-pressed="true"]`)?.dataset.valor;
  // ortografía primero (las posiciones son del texto original), de atrás para adelante en cada campo
  const nuevos = { ...campos };
  lista.map((e, i) => ({ ...e, valor: elegido(i) })).filter((e) => e.valor)
    .sort((a, b) => b.ini - a.ini)
    .forEach((e) => { const s = nuevos[e.campo]; nuevos[e.campo] = s.slice(0, e.ini) + e.valor + s.slice(e.ini + e.largo); });
  if (nuevos.copete !== undefined) ev.copete = nuevos.copete;
  if (nuevos.descripcion !== undefined) ev.descripcion = nuevos.descripcion;
  if (nuevos.titulo !== undefined) ev.titulo = nuevos.titulo;
  if (faltanMay && elegido("may") === "si") ev.titulo = corregirMayusculas(ev.titulo);
  if (esRI(ev.tipo) && ev.titulo !== tituloAuto(ev)) ev.titulo_manual = true;
  return true;
}

/* ================= tanda ================= */
function guardarTanda() { tandaStore.set(tanda); }

function resumenEvento(e) {
  return `${fechaLarga(e.fecha)} · ${e.hora_ini}–${e.hora_fin} · ${sedeLabel(e.sede)}`;
}

/** Primer error de un evento de la tanda (o null). */
function errorTanda(e) { return Object.values(validar(e, e.id))[0] || null; }

function renderTanda() {
  $("#tanda-count").textContent = tanda.length;
  $("#tanda-empty").hidden = tanda.length > 0;
  $("#btn-vaciar").hidden = tanda.length === 0;
  $("#btn-confirmar").disabled = tanda.length === 0 || editando?.origen === "tanda";
  $("#btn-confirmar").textContent = tanda.length > 1 ? `Enviar ${tanda.length} eventos a revisión` : "Enviar a revisión";
  $("#tanda-list").innerHTML = tanda.map((e) => {
    const er = errorTanda(e);
    return `
    <li class="tanda-item ${editando?.id === e.id ? "is-editing" : ""} ${er ? "con-error" : ""}" data-id="${e.id}">
      <div class="ti-title">${esc(e.titulo)}</div>
      <div class="ti-meta">${esc(resumenEvento(e))}</div>
      ${er ? `<div class="ti-error">⚠ ${esc(er)}</div>` : ""}
      <div class="ti-actions">
        <button type="button" class="link ${er ? "corregir" : ""}" data-acc="editar">${er ? "Corregir" : "Editar"}</button>
        <button type="button" class="link" data-acc="duplicar">Duplicar</button>
        <button type="button" class="link danger" data-acc="quitar">Quitar</button>
      </div>
    </li>`;
  }).join("");
}

function cargarEnFormulario(e, origen) {
  ev = { ...vacio(), ...structuredClone(e) };
  editando = { origen, id: e.id };
  paso = 1;
  render();
  // si tiene errores, se muestran y se va directo al paso donde está el primero
  const err = validar(ev, ev.id);
  mostrarErrores(err);
  if (!Object.keys(err).length) $("#form").scrollIntoView({ behavior: "smooth", block: "start" });
}

function limpiarFormulario(conservar = false) {
  const base = vacio();
  if (conservar) { // tras agregar: deja tipo y sede, que suelen repetirse en la tanda
    base.tipo = ev.tipo; base.sede = ev.sede;
  }
  ev = base;
  editando = null;
  paso = 1;
  recalcular();
  mostrarErrores({});
  render();
}

async function onSubmit(evt) {
  evt.preventDefault();
  leerTextos();
  const err = validar(ev, ev.id);
  mostrarErrores(err);
  if (Object.keys(err).length) return;
  if (!(await revisarTextos())) return;

  const limpio = structuredClone(ev);
  if (editando?.origen === "mis") {
    try {
      await store.actualizar(limpio);
      toast("Cambios guardados: vuelven a revisión.");
      await cargarMis();
      limpiarFormulario();
      irA("mis");
    } catch (e) { toast("No se pudo guardar: " + e.message); }
    return;
  }
  if (editando?.origen === "tanda") {
    tanda = tanda.map((x) => (x.id === editando.id ? limpio : x));
    toast("Evento actualizado en la tanda.");
  } else {
    limpio.id = uid();
    tanda.push(limpio);
    toast("Agregado a la tanda.");
  }
  guardarTanda();
  limpiarFormulario(true);
}

async function confirmarTanda() {
  const conError = tanda.map((e) => [e, validar(e, e.id)]).filter(([, er]) => Object.keys(er).length);
  if (conError.length) {
    renderTanda(); // los marca en rojo en la tanda
    const n = conError.length;
    const r = await dialogo({
      titulo: n === 1 ? "Hay 1 evento para corregir" : `Hay ${n} eventos para corregir`,
      html: `<p>No se confirmó nada. ${n === 1 ? "Está marcado" : "Están marcados"} en rojo en la tanda.</p>
        <ul class="lista-err">${conError.map(([e, er]) => `<li><b>${esc(e.titulo)}</b><br><span class="ti-error">⚠ ${esc(Object.values(er)[0])}</span></li>`).join("")}</ul>`,
      botones: [{ label: "Cerrar" }, { label: n === 1 ? "Corregirlo ahora" : "Corregir el primero", primary: true }],
    });
    if (r === 1) cargarEnFormulario(conError[0][0], "tanda");
    return;
  }
  const r = await dialogo({
    titulo: tanda.length > 1 ? `¿Enviar ${tanda.length} eventos a revisión?` : "¿Enviar el evento a revisión?",
    html: `<p>Marketing los revisa y, cuando los aprueba, se dan de alta solos en Intranet${modoPrueba ? " <b>(modo prueba: no se envían)</b>" : ""}. Vas a ver el estado en <b>Mis eventos</b>.</p>
      <ul>${tanda.map((e) => `<li>${esc(e.titulo)} <span class="muted">· ${esc(resumenEvento(e))}</span></li>`).join("")}</ul>`,
    botones: [{ label: "Volver" }, { label: "Enviar a revisión", primary: true }],
  });
  if (r !== 1) return;
  try {
    await store.confirmar(tanda.map(({ id, ...rest }) => ({ ...rest })));
    tanda = []; guardarTanda();
    await cargarMis();
    renderTanda();
    toast("Enviado a revisión.");
    irA("mis");
  } catch (e) {
    toast("No se pudo confirmar: " + e.message);
  }
}

/* ================= mis eventos ================= */
const FILTROS = [
  { code: "todos", label: "Todos", f: () => true },
  { code: "revision", label: "En revisión", f: (e) => e.estado === "para_revisar" },
  { code: "devuelto", label: "Devueltos", f: (e) => e.estado === "devuelto" },
  { code: "cola", label: "En cola", f: (e) => e.estado === "aprobado" || e.accion_pendiente === "baja" },
  { code: "intranet", label: "En Intranet", f: (e) => ["en_intranet", "alta_manual"].includes(e.estado) },
  { code: "web", label: "En la web", f: (e) => e.estado === "en_umbraco" },
  { code: "error", label: "Con error", f: (e) => e.estado.startsWith("error") },
  { code: "cancelado", label: "Cancelados", f: (e) => e.estado === "cancelado" },
];

async function cargarMis() {
  misEventos = await store.listar();
  $("#mis-count").textContent = misEventos.filter((e) => e.propio && e.estado !== "cancelado").length;
  renderMis();
}

function renderMis() {
  const base = misEventos.filter((e) => alcance === "todos" || e.propio);
  const toggle = modoPrueba ? "" : `<button type="button" data-alcance="${alcance === "mios" ? "todos" : "mios"}" aria-pressed="${alcance === "todos"}">${alcance === "todos" ? "De todos los RENs" : "Solo míos"}</button>`;
  $("#filtros").innerHTML = toggle + FILTROS.map((f) => {
    const n = base.filter(f.f).length;
    return `<button type="button" data-f="${f.code}" aria-pressed="${f.code === filtroMis}">${f.label} <span class="muted">${n}</span></button>`;
  }).join("");
  const lista = base.filter(FILTROS.find((f) => f.code === filtroMis).f)
    .sort((a, b) => (a.fecha + a.hora_ini).localeCompare(b.fecha + b.hora_ini));
  $("#mis-empty").hidden = lista.length > 0;
  $("#tabla-mis").hidden = lista.length === 0;
  $("#tabla-mis tbody").innerHTML = lista.map((e) => `
    <tr data-id="${e.id}">
      <td><div>${esc(e.titulo)}</div><div class="t-sub">${esc(e.carreras.map((c) => c.nombre).join(" · ") || "Sin carrera")}${alcance === "todos" && e.creado_email ? ` · cargó ${esc(e.creado_email.split("@")[0])}` : ""}</div>
        ${e.error ? `<div class="t-sub" style="color:var(--err)">${esc(e.error)}</div>` : ""}
        ${e.estado === "devuelto" && e.revision_comentario ? `<div class="comentario-rev"><b>Marketing:</b> ${esc(e.revision_comentario)}</div>` : ""}</td>
      <td>${esc(fechaLarga(e.fecha))}<div class="t-sub">${e.hora_ini}–${e.hora_fin}</div></td>
      <td>${esc(sedeLabel(e.sede))}</td>
      <td>${chipEstado(e)}</td>
      <td>
        <button type="button" class="link" data-acc="ver">Ver</button>
        ${e.propio && e.estado !== "cancelado" && e.fecha >= hoyISO() ? `<button type="button" class="link ${e.estado === "devuelto" ? "corregir" : ""}" data-acc="editar">${e.estado === "devuelto" ? "Corregir" : "Editar"}</button>
        <button type="button" class="link danger" data-acc="cancelar">Cancelar</button>` : ""}
      </td>
    </tr>`).join("");
}

function verEvento(e) {
  const lab = (lista, codes) => [].concat(codes).map((c) => lista.find((o) => o.code === c)?.label || c).join(", ");
  const filas = [
    ["Estado", (ESTADOS[e.estado]?.label || e.estado) + (e.id_actividad ? ` · IdActividad ${e.id_actividad}` : "")],
    ...(e.revision_comentario ? [["Comentario de Marketing", e.revision_comentario]] : []),
    ["Carreras (Umbraco)", e.carreras.map((c) => c.nombre).join("\n") || "—"],
    ["Fecha", `${fechaLarga(e.fecha)} · ${e.hora_ini} a ${e.hora_fin}`],
    ["Sede", sedeLabel(e.sede)],
    ["Categoría", lab(CATEG, e.categ)],
    ["Audiencia", lab(PERFIL, e.perfil)],
    ["Sector", lab(SECTORES, e.sector)],
    ["Origen / Categ. CRM", `${lab(ORIGEN_CRM, e.origen_crm)} / ${lab(CATEG_CRM, e.categ_crm)}`],
    ["Inscripción / cupo", `${e.requiere_inscripcion ? "Sí" : "No"} / ${e.cupo || "—"}`],
    ["Copete", e.copete || "—"],
    ["Descripción", e.descripcion || "—"],
  ];
  dialogo({
    titulo: e.titulo,
    html: `<dl class="kv">${filas.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`,
    botones: [{ label: "Cerrar", primary: true }],
  });
}

/* ================= navegación y eventos ================= */
function irA(vista) {
  $$(".tab").forEach((t) => t.classList.toggle("is-active", t.dataset.view === vista));
  $("#tabs").hidden = vista === "login" || vista === "sin-cuenta";
  $("#view-login").hidden = vista !== "login";
  $("#view-sin-cuenta").hidden = vista !== "sin-cuenta";
  $("#view-nuevo").hidden = vista !== "nuevo";
  $("#view-mis").hidden = vista !== "mis";
  if (vista === "mis") renderMis();
}

function conectar() {
  $$(".tab").forEach((t) => (t.onclick = () => irA(t.dataset.view)));
  $("#form").addEventListener("submit", onSubmit);

  const inp = $("#buscar-carrera");
  inp.addEventListener("input", () => abrirSugerencias());
  inp.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); if ($("#sugerencias").hidden) abrirSugerencias(true); else moverSug(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); moverSug(-1); }
    else if (e.key === "Enter") { e.preventDefault(); if (!$("#sugerencias").hidden) elegirSugerencia(sugIdx); }
    else if (e.key === "Escape") { $("#sugerencias").hidden = true; }
    else if (e.key === "Backspace" && !inp.value && ev.carreras.length) { ev.carreras.pop(); recalcular(); render(); }
  });
  $("#sugerencias").addEventListener("mousedown", (e) => {
    const li = e.target.closest("li[data-i]"); if (li) { e.preventDefault(); elegirSugerencia(Number(li.dataset.i)); }
  });
  document.addEventListener("click", (e) => { if (!e.target.closest("#combo")) $("#sugerencias").hidden = true; });
  $("#combo").addEventListener("click", (e) => { if (e.target.id === "combo" || e.target.id === "chips") inp.focus(); });
  $("#chips").addEventListener("click", (e) => {
    const b = e.target.closest("[data-quitar]");
    if (b) { ev.carreras.splice(Number(b.dataset.quitar), 1); recalcular(); render(); }
  });
  $("#chips").addEventListener("change", (e) => {
    const s = e.target.closest("select[data-i]");
    if (!s) return;
    const c = ev.carreras[Number(s.dataset.i)];
    c.variante = s.value; c.variante_manual = true; c.nota = "";
    recalcular(); render();
  });

  $("#fecha").addEventListener("change", (e) => { ev.fecha = e.target.value; recalcular(); render(); limpiarError("fecha"); });
  $("#hora-ini").addEventListener("change", (e) => {
    const prevDur = ev.hora_ini && ev.hora_fin ? aMin(ev.hora_fin) - aMin(ev.hora_ini) : 60;
    ev.hora_ini = e.target.value;
    if (ev.hora_ini) ev.hora_fin = aHHMM(Math.min(aMin(ev.hora_ini) + (prevDur > 0 ? prevDur : 60), 23 * 60 + 45));
    render(); limpiarError("fecha");
  });
  $("#hora-fin").addEventListener("change", (e) => { ev.hora_fin = e.target.value; limpiarError("fecha"); });

  $("#titulo").addEventListener("input", (e) => {
    uadeEnVivo(e.target);
    ev.titulo = e.target.value; ev.titulo_manual = esRI(ev.tipo) ? e.target.value !== tituloAuto(ev) : true;
    $("#titulo-count").textContent = `${ev.titulo.length}/100`;
    $("#btn-titulo-auto").hidden = !(ev.titulo_manual && esRI(ev.tipo));
    $("#titulo-auto").textContent = !esRI(ev.tipo) ? "" : ev.titulo_manual ? "· editado a mano" : "· automático";
    limpiarError("titulo");
  });
  $("#btn-titulo-auto").onclick = () => { ev.titulo_manual = false; recalcular(); render(); };
  $("#copete").addEventListener("input", (e) => { uadeEnVivo(e.target); ev.copete = e.target.value; limpiarError("copete"); });
  $("#descripcion").addEventListener("input", (e) => {
    uadeEnVivo(e.target);
    ev.descripcion = e.target.value; ev.desc_manual = true;
    $("#desc-count").textContent = `${ev.descripcion.length}/3000`;
    limpiarError("descripcion");
  });
  $("#origen-crm").onchange = (e) => {
    ev.origen_crm = e.target.value; ev.tocados.push("origen_crm");
    if (CATEG_POR_ORIGEN[ev.origen_crm]) { ev.categ_crm = CATEG_POR_ORIGEN[ev.origen_crm]; ev.tocados.push("categ_crm"); }
    render();
  };
  $("#categ-crm").onchange = (e) => { ev.categ_crm = Number(e.target.value); ev.tocados.push("categ_crm"); render(); };
  $("#cupo").addEventListener("input", (e) => { const n = parseInt(e.target.value, 10); ev.cupo = n > 0 ? n : null; });

  // pasos: Siguiente solo avanza si el paso está bien; los números de arriba llevan a cualquier paso
  $("#btn-siguiente").onclick = () => {
    const err = erroresDelPaso(paso);
    mostrarErrores(err, false);
    if (Object.keys(err).length) return;
    irAPaso(paso + 1);
  };
  $("#btn-anterior").onclick = () => irAPaso(paso - 1);
  $("#pasos").addEventListener("click", (e) => { const b = e.target.closest("[data-paso]"); if (b) { leerTextos(); irAPaso(Number(b.dataset.paso)); } });

  $("#dlg-content").addEventListener("click", (e) => {
    const b = e.target.closest(".rev-opt"); if (!b) return;
    b.closest(".rev-opts").querySelectorAll(".rev-opt").forEach((x) => x.setAttribute("aria-pressed", x === b));
  });

  $("#btn-limpiar").onclick = () => limpiarFormulario();
  $("#btn-confirmar").onclick = confirmarTanda;
  $("#btn-vaciar").onclick = async () => {
    const r = await dialogo({ titulo: "¿Vaciar la tanda?", html: `<p>Se borran los ${tanda.length} eventos sin confirmar.</p>`,
      botones: [{ label: "Volver" }, { label: "Vaciar", primary: true }] });
    if (r === 1) { tanda = []; guardarTanda(); if (editando?.origen === "tanda") limpiarFormulario(); renderTanda(); }
  };
  $("#tanda-list").addEventListener("click", (e) => {
    const b = e.target.closest("[data-acc]"); if (!b) return;
    const id = b.closest("[data-id]").dataset.id;
    const item = tanda.find((x) => x.id === id);
    if (b.dataset.acc === "editar") cargarEnFormulario(item, "tanda");
    if (b.dataset.acc === "duplicar") {
      cargarEnFormulario({ ...item, id: null, fecha: "", hora_ini: item.hora_ini, hora_fin: item.hora_fin }, null);
      editando = null; render();
      toast("Copiado al formulario: cambiá la fecha y agregalo.");
      $("#fecha").focus();
    }
    if (b.dataset.acc === "quitar") {
      tanda = tanda.filter((x) => x.id !== id); guardarTanda();
      if (editando?.id === id) limpiarFormulario(); else renderTanda();
    }
  });

  $("#filtros").addEventListener("click", (e) => {
    const a = e.target.closest("[data-alcance]"); if (a) { alcance = a.dataset.alcance; renderMis(); return; }
    const b = e.target.closest("[data-f]"); if (b) { filtroMis = b.dataset.f; renderMis(); }
  });
  $("#tabla-mis").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-acc]"); if (!b) return;
    const item = misEventos.find((x) => x.id === b.closest("[data-id]").dataset.id);
    if (b.dataset.acc === "ver") verEvento(item);
    if (b.dataset.acc === "editar") { cargarEnFormulario(item, "mis"); irA("nuevo"); }
    if (b.dataset.acc === "cancelar") {
      const r = await dialogo({
        titulo: "¿Cancelar el evento?",
        html: `<p><b>${esc(item.titulo)}</b></p><p>${item.id_actividad ? "Se va a dar de baja en Intranet." : "Todavía no está en Intranet: no se va a dar de alta."}</p>`,
        botones: [{ label: "Volver" }, { label: "Cancelar evento", primary: true }],
      });
      if (r === 1) { await store.cancelar(item.id); await cargarMis(); toast("Evento cancelado."); }
    }
  });
}

/* ================= arranque ================= */
const AVISO_MEMORIA = '<div class="small">Este visor no deja guardar: lo que cargues se pierde al cerrar el archivo.</div>';
async function init() {
  const horas = `<option value="">—</option>` + HORAS.map((h) => `<option>${h}</option>`).join("");
  $("#hora-ini").innerHTML = horas;
  $("#hora-fin").innerHTML = horas;
  $("#fecha").min = hoyISO();
  $("#banner-prueba").hidden = !modoPrueba;
  if (modoPrueba && soloMemoria()) $("#banner-prueba").insertAdjacentHTML("beforeend", AVISO_MEMORIA);
  if (modoPrueba) { // en el modo prueba se elige qué cuenta simular
    const opciones = [["", CUENTA_DEFECTO.nombre], ...Object.entries(CUENTAS).map(([k, v]) => [k, v.nombre])];
    let guardada = ""; try { guardada = localStorage.getItem("uade_alta_simular") || ""; } catch { /* sin storage */ }
    $("#simular-cuenta").innerHTML = opciones.map(([k, n]) => `<option value="${k}" ${k === guardada ? "selected" : ""}>${esc(n)}</option>`).join("");
    perfil = CUENTAS[guardada] || CUENTA_DEFECTO;
    ev = vacio();
    $("#simular-cuenta").onchange = (e) => {
      try { localStorage.setItem("uade_alta_simular", e.target.value); } catch { /* sin storage */ }
      perfil = CUENTAS[e.target.value] || CUENTA_DEFECTO;
      limpiarFormulario();
    };
  }

  const r = await fetch("data/carreras.json");
  CARRERAS = (await r.json()).carreras;

  conectar();
  conectarLogin();
  recalcular();
  render();

  const u = await store.sesion();
  if (u) await entrar(u); else irA("login");
}

let dejarDeEscuchar = () => {};
async function entrar(u) {
  if (!modoPrueba) { // qué puede cargar sale de la tabla de cuentas de Supabase
    const cuenta = await store.miCuenta();
    if (!cuenta) return sinCuenta(u);
    perfil = { nivel: cuenta.nivel, variante: cuenta.variante, nombre: cuenta.nombre };
    limpiarFormulario();
  }
  $("#who").title = perfil.nombre || "";
  $("#who").textContent = u.email || (modoPrueba ? "Modo prueba" : "");
  $("#btn-salir").hidden = modoPrueba;
  store.esRevisor().then((ok) => { $("#link-panel").hidden = !ok; }).catch(() => {});
  irA("nuevo");
  await cargarMis();
  let t;
  dejarDeEscuchar = store.escuchar(() => { clearTimeout(t); t = setTimeout(cargarMis, 400); });
}

// Logueado pero sin cuenta activa: no carga. Si es revisor, se lo manda al panel.
async function sinCuenta(u) {
  const revisor = await store.esRevisor().catch(() => false);
  $("#who").textContent = u.email || "";
  $("#btn-salir").hidden = false;
  $("#link-panel").hidden = !revisor;
  $("#sin-cuenta-panel").hidden = !revisor;
  $("#sin-cuenta-tit").textContent = revisor ? "Tu cuenta es de revisión" : "Tu cuenta no está habilitada";
  $("#sin-cuenta-txt").textContent = revisor
    ? "No carga eventos: entrá al panel de control para revisarlos."
    : "Esta cuenta no puede cargar eventos. Pedile acceso a Marketing.";
  irA("sin-cuenta");
}

function conectarLogin() {
  $("#sin-cuenta-salir").onclick = () => $("#btn-salir").click();
  $("#form-login").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("#btn-entrar");
    $("#login-err").textContent = "";
    btn.disabled = true; btn.textContent = "Entrando…";
    try {
      await entrar(await store.entrar($("#login-email").value, $("#login-clave").value));
      $("#login-clave").value = "";
    } catch (err) {
      $("#login-err").textContent = err.message;
    } finally {
      btn.disabled = false; btn.textContent = "Entrar";
    }
  });
  $("#btn-salir").onclick = async () => {
    dejarDeEscuchar();
    await store.salir();
    misEventos = [];
    $("#who").textContent = ""; $("#btn-salir").hidden = true; $("#link-panel").hidden = true;
    irA("login");
  };
}

init().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML("afterbegin", `<div class="banner" style="background:var(--err-soft);color:var(--err)">No se pudo iniciar: ${esc(e.message)}</div>`);
});
