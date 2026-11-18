import {
  SEDES, TIPOS, CATEG, PERFIL, SECTORES, ORIGEN_CRM, CATEG_CRM, defaultsPara, copyGeneral,
} from "./config.js";
import { store, tanda as tandaStore, uid, modoPrueba } from "./store.js";

/* ================= utilidades ================= */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const sedeLabel = (c) => SEDES.find((s) => s.code === c)?.label || c || "—";
const hoyISO = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const ddmm = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : "dd/mm");
const fechaLarga = (iso) => {
  if (!iso) return "—";
  const dia = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"][new Date(iso + "T12:00:00").getDay()];
  return `${dia} ${ddmm(iso)}`;
};
const aMin = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
const aHHMM = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const HORAS = []; for (let m = 7 * 60; m <= 23 * 60 + 45; m += 15) HORAS.push(aHHMM(m));

function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 2600);
}

function dialogo({ titulo, html, botones }) {
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

/* ================= catálogo de carreras ================= */
let CARRERAS = [];
const VAR_LABEL = { normal: "Presencial", online: "Online", costa: "Costa" };

/** Elige el nodo de Umbraco según la sede (regla: si no existe la variante, va la normal con nota). */
function resolverVariante(c, sede) {
  const v = c.variantes;
  const pref = sede === "O" ? ["online", "normal", "costa"] : sede === "C" ? ["costa", "normal", "online"] : ["normal", "costa", "online"];
  const elegida = pref.find((p) => v[p]);
  let nota = "";
  if (elegida !== pref[0]) {
    nota = sede === "O" ? "No tiene versión Online: se usa la " + VAR_LABEL[elegida].toLowerCase()
      : sede === "C" ? "No tiene versión Costa: se usa la " + VAR_LABEL[elegida].toLowerCase()
      : `Solo existe la versión ${VAR_LABEL[elegida]}`;
  }
  return { variante: elegida, nota };
}

function carreraSeleccion(c, sede, variante) {
  const r = variante && c.variantes[variante] ? { variante, nota: "" } : resolverVariante(c, sede);
  const nodo = c.variantes[r.variante];
  return {
    key: c.key, corto: c.corto, base: c.base, facultad: c.facultad, sector: c.sector, nivel: c.nivel,
    variante: r.variante, variante_manual: !!variante, nota: r.nota, id: nodo.id, udi: nodo.udi, nombre: nodo.nombre,
  };
}

function buscarCarreras(q, tipo, excluir) {
  const tokens = norm(q).split(/\s+/).filter(Boolean);
  const nivel = tipo === "ri_posgrado" ? "posgrado" : "grado";
  return CARRERAS
    .filter((c) => !excluir.has(c.key))
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
const vacio = () => ({
  id: null, tipo: "ri_grado", carreras: [], sede: "", fecha: "", hora_ini: "", hora_fin: "",
  categ: [12], perfil: [3, 100], sector: [], origen_crm: "R", categ_crm: 12, requiere_inscripcion: false,
  titulo: "", titulo_manual: false, copete: "", descripcion: "", desc_manual: false, cupo: null,
  tocados: [], // campos de "Más opciones" que el REN cambió a mano (no se recalculan solos)
});

let ev = vacio();
let editando = null; // { origen: "tanda" | "mis", id }
let tanda = tandaStore.get();
let misEventos = [];
let filtroMis = "todos";

function tituloAuto(e) {
  const fecha = ddmm(e.fecha);
  if (e.tipo === "otro") return "";
  const prefijo = e.sede === "O" ? "Reunión Informativa Online" : "Reunión Informativa";
  const nombres = e.carreras.map((c) => c.corto + (c.variante === "online" ? " Online" : c.variante === "costa" ? " Costa" : ""));
  return `${prefijo}: ${nombres.join(" + ") || "[carrera]"} (${fecha})`;
}

function sectoresAuto(e) {
  const s = [...new Set(e.carreras.map((c) => c.sector).filter(Boolean))];
  if (e.sede === "C" && !s.includes(257)) s.push(257);
  return s;
}

/** Recalcula todo lo automático que el REN no tocó a mano. */
function recalcular() {
  const d = defaultsPara(ev.tipo, ev.sede);
  for (const k of ["categ", "perfil", "origen_crm", "categ_crm"]) if (!ev.tocados.includes(k)) ev[k] = structuredClone(d[k]);
  if (!ev.tocados.includes("sector")) ev.sector = sectoresAuto(ev);
  ev.carreras = ev.carreras.map((c) => {
    const cat = CARRERAS.find((x) => x.key === c.key);
    return cat ? carreraSeleccion(cat, ev.sede, c.variante_manual ? c.variante : null) : c;
  });
  if (!ev.titulo_manual) ev.titulo = tituloAuto(ev);
  if (!ev.desc_manual) ev.descripcion = ev.sede || ev.tipo === "otro" ? copyGeneral(ev.tipo, ev.sede, ev.sector[0]) : "";
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

function render() {
  segmentado($("#seg-tipo"), TIPOS, ev.tipo, (v) => { ev.tipo = v; recalcular(); render(); }, true);
  segmentado($("#seg-sede"), SEDES, ev.sede, (v) => { ev.sede = v; recalcular(); render(); limpiarError("sede"); });
  $("#carrera-opcional").hidden = ev.tipo !== "otro";
  renderChips();

  $("#fecha").value = ev.fecha;
  $("#hora-ini").value = ev.hora_ini;
  $("#hora-fin").value = ev.hora_fin;

  const t = $("#titulo");
  if (document.activeElement !== t) t.value = ev.titulo;
  t.placeholder = ev.tipo === "otro" ? "Ej. Fashion Watch + Talk (27/11)" : "";
  $("#titulo-count").textContent = `${ev.titulo.length}/100`;
  $("#titulo-auto").textContent = ev.tipo === "otro" ? "" : ev.titulo_manual ? "· editado a mano" : "· automático";
  $("#btn-titulo-auto").hidden = !(ev.titulo_manual && ev.tipo !== "otro");

  $("#copete").value = ev.copete;
  const d = $("#descripcion");
  if (document.activeElement !== d) d.value = ev.descripcion;
  $("#desc-count").textContent = `${ev.descripcion.length}/3000`;

  checks($("#ck-categ"), CATEG, ev.categ, "categ");
  checks($("#ck-perfil"), PERFIL, ev.perfil, "perfil");
  checks($("#ck-sector"), SECTORES, ev.sector, "sector");
  options($("#origen-crm"), ORIGEN_CRM, ev.origen_crm);
  options($("#categ-crm"), CATEG_CRM, ev.categ_crm);
  $("#cupo").value = ev.cupo ?? "";
  $("#req-insc").checked = ev.requiere_inscripcion;

  const lab = (lista, codes) => codes.map((c) => lista.find((o) => o.code === c)?.label).filter(Boolean).join(", ");
  $("#mas-resumen").textContent = `· ${lab(CATEG, ev.categ) || "sin categoría"} · ${lab(PERFIL, ev.perfil) || "sin audiencia"} · ` +
    `${ev.sector.length ? lab(SECTORES, ev.sector) : "sin sector"}`;

  $("#form-title").textContent = editando ? "Editar evento" : "Nuevo evento";
  $("#btn-agregar").textContent = editando?.origen === "mis" ? "Guardar y reenviar"
    : editando ? "Guardar cambios" : "Agregar a la tanda";
  $("#btn-limpiar").textContent = editando ? "Cancelar edición" : "Limpiar";
  renderTanda();
}

/* ================= combo de carreras ================= */
const CONECTORES = new Set(["de", "del", "la", "las", "los", "y", "e", "en"]);
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
  ev.carreras.push(carreraSeleccion(c, ev.sede, null));
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
  if ((e.tipo === "ri_grado" || e.tipo === "ri_posgrado") && !e.carreras.length) err.carreras = "Elegí al menos una carrera.";
  if (!e.sede) err.sede = "Elegí la sede o modalidad.";
  if (!e.fecha) err.fecha = "Poné la fecha.";
  else if (e.fecha < hoyISO()) err.fecha = "La fecha ya pasó.";
  else if (!e.hora_ini || !e.hora_fin) err.fecha = "Elegí hora de inicio y de fin.";
  else if (aMin(e.hora_fin) <= aMin(e.hora_ini)) err.fecha = "La hora de fin tiene que ser posterior a la de inicio.";
  const t = e.titulo.trim();
  if (t.length < 3) err.titulo = "El título es muy corto.";
  else if (t.length > 100) err.titulo = "El título no puede pasar los 100 caracteres.";
  else if (/\[carrera\]|dd\/mm/.test(t)) err.titulo = "Al título le falta la carrera o la fecha.";
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

function mostrarErrores(err) {
  $$("[data-err]").forEach((p) => { p.textContent = err[p.dataset.err] || ""; });
  $("#combo").classList.toggle("is-invalid", !!err.carreras);
  $("#titulo").classList.toggle("is-invalid", !!err.titulo);
  $("#descripcion").classList.toggle("is-invalid", !!err.descripcion);
  $("#fecha").classList.toggle("is-invalid", !!err.fecha && !ev.fecha);
  if (err.perfil || err.sector) $("#mas-opciones").open = true;
  const primero = Object.keys(err)[0];
  if (primero) $(`[data-err="${primero}"]`)?.closest(".field")?.scrollIntoView({ behavior: "smooth", block: "center" });
}
function limpiarError(k) { const p = $(`[data-err="${k}"]`); if (p) p.textContent = ""; if (k === "carreras") $("#combo").classList.remove("is-invalid"); }

/* ================= tanda ================= */
function guardarTanda() { tandaStore.set(tanda); }

function resumenEvento(e) {
  return `${fechaLarga(e.fecha)} · ${e.hora_ini}–${e.hora_fin} · ${sedeLabel(e.sede)}`;
}

function renderTanda() {
  $("#tanda-count").textContent = tanda.length;
  $("#tanda-empty").hidden = tanda.length > 0;
  $("#btn-vaciar").hidden = tanda.length === 0;
  $("#btn-confirmar").disabled = tanda.length === 0 || editando?.origen === "tanda";
  $("#btn-confirmar").textContent = tanda.length > 1 ? `Confirmar ${tanda.length} eventos` : "Confirmar y dar de alta";
  $("#tanda-list").innerHTML = tanda.map((e) => `
    <li class="tanda-item ${editando?.id === e.id ? "is-editing" : ""}" data-id="${e.id}">
      <div class="ti-title">${esc(e.titulo)}</div>
      <div class="ti-meta">${esc(resumenEvento(e))}</div>
      <div class="ti-actions">
        <button type="button" class="link" data-acc="editar">Editar</button>
        <button type="button" class="link" data-acc="duplicar">Duplicar</button>
        <button type="button" class="link danger" data-acc="quitar">Quitar</button>
      </div>
    </li>`).join("");
}

function cargarEnFormulario(e, origen) {
  ev = { ...vacio(), ...structuredClone(e) };
  editando = { origen, id: e.id };
  mostrarErrores({});
  render();
  $("#form").scrollIntoView({ behavior: "smooth", block: "start" });
}

function limpiarFormulario(conservar = false) {
  const base = vacio();
  if (conservar) { // tras agregar: deja tipo y sede, que suelen repetirse en la tanda
    base.tipo = ev.tipo; base.sede = ev.sede;
  }
  ev = base;
  editando = null;
  recalcular();
  mostrarErrores({});
  render();
}

async function onSubmit(evt) {
  evt.preventDefault();
  ev.titulo = $("#titulo").value.trim();
  ev.descripcion = $("#descripcion").value;
  const err = validar(ev, ev.id);
  mostrarErrores(err);
  if (Object.keys(err).length) return;

  const limpio = structuredClone(ev);
  if (editando?.origen === "mis") {
    try {
      await store.actualizar(limpio);
      toast("Cambios guardados: se reenvían a Intranet.");
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
  $("#buscar-carrera").focus();
}

async function confirmarTanda() {
  const conError = tanda.map((e) => [e, validar(e, e.id)]).filter(([, er]) => Object.keys(er).length);
  if (conError.length) {
    await dialogo({
      titulo: "Hay eventos para corregir",
      html: `<ul>${conError.map(([e, er]) => `<li><b>${esc(e.titulo)}</b>: ${esc(Object.values(er)[0])}</li>`).join("")}</ul>`,
      botones: [{ label: "Entendido", primary: true }],
    });
    return;
  }
  const r = await dialogo({
    titulo: tanda.length > 1 ? `¿Confirmar ${tanda.length} eventos?` : "¿Confirmar el evento?",
    html: `<p>Se dan de alta solos en Intranet${modoPrueba ? " <b>(modo prueba: no se envían)</b>" : ""}. Vas a ver el estado en <b>Mis eventos</b>.</p>
      <ul>${tanda.map((e) => `<li>${esc(e.titulo)} <span class="muted">· ${esc(resumenEvento(e))}</span></li>`).join("")}</ul>`,
    botones: [{ label: "Volver" }, { label: "Confirmar", primary: true }],
  });
  if (r !== 1) return;
  try {
    await store.confirmar(tanda.map(({ id, ...rest }) => ({ ...rest })));
    tanda = []; guardarTanda();
    await cargarMis();
    renderTanda();
    toast("Confirmado. Se están dando de alta en Intranet.");
    irA("mis");
  } catch (e) {
    toast("No se pudo confirmar: " + e.message);
  }
}

/* ================= mis eventos ================= */
const ESTADOS = {
  confirmado: { label: "En cola", cls: "e-cola" },
  en_intranet: { label: "En Intranet", cls: "e-info" },
  alta_manual: { label: "En Intranet (a mano)", cls: "e-info" },
  en_umbraco: { label: "Publicado en la web", cls: "e-ok" },
  error_intranet: { label: "Error en Intranet", cls: "e-err" },
  error_umbraco: { label: "Error en Umbraco", cls: "e-err" },
  cancelado: { label: "Cancelado", cls: "e-off" },
};
const FILTROS = [
  { code: "todos", label: "Todos", f: () => true },
  { code: "cola", label: "En cola", f: (e) => e.estado === "confirmado" || !!e.accion_pendiente },
  { code: "intranet", label: "En Intranet", f: (e) => ["en_intranet", "alta_manual"].includes(e.estado) },
  { code: "web", label: "En la web", f: (e) => e.estado === "en_umbraco" },
  { code: "error", label: "Con error", f: (e) => e.estado.startsWith("error") },
  { code: "cancelado", label: "Cancelados", f: (e) => e.estado === "cancelado" },
];

function chipEstado(e) {
  const s = ESTADOS[e.estado] || { label: e.estado, cls: "e-off" };
  let label = s.label;
  if (e.accion_pendiente === "modificar") label = "Cambios en cola";
  if (e.accion_pendiente === "baja") label = "Baja en cola";
  const id = e.id_actividad ? ` <span class="muted">#${e.id_actividad}</span>` : "";
  return `<span class="estado ${e.accion_pendiente && e.estado !== "confirmado" ? "e-cola" : s.cls}">${esc(label)}</span>${id}`;
}

async function cargarMis() {
  misEventos = await store.listar();
  $("#mis-count").textContent = misEventos.filter((e) => e.estado !== "cancelado").length;
  renderMis();
}

function renderMis() {
  $("#filtros").innerHTML = FILTROS.map((f) => {
    const n = misEventos.filter(f.f).length;
    return `<button type="button" data-f="${f.code}" aria-pressed="${f.code === filtroMis}">${f.label} <span class="muted">${n}</span></button>`;
  }).join("");
  const lista = misEventos.filter(FILTROS.find((f) => f.code === filtroMis).f)
    .sort((a, b) => (a.fecha + a.hora_ini).localeCompare(b.fecha + b.hora_ini));
  $("#mis-empty").hidden = lista.length > 0;
  $("#tabla-mis").hidden = lista.length === 0;
  $("#tabla-mis tbody").innerHTML = lista.map((e) => `
    <tr data-id="${e.id}">
      <td><div>${esc(e.titulo)}</div><div class="t-sub">${esc(e.carreras.map((c) => c.nombre).join(" · ") || "Sin carrera")}</div>
        ${e.error ? `<div class="t-sub" style="color:var(--err)">${esc(e.error)}</div>` : ""}</td>
      <td>${esc(fechaLarga(e.fecha))}<div class="t-sub">${e.hora_ini}–${e.hora_fin}</div></td>
      <td>${esc(sedeLabel(e.sede))}</td>
      <td>${chipEstado(e)}</td>
      <td>
        <button type="button" class="link" data-acc="ver">Ver</button>
        ${e.estado !== "cancelado" && e.fecha >= hoyISO() ? `<button type="button" class="link" data-acc="editar">Editar</button>
        <button type="button" class="link danger" data-acc="cancelar">Cancelar</button>` : ""}
      </td>
    </tr>`).join("");
}

function verEvento(e) {
  const lab = (lista, codes) => [].concat(codes).map((c) => lista.find((o) => o.code === c)?.label || c).join(", ");
  const filas = [
    ["Estado", (ESTADOS[e.estado]?.label || e.estado) + (e.id_actividad ? ` · IdActividad ${e.id_actividad}` : "")],
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
    c.variante = s.value; c.variante_manual = true;
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
  $("#quick-dur").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-min]");
    if (!b) return;
    if (!ev.hora_ini) { toast("Primero elegí la hora de inicio."); $("#hora-ini").focus(); return; }
    ev.hora_fin = aHHMM(Math.min(aMin(ev.hora_ini) + Number(b.dataset.min), 23 * 60 + 45));
    render();
  });

  $("#titulo").addEventListener("input", (e) => {
    ev.titulo = e.target.value; ev.titulo_manual = ev.tipo !== "otro" ? e.target.value !== tituloAuto(ev) : true;
    $("#titulo-count").textContent = `${ev.titulo.length}/100`;
    $("#btn-titulo-auto").hidden = !(ev.titulo_manual && ev.tipo !== "otro");
    $("#titulo-auto").textContent = ev.tipo === "otro" ? "" : ev.titulo_manual ? "· editado a mano" : "· automático";
    limpiarError("titulo");
  });
  $("#btn-titulo-auto").onclick = () => { ev.titulo_manual = false; recalcular(); render(); };
  $("#copete").addEventListener("input", (e) => (ev.copete = e.target.value));
  $("#descripcion").addEventListener("input", (e) => {
    ev.descripcion = e.target.value; ev.desc_manual = true;
    $("#desc-count").textContent = `${ev.descripcion.length}/3000`;
    limpiarError("descripcion");
  });
  $("#origen-crm").onchange = (e) => { ev.origen_crm = e.target.value; ev.tocados.push("origen_crm"); render(); };
  $("#categ-crm").onchange = (e) => { ev.categ_crm = Number(e.target.value); ev.tocados.push("categ_crm"); render(); };
  $("#cupo").addEventListener("input", (e) => { const n = parseInt(e.target.value, 10); ev.cupo = n > 0 ? n : null; });
  $("#req-insc").onchange = (e) => (ev.requiere_inscripcion = e.target.checked);

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

  $("#filtros").addEventListener("click", (e) => { const b = e.target.closest("[data-f]"); if (b) { filtroMis = b.dataset.f; renderMis(); } });
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
async function init() {
  const horas = `<option value="">—</option>` + HORAS.map((h) => `<option>${h}</option>`).join("");
  $("#hora-ini").innerHTML = horas;
  $("#hora-fin").innerHTML = horas;
  $("#fecha").min = hoyISO();
  $("#banner-prueba").hidden = !modoPrueba;

  const r = await fetch("data/carreras.json");
  CARRERAS = (await r.json()).carreras;

  const u = await store.usuario();
  $("#who").textContent = u.email || (modoPrueba ? "Modo prueba" : "");

  conectar();
  recalcular();
  render();
  await cargarMis();
}

init().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML("afterbegin", `<div class="banner" style="background:var(--err-soft);color:var(--err)">No se pudo iniciar: ${esc(e.message)}</div>`);
});
