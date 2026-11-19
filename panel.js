// Panel de control: los revisores de Marketing ven cómo va a quedar cada evento en Intranet y en Umbraco,
// lo corrigen o lo devuelven al REN, y con un OK lo mandan a la cola de alta.
import { SEDES, TIPOS, copyGeneral } from "./config.js";
import { store, modoPrueba } from "./store.js";
import {
  $, $$, esc, norm, sedeLabel, fechaLarga, HORAS, esRI, VAR_LABEL, toast, dialogo, tituloAuto, uadeMayus,
  corregirMayusculas, revisarOrtografia, chipEstado, simularIntranet, simularUmbraco, alertasEvento,
} from "./comun.js";

let CARRERAS = [];
let eventos = [];
let filtro = "revisar";
const ortografia = new Map(); // id del evento → { clave, errores: "pendiente" | null | [...] }

const tipoLabel = (c) => TIPOS.find((t) => t.code === c)?.label || c;
const renDe = (e) => (e.creado_email ? e.creado_email.split("@")[0] : modoPrueba ? "un REN (modo prueba)" : "—");
const fechaHora = (iso) => (iso ? new Date(iso).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "");
const porFecha = (a, b) => (a.fecha + a.hora_ini).localeCompare(b.fecha + b.hora_ini);
const bloqueado = (e) => alertasEvento(e).some((a) => a.nivel === "bloquea");
const buscar = (id) => eventos.find((x) => x.id === id);

const FILTROS = [
  { code: "revisar", label: "Para revisar", f: (e) => e.estado === "para_revisar" },
  { code: "devuelto", label: "Devueltos al REN", f: (e) => e.estado === "devuelto" },
  { code: "proceso", label: "Aprobados y en curso", f: (e) => ["aprobado", "en_intranet", "alta_manual"].includes(e.estado) },
  { code: "web", label: "Publicados", f: (e) => e.estado === "en_umbraco" },
  { code: "error", label: "Con error", f: (e) => e.estado.startsWith("error") },
  { code: "todos", label: "Todos", f: () => true },
];

/* ================= simulación ================= */
function simHTML(e) {
  const intra = simularIntranet(e);
  const um = simularUmbraco(e, CARRERAS);
  const fila = ([param, que, val]) => {
    const largo = param === "DescActiv" && String(val).length > 160;
    return `<dt>${esc(que)}<span class="param">${esc(param)}</span></dt>
      <dd>${largo ? `<details><summary>${esc(String(val).slice(0, 110))}… <span class="muted">(${val.length} caracteres, ver todo)</span></summary><div class="sim-largo">${esc(val)}</div></details>` : esc(val)}</dd>`;
  };
  const carreras = um.carreras.length
    ? um.carreras.map((c) => `<div>${c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.pagina)}</a>` : esc(c.pagina)} <span class="muted">· versión ${esc(c.version)}</span></div>`).join("")
    : '<span class="muted">Sin carrera: el evento queda solo en la agenda.</span>';
  return `<div class="sim-grid">
    <section class="sim"><h4>Cómo queda en Intranet</h4><dl class="kv">${intra.map(fila).join("")}</dl></section>
    <section class="sim"><h4>Cómo queda en la web (Umbraco)</h4><dl class="kv">
      <dt>Nombre del evento</dt><dd>${esc(um.nombre)}</dd>
      <dt>Carrera${um.carreras.length > 1 ? "s" : ""}</dt><dd>${carreras}</dd>
      <dt>Schools</dt><dd>${um.schools.length ? esc(um.schools.join(", ")) : '<span class="muted">—</span>'}</dd>
      <dt>Sites</dt><dd>${um.site ? esc(um.site) : `<span class="muted">Ninguna. ${esc(um.siteNota)}.</span>`}</dd>
      <dt>Switch de integración</dt><dd>${esc(um.switchTxt)}</dd>
      <dt>Copete y descripción</dt><dd class="muted">Los mismos de Intranet: llegan con la sincronización.</dd>
    </dl></section>
  </div>`;
}

/* ================= alertas ================= */
// Si es online, el copete es el link: no se le revisa la ortografía.
const camposOrt = (e) => ({ titulo: e.titulo || "", ...(e.sede === "O" ? {} : { copete: e.copete || "" }), descripcion: e.descripcion || "" });
const claveOrt = (e) => JSON.stringify(camposOrt(e));
const CAMPO = { titulo: "Título", copete: "Copete", descripcion: "Descripción" };

function alertasHTML(e) {
  const al = alertasEvento(e);
  const items = al.map((a) => `<li class="al-${a.nivel}">${a.nivel === "bloquea" ? "✕" : "!"} ${esc(a.txt)}
    ${a.fix === "mayusculas" ? '<button type="button" class="rev-opt" data-fix="mayusculas">Aplicar</button>' : ""}</li>`);
  const ort = ortografia.get(e.id);
  const vigente = ort && ort.clave === claveOrt(e);
  if (!vigente || ort.errores === "pendiente") items.push('<li class="al-info">Revisando ortografía…</li>');
  else if (ort.errores === null) items.push('<li class="al-aviso">! No se pudo revisar la ortografía: revisala a ojo.</li>');
  else ort.errores.forEach((x, i) => items.push(`<li class="al-aviso">! ${x.ortografia ? "Ortografía" : "Gramática"} · ${CAMPO[x.campo]}:
      <span class="al-texto">${x.recorteIni ? "…" : ""}${esc(x.antes)}<mark>${esc(x.error)}</mark>${esc(x.despues)}${x.recorteFin ? "…" : ""}</span>
      ${x.sugerencias.map((s) => `<button type="button" class="rev-opt" data-fix="ort" data-i="${i}" data-valor="${esc(s)}">${esc(s)}</button>`).join("")}</li>`));
  if (!items.length) items.push('<li class="al-ok">✓ Sin observaciones.</li>');
  return items.join("");
}

function pintarAlertas(e) {
  const ul = $(`.rev-ev[data-id="${e.id}"] [data-alertas]`);
  if (ul) ul.innerHTML = alertasHTML(e);
}

// LanguageTool acepta unas 20 consultas por minuto: se revisa de a un evento, con pausa.
let revisando = false;
async function revisarOrtografiaPendiente() {
  if (revisando) return;
  revisando = true;
  try {
    for (;;) {
      const e = eventos.find((x) => x.estado === "para_revisar" && ortografia.get(x.id)?.clave !== claveOrt(x));
      if (!e) break;
      const clave = claveOrt(e);
      ortografia.set(e.id, { clave, errores: "pendiente" });
      const errores = await revisarOrtografia(camposOrt(e), CARRERAS);
      ortografia.set(e.id, { clave, errores });
      pintarAlertas(e);
      await new Promise((r) => setTimeout(r, 3000));
    }
  } finally { revisando = false; }
}

/* ================= render ================= */
function tarjeta(e) {
  const bloquea = bloqueado(e);
  return `<article class="rev-ev ${bloquea ? "con-error" : ""}" data-id="${e.id}">
    <header class="rev-ev-head">
      <h3>${esc(e.titulo)}</h3>
      <div class="muted small">${esc(tipoLabel(e.tipo))} · ${esc(fechaLarga(e.fecha))} · ${e.hora_ini}–${e.hora_fin} · ${esc(sedeLabel(e.sede))}${e.id_actividad ? ` · ya está en Intranet (#${e.id_actividad}): se graban los cambios` : ""}</div>
    </header>
    ${e.revision_comentario ? `<div class="comentario-rev"><b>Se lo habían devuelto:</b> ${esc(e.revision_comentario)}</div>` : ""}
    <ul class="alertas" data-alertas>${alertasHTML(e)}</ul>
    ${simHTML(e)}
    <footer class="rev-ev-acc">
      <button type="button" class="ghost" data-acc="corregir">Corregir</button>
      <button type="button" class="ghost danger-txt" data-acc="devolver">Devolver al REN</button>
      <button type="button" class="primary" data-acc="aprobar" ${bloquea ? 'disabled title="Corregí lo marcado con ✕ antes de aprobar"' : ""}>Aprobar</button>
    </footer>
  </article>`;
}

function renderRevision(lista) {
  const grupos = new Map();
  for (const e of lista) {
    if (!grupos.has(e.tanda_id)) grupos.set(e.tanda_id, []);
    grupos.get(e.tanda_id).push(e);
  }
  const orden = [...grupos.values()].sort((a, b) => String(a[0].confirmado_at).localeCompare(String(b[0].confirmado_at)));
  $("#grupos").innerHTML = orden.map((g) => {
    const listos = g.filter((e) => !bloqueado(e)).length;
    const boton = g.length < 2 ? "" : `<button type="button" class="primary" data-acc="aprobar-tanda" ${listos ? "" : "disabled"}>
      ${listos === g.length ? `Aprobar los ${g.length}` : `Aprobar ${listos} de ${g.length} (sin errores)`}</button>`;
    return `<section class="card grupo" data-tanda="${esc(g[0].tanda_id)}">
      <div class="grupo-head">
        <div><h2>Tanda de ${esc(renDe(g[0]))}</h2>
          <span class="muted small">Enviada el ${esc(fechaHora(g[0].confirmado_at))} · ${g.length === 1 ? "1 evento" : `${g.length} eventos`}</span></div>
        ${boton}
      </div>
      ${g.map(tarjeta).join("")}
    </section>`;
  }).join("");
}

function renderTabla(lista) {
  if (!lista.length) { $("#grupos").innerHTML = ""; return; }
  $("#grupos").innerHTML = `<div class="card"><div class="tabla-wrap"><table class="tabla">
    <thead><tr><th>Evento</th><th>Fecha</th><th>Sede</th><th>Estado</th><th></th></tr></thead>
    <tbody>${lista.map((e) => `<tr data-id="${e.id}">
      <td><div>${esc(e.titulo)}</div>
        <div class="t-sub">cargó ${esc(renDe(e))}${e.revisado_por ? ` · revisó ${esc(String(e.revisado_por).split("@")[0])}` : ""}</div>
        ${e.estado === "devuelto" && e.revision_comentario ? `<div class="comentario-rev"><b>Comentario:</b> ${esc(e.revision_comentario)}</div>` : ""}
        ${e.error ? `<div class="t-sub" style="color:var(--err)">${esc(e.error)}</div>` : ""}</td>
      <td>${esc(fechaLarga(e.fecha))}<div class="t-sub">${e.hora_ini}–${e.hora_fin}</div></td>
      <td>${esc(sedeLabel(e.sede))}</td>
      <td>${chipEstado(e)}</td>
      <td><button type="button" class="link" data-acc="ver">Ver</button></td>
    </tr>`).join("")}</tbody></table></div></div>`;
}

function render() {
  $("#filtros").innerHTML = FILTROS.map((f) => {
    const n = eventos.filter(f.f).length;
    return `<button type="button" data-f="${f.code}" aria-pressed="${f.code === filtro}">${f.label} <span class="muted">${n}</span></button>`;
  }).join("");
  const lista = eventos.filter(FILTROS.find((f) => f.code === filtro).f).sort(porFecha);
  $("#panel-empty").hidden = lista.length > 0;
  $("#panel-empty-txt").textContent = filtro === "revisar"
    ? "No hay eventos para revisar. Cuando un REN envíe una tanda, aparece acá." : "No hay eventos en esta lista.";
  if (filtro === "revisar") renderRevision(lista); else renderTabla(lista);
  revisarOrtografiaPendiente();
}

async function cargar() {
  eventos = await store.listar();
  render();
}

/* ================= acciones ================= */
async function guardar(n, msg) {
  try {
    const x = await store.corregir(n);
    eventos = eventos.map((y) => (y.id === n.id ? { ...y, ...x } : y));
    render();
    if (msg) toast(msg);
  } catch (err) { toast("No se pudo guardar: " + err.message); await cargar(); }
}

async function aprobar(ids) {
  const evs = ids.map(buscar);
  const r = await dialogo({
    titulo: evs.length === 1 ? "¿Aprobar el evento?" : `¿Aprobar ${evs.length} eventos?`,
    html: `<p>Se ${evs.length === 1 ? "graba" : "graban"} en Intranet, se sincroniza Umbraco y se ${evs.length === 1 ? "le asigna" : "les asigna"} la carrera, sin otro OK.${modoPrueba ? " <b>(Modo prueba: no se envía nada.)</b>" : ""}</p>
      <ul>${evs.map((e) => `<li>${esc(e.titulo)}</li>`).join("")}</ul>`,
    botones: [{ label: "Volver" }, { label: "Aprobar", primary: true }],
  });
  if (r !== 1) return;
  try {
    const hechos = await store.aprobar(ids);
    toast(hechos.length === 1 ? "Aprobado: pasa a la cola de Intranet." : `${hechos.length} aprobados: pasan a la cola de Intranet.`);
    if (hechos.length < ids.length) toast("Algunos ya no estaban para revisar: se actualizó la lista.");
  } catch (err) { toast("No se pudo aprobar: " + err.message); }
  await cargar();
}

async function devolver(e) {
  const r = await dialogo({
    titulo: "Devolver al REN",
    html: `<p><b>${esc(e.titulo)}</b></p>
      <label>Qué tiene que corregir<textarea id="comentario-dev" rows="4" maxlength="500" placeholder="Ej.: la fecha no coincide con la del calendario de la facultad."></textarea></label>
      <p class="muted small">El REN ve este comentario en Mis eventos. Cuando lo corrige, vuelve a aparecer acá.</p>`,
    botones: [{ label: "Volver" }, { label: "Devolver", primary: true }],
  });
  if (r !== 1) return;
  const txt = $("#comentario-dev").value.trim();
  if (!txt) { toast("No se devolvió: escribí qué tiene que corregir."); return; }
  try {
    await store.devolver(e.id, txt);
    toast("Devuelto al REN.");
  } catch (err) { toast("No se pudo devolver: " + err.message); }
  await cargar();
}

/* ----- corregir en el panel ----- */
const nivelDe = (tipo) => (tipo === "ri_grado" || tipo === "ovo" ? "grado" : tipo === "ri_posgrado" ? "posgrado" : null);
const facCorta = (f) => String(f || "").replace(/^FACULTAD DE /, "Fac. de ").replace(/^ESCUELA DE /, "Esc. de ").toLowerCase()
  .replace(/(^|\s)(\p{L})/gu, (_, s, l) => s + l.toUpperCase()).replace(/\b(De|Del|Y|La|En)\b/g, (w) => w.toLowerCase());
const opcionCarrera = (c) => `${c.corto} · ${facCorta(c.facultad)}`;

function seleccion(cat, variante) {
  const v = cat.variantes[variante] ? variante : ["normal", "online", "costa"].find((x) => cat.variantes[x]);
  const nodo = cat.variantes[v];
  return { key: cat.key, corto: cat.corto, base: cat.base, facultad: cat.facultad, sector: cat.sector, nivel: cat.nivel,
    variante: v, variante_manual: true, nota: "", id: nodo.id, udi: nodo.udi, nombre: nodo.nombre };
}

function filaCarrera(cat, variante) {
  const vs = Object.keys(cat.variantes);
  return `<li data-key="${esc(cat.key)}"><span>${esc(cat.corto)}</span>
    <select aria-label="Versión de ${esc(cat.corto)}">${vs.map((v) => `<option value="${v}" ${v === variante ? "selected" : ""}>${VAR_LABEL[v] || v}</option>`).join("")}</select>
    <button type="button" class="link danger" data-quitar>Quitar</button></li>`;
}

async function corregir(e) {
  const nivel = nivelDe(e.tipo);
  const opciones = CARRERAS.filter((c) => !nivel || c.nivel === nivel);
  const horas = (sel) => HORAS.map((h) => `<option ${h === sel ? "selected" : ""}>${h}</option>`).join("");
  $("#dlg").classList.add("ancho");
  const promesa = dialogo({
    titulo: "Corregir el evento",
    html: `<div class="editor">
      <label>Título <input type="text" id="ed-titulo" maxlength="100" value="${esc(e.titulo)}"></label>
      <div class="row3">
        <label>Fecha<input type="date" id="ed-fecha" value="${esc(e.fecha)}"></label>
        <label>Inicio<select id="ed-ini">${horas(e.hora_ini)}</select></label>
        <label>Fin<select id="ed-fin">${horas(e.hora_fin)}</select></label>
      </div>
      <label>Modalidad y lugar de la reunión<select id="ed-sede">${SEDES.map((s) => `<option value="${s.code}" ${s.code === e.sede ? "selected" : ""}>${esc(s.label)}</option>`).join("")}</select></label>
      <div><span class="sublbl">Carrera y versión (página de la web)</span>
        <ul class="ed-carreras" id="ed-carreras">${e.carreras.map((c) => {
          const cat = CARRERAS.find((x) => x.key === c.key);
          return cat ? filaCarrera(cat, c.variante) : "";
        }).join("")}</ul>
        <div class="with-btn"><input type="text" id="ed-buscar" list="ed-lista" placeholder="Agregar otra carrera…"><button type="button" class="ghost" id="ed-agregar">Agregar</button></div>
        <datalist id="ed-lista">${opciones.map((c) => `<option value="${esc(opcionCarrera(c))}"></option>`).join("")}</datalist>
      </div>
      <label>${e.sede === "O" ? "Link de la reunión online (copete)" : "Copete"}<input type="text" id="ed-copete" maxlength="250" value="${esc(e.copete)}"></label>
      <label>Descripción<textarea id="ed-desc" rows="7" maxlength="3000">${esc(e.descripcion)}</textarea></label>
      <label>Cupo <span class="muted">(opcional)</span><input type="number" id="ed-cupo" min="1" step="1" value="${e.cupo || ""}"></label>
      <p class="muted small">Si cambiás la carrera, la sede o la fecha, el título automático y la descripción general se rearman solos, salvo que los hayas editado a mano.</p>
    </div>`,
    botones: [{ label: "Cancelar" }, { label: "Guardar", primary: true }],
  });

  const ul = $("#ed-carreras");
  ul.addEventListener("click", (ev) => { if (ev.target.closest("[data-quitar]")) ev.target.closest("li").remove(); });
  const agregar = () => {
    const inp = $("#ed-buscar");
    const cat = opciones.find((c) => opcionCarrera(c) === inp.value) || opciones.find((c) => norm(c.corto) === norm(inp.value));
    if (!cat) { toast("Elegí una carrera de la lista."); return; }
    if ($(`li[data-key="${cat.key}"]`, ul)) { toast("Esa carrera ya está."); return; }
    ul.insertAdjacentHTML("beforeend", filaCarrera(cat, cat.variantes.normal ? "normal" : Object.keys(cat.variantes)[0]));
    inp.value = "";
  };
  $("#ed-agregar").onclick = agregar;
  $("#ed-buscar").addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); agregar(); } });
  ["ed-titulo", "ed-copete", "ed-desc"].forEach((id) => $(`#${id}`).addEventListener("input", (ev) => {
    const el = ev.target, v = uadeMayus(el.value);
    if (v !== el.value) { const a = el.selectionStart; el.value = v; el.setSelectionRange(a, a); }
  }));

  const r = await promesa;
  $("#dlg").classList.remove("ancho");
  if (r !== 1) return;

  const n = structuredClone(e);
  n.fecha = $("#ed-fecha").value;
  n.hora_ini = $("#ed-ini").value;
  n.hora_fin = $("#ed-fin").value;
  n.sede = $("#ed-sede").value;
  n.copete = uadeMayus($("#ed-copete").value.trim());
  const cupo = parseInt($("#ed-cupo").value, 10); n.cupo = cupo > 0 ? cupo : null;
  n.carreras = $$("li[data-key]", ul).map((li) => seleccion(CARRERAS.find((c) => c.key === li.dataset.key), $("select", li).value));

  const firma = (cs) => cs.map((c) => c.key + ":" + c.variante).join("|");
  if (firma(n.carreras) !== firma(e.carreras) || n.sede !== e.sede) {
    const s = [...new Set(n.carreras.map((c) => c.sector).filter(Boolean))];
    if (!s.length) s.push(...e.sector.filter((x) => x !== 257));
    if (n.sede === "C" && !s.includes(257)) s.push(257);
    n.sector = s;
  }
  const titulo = uadeMayus($("#ed-titulo").value.trim());
  if (titulo !== e.titulo) { n.titulo = titulo; n.titulo_manual = esRI(n.tipo) ? titulo !== tituloAuto(n) : true; }
  else if (esRI(n.tipo) && !e.titulo_manual) n.titulo = tituloAuto(n);
  const desc = uadeMayus($("#ed-desc").value);
  if (desc !== e.descripcion) { n.descripcion = desc; n.desc_manual = true; }
  else if (!e.desc_manual && (n.sede !== e.sede || n.sector[0] !== e.sector[0])) n.descripcion = copyGeneral(n.tipo, n.sede, n.sector[0]);

  if (n.hora_ini >= n.hora_fin) toast("Ojo: la hora de fin quedó antes que la de inicio.");
  await guardar(n, "Cambios guardados. Sigue para revisar.");
}

function aplicarFix(e, btn) {
  const n = structuredClone(e);
  if (btn.dataset.fix === "mayusculas") {
    n.titulo = corregirMayusculas(e.titulo);
  } else {
    const x = ortografia.get(e.id)?.errores?.[Number(btn.dataset.i)];
    if (!x) return;
    const s = n[x.campo];
    n[x.campo] = s.slice(0, x.ini) + btn.dataset.valor + s.slice(x.ini + x.largo);
    if (x.campo === "descripcion") n.desc_manual = true;
  }
  if (esRI(n.tipo) && n.titulo !== tituloAuto(n)) n.titulo_manual = true;
  guardar(n, "Corrección aplicada.");
}

function verEvento(e) {
  $("#dlg").classList.add("ancho");
  dialogo({
    titulo: e.titulo,
    html: `<p>${chipEstado(e)} <span class="muted small">· cargó ${esc(renDe(e))}</span></p>
      ${e.revision_comentario ? `<div class="comentario-rev"><b>Comentario de la revisión:</b> ${esc(e.revision_comentario)}</div>` : ""}
      ${simHTML(e)}`,
    botones: [{ label: "Cerrar", primary: true }],
  }).then(() => $("#dlg").classList.remove("ancho"));
}

/* ================= navegación ================= */
function irA(vista) {
  $("#view-login").hidden = vista !== "login";
  $("#view-sin-permiso").hidden = vista !== "sin-permiso";
  $("#view-panel").hidden = vista !== "panel";
}

function conectar() {
  $("#filtros").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-f]"); if (b) { filtro = b.dataset.f; render(); }
  });
  $("#grupos").addEventListener("click", (ev) => {
    const fix = ev.target.closest("[data-fix]");
    const b = fix || ev.target.closest("[data-acc]");
    if (!b) return;
    if (b.dataset.acc === "aprobar-tanda") {
      const ids = $$(".rev-ev", b.closest(".grupo")).map((a) => a.dataset.id).filter((id) => !bloqueado(buscar(id)));
      aprobar(ids);
      return;
    }
    const e = buscar(b.closest("[data-id]")?.dataset.id);
    if (!e) return;
    if (fix) aplicarFix(e, fix);
    else if (b.dataset.acc === "aprobar") aprobar([e.id]);
    else if (b.dataset.acc === "devolver") devolver(e);
    else if (b.dataset.acc === "corregir") corregir(e);
    else if (b.dataset.acc === "ver") verEvento(e);
  });

  $("#form-login").addEventListener("submit", async (ev) => {
    ev.preventDefault();
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
    eventos = [];
    $("#who").textContent = ""; $("#btn-salir").hidden = true;
    irA("login");
  };
}

let dejarDeEscuchar = () => {};
async function entrar(u) {
  $("#who").textContent = u.email || "Modo prueba";
  $("#btn-salir").hidden = modoPrueba;
  if (!(await store.esRevisor())) { irA("sin-permiso"); return; }
  irA("panel");
  await cargar();
  let t;
  dejarDeEscuchar = store.escuchar(() => { clearTimeout(t); t = setTimeout(cargar, 400); });
}

async function init() {
  $("#banner-prueba").hidden = !modoPrueba;
  const r = await fetch("data/carreras.json");
  CARRERAS = (await r.json()).carreras;
  conectar();
  const u = await store.sesion();
  if (u) await entrar(u); else irA("login");
}

init().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML("afterbegin", `<div class="banner" style="background:var(--err-soft);color:var(--err)">No se pudo iniciar: ${esc(e.message)}</div>`);
});
