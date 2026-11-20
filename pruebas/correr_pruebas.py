"""Corre los casos de prueba del formulario y deja el Excel con los resultados.

Dos partes:
  * Modo prueba: sobre dist/Alta de eventos (prueba).html (lo que usan los testers).
  * Modo real: contra Supabase con la cuenta prueba.formulario@ (login, estados, permisos).
    Lo que crea en la base lo borra al final.

Uso:  py -X utf8 pruebas/correr_pruebas.py "<Excel de casos>"
Requiere el servidor local en http://localhost:8939 (launch.json "alta-eventos") para el modo real.
"""
import json
import re
import shutil
import sys
import time
import traceback
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import openpyxl
from openpyxl.styles import Alignment, Font, PatternFill
from playwright.sync_api import expect, sync_playwright

RAIZ = Path(__file__).resolve().parent.parent
HTML = (RAIZ / "dist" / "separados" / "Alta de eventos (prueba).html").as_uri()
PANEL = (RAIZ / "dist" / "separados" / "Panel de control (prueba).html").as_uri()
UNICO = (RAIZ / "dist" / "Alta de eventos y panel (prueba).html").as_uri()
REAL = "http://localhost:8939/"
CAPTURAS = RAIZ / "dist" / "capturas"
SB_URL = "https://kigfmductmgcccvcploe.supabase.co"
ANON = "sb_publishable_Q9VItQ8FcsbWwMrmd_u5Ug_XM3dvWIM"
MAIL_PRUEBA = "prueba.formulario@uade.edu.ar"
LT = "https://api.languagetool.org/**"

expect.set_options(timeout=6000)
AR = timezone(timedelta(hours=-3))
HOY = datetime.now(AR).date()
def dia(n): return (HOY + timedelta(days=n)).isoformat()
def ddmm(iso): return f"{iso[8:10]}/{iso[5:7]}"


# ---------------------------------------------------------------- registro de resultados
RES = {}          # id -> (estado, observación)
CASOS = []        # (id, función, modo)

class NoAplica(Exception): pass
class Bloqueado(Exception): pass

def caso(cid, modo="prueba"):
    def deco(fn):
        CASOS.append((cid, fn, modo)); return fn
    return deco


# ---------------------------------------------------------------- helpers del formulario
class F:
    def __init__(s, page): s.p = page
    def paso(s, n):
        if s.p.get_attribute(f"#pasos button[data-paso='{n}']", "aria-current") != "step":
            s.p.click(f"#pasos button[data-paso='{n}']")
    def paso_actual(s): return int(s.p.get_attribute("#pasos button[aria-current='step']", "data-paso"))
    def cuenta(s, k): s.p.select_option("#simular-cuenta", k)
    def tipo(s, code): s.paso(1); s.p.click(f"#seg-tipo button[data-v='{code}']")
    def tipos(s): return s.p.eval_on_selector_all("#seg-tipo button", "l => l.map(b => b.dataset.v)")
    def sede(s, code): s.paso(4); s.p.click(f"#seg-sede button[data-v='{code}']")
    def buscar(s, q): s.paso(2); s.p.fill("#buscar-carrera", q)
    def sug(s): return s.p.locator("#sugerencias li[data-i]")
    def sug_nombres(s): return s.p.eval_on_selector_all("#sugerencias li[data-i] > span:first-child", "els => els.map(e => e.firstChild.textContent.trim())")
    def carrera(s, q, nombre):
        s.buscar(q)
        s.p.locator("#sugerencias li[data-i]").filter(
            has=s.p.locator(f"xpath=./span[1][normalize-space(text())='{nombre}']")).first.click()
    def chips(s): return s.p.eval_on_selector_all("#chips .chip-name", "els => els.map(e => e.textContent)")
    def fecha(s, iso): s.paso(4); s.p.fill("#fecha", iso)
    def ini(s, h): s.paso(4); s.p.select_option("#hora-ini", h)
    def fin(s, h): s.paso(4); s.p.select_option("#hora-fin", h)
    def titulo(s): return s.p.input_value("#titulo")
    def escribir_titulo(s, t): s.paso(5); s.p.fill("#titulo", t)
    def copete(s, t): s.paso(5); s.p.fill("#copete", t)
    def descripcion(s, t): s.paso(5); s.p.fill("#descripcion", t)
    def agregar(s):
        if s.p.is_hidden("#btn-agregar"): s.paso(5)
        s.p.click("#btn-agregar")
    def err(s, k): return (s.p.locator(f"[data-err='{k}']").text_content() or "").strip()
    def toast(s): return s.p.locator("#toast")
    def tanda_n(s): return int(s.p.inner_text("#tanda-count"))
    def tanda(s): return s.p.evaluate("JSON.parse(localStorage.getItem('uade_alta_tanda') || '[]')")
    def eventos(s): return s.p.evaluate("JSON.parse(localStorage.getItem('uade_alta_eventos') || '[]')")
    def dlg(s): return s.p.locator("#dlg[open]")
    def dlg_boton(s, label):
        s.p.evaluate("document.querySelector('#toast').textContent = ''")  # que no quede el aviso del paso anterior
        s.p.locator("#dlg-actions button", has_text=label).click()
    def abrir_mas(s): s.paso(3)
    def destildar(s, sel):
        # cada clic vuelve a dibujar las casillas: se hace un clic por vez y se vuelve a buscar
        while s.p.locator(f"{sel} input:checked").count(): s.p.locator(f"{sel} input:checked").first.click()
    def sector(s, code):
        s.abrir_mas()
        if not s.p.is_checked(f"#ck-sector input[value='{code}']"): s.p.click(f"#ck-sector input[value='{code}']")
    def otro(s, fecha=None, hora="18:00", sector=159):
        """'Otro evento' sin carrera: hay que elegir el sector a mano (no hay carrera de donde sacarlo)."""
        s.tipo("otro"); s.sede("M"); s.fecha(fecha or dia(8)); s.ini(hora); s.sector(sector)
    def valido(s, q="abogacia", nombre="Abogacía", sede="M", fecha=None, hora="10:00", tipo=None):
        if tipo: s.tipo(tipo)
        if q: s.carrera(q, nombre)
        if sede: s.sede(sede)
        s.fecha(fecha or dia(7))
        if hora: s.ini(hora)
        if sede == "O": s.copete("https://zoom.us/j/1234567890")
    def agregar_ok(s, n_antes=None):
        n = s.tanda_n() if n_antes is None else n_antes
        s.agregar()
        expect(s.p.locator("#tanda-count")).to_have_text(str(n + 1))
    def confirmar(s):
        s.p.click("#btn-confirmar"); s.dlg_boton("Enviar a revisión")
        expect(s.p.locator("#view-mis")).to_be_visible()


def lt_vacio(route):
    route.fulfill(status=200, content_type="application/json", body=json.dumps({"matches": []}))


# ---------------------------------------------------------------- Supabase (REST)
def leer_env():
    env = {}
    for l in (RAIZ / "privado" / ".env").read_text(encoding="utf-8").splitlines():
        if "=" in l and not l.strip().startswith("#"):
            k, v = l.split("=", 1); env[k.strip()] = v.strip()
    return env

SECRETA = leer_env().get("SUPABASE_SECRET_KEY", "")

def sb(metodo, ruta, cuerpo=None, token=None, key=ANON, prefer="return=representation"):
    h = {"apikey": key, "Content-Type": "application/json", "Prefer": prefer}
    if token: h["Authorization"] = f"Bearer {token}"
    elif key == SECRETA: h["Authorization"] = f"Bearer {key}"
    req = urllib.request.Request(SB_URL + ruta, method=metodo, headers=h,
                                 data=json.dumps(cuerpo).encode() if cuerpo is not None else None)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            txt = r.read().decode(); return r.status, (json.loads(txt) if txt else None)
    except urllib.error.HTTPError as e:
        txt = e.read().decode()
        try: return e.code, json.loads(txt)
        except Exception: return e.code, txt

def svc(metodo, ruta, cuerpo=None): return sb(metodo, ruta, cuerpo, key=SECRETA)

def clave_prueba():
    for archivo in sorted((RAIZ / "privado").glob("cuentas_*.xlsx"), reverse=True):
        for r in openpyxl.load_workbook(archivo).active.iter_rows(min_row=2, values_only=True):
            if r[0] == MAIL_PRUEBA: return r[2]
    raise Bloqueado("No encontré la clave de la cuenta de prueba en privado/")

ABOGACIA = {"key": "c1", "corto": "Abogacía", "base": "ABOGACÍA", "facultad": "", "sector": 182, "nivel": "grado",
            "variante": "normal", "variante_manual": False, "nota": "", "id": 0, "udi": "", "nombre": "ABOGACÍA"}

def fila_evento(**k):
    base = dict(tipo="ri_grado", carreras=[ABOGACIA], sede="M", fecha=dia(20), hora_ini="10:00", hora_fin="11:00",
                categ=[12], perfil=[3, 100], sector=[182], origen_crm="R", categ_crm=12, requiere_inscripcion=False,
                titulo="PRUEBA AUTO", titulo_manual=True, copete="", descripcion="", desc_manual=False, cupo=None,
                tanda_id=str(uuid.uuid4()))
    base.update(k); return base

# =====================================================================================
#                                   CASOS · MODO PRUEBA
# =====================================================================================

@caso("CAR-01")
def _(f):
    expect(f.p.locator("#seg-tipo button[data-v='ri_grado']")).to_have_attribute("aria-pressed", "true")

@caso("CAR-02")
def _(f):
    f.paso(2); f.p.click("#buscar-carrera")
    expect(f.p.locator("#sugerencias")).to_be_hidden()
    f.buscar("ing ind")
    expect(f.p.locator("#sugerencias")).to_be_visible()
    a = f.sug_nombres(); assert "Ing. Industrial" in a, a
    f.buscar("ÍNG IND"); assert f.sug_nombres() == a, "con tildes/mayúsculas da otro resultado"

@caso("CAR-03")
def _(f):
    f.buscar("ind ing"); assert "Ing. Industrial" in f.sug_nombres()
    f.buscar("empresas administracion lic"); assert "Lic. en Administración de Empresas" in f.sug_nombres()
    f.buscar("marketing psico")
    vacio = f.p.locator("#sugerencias li.vacio").count() == 1
    return ("Palabras en cualquier orden: OK. Nota: 'marketing psico' no trae nada porque busca carreras que tengan "
            "TODAS las palabras (es lo esperado; el dato del caso mezclaba dos búsquedas)." if vacio else "")

@caso("CAR-04")
def _(f):
    f.buscar("a")
    assert f.sug().count() == 40, f.sug().count()
    assert f.p.locator("#sugerencias li[data-i] .fac").count() == 40
    assert f.p.locator("#sugerencias li[data-i] .tags .tag").count() >= 40

@caso("CAR-05")
def _(f):
    f.buscar("carrerainexistente123")
    expect(f.p.locator("#sugerencias li.vacio")).to_have_text('No hay carreras con "carrerainexistente123"')

@caso("CAR-06")
def _(f):
    f.buscar("lic")
    sel = lambda: f.p.eval_on_selector_all("#sugerencias li[data-i]", "l => l.findIndex(x => x.getAttribute('aria-selected') === 'true')")
    assert sel() == 0
    f.p.press("#buscar-carrera", "ArrowDown"); assert sel() == 1, sel()
    f.p.press("#buscar-carrera", "ArrowDown"); f.p.press("#buscar-carrera", "ArrowUp"); assert sel() == 1, sel()
    esperado = f.sug_nombres()[1]
    f.p.press("#buscar-carrera", "Enter"); assert f.chips() == [esperado], f.chips()
    f.buscar("abo"); f.p.press("#buscar-carrera", "Escape")
    expect(f.p.locator("#sugerencias")).to_be_hidden()

@caso("CAR-07")
def _(f):
    f.carrera("abogacia", "Abogacía"); f.carrera("contador", "Contador Público")
    assert f.chips() == ["Abogacía", "Contador Público"], f.chips()
    assert f.p.locator("#chips .chip-x").count() == 2
    f.buscar("abogacia"); assert "Abogacía" not in f.sug_nombres()

@caso("CAR-08")
def _(f):
    f.carrera("abogacia", "Abogacía"); f.carrera("contador", "Contador Público"); f.carrera("marketing", "Lic. en Marketing")
    f.p.fill("#buscar-carrera", ""); f.p.press("#buscar-carrera", "Backspace")
    assert f.chips() == ["Abogacía", "Contador Público"], f.chips()
    f.p.locator("#chips .chip-x").first.click()
    assert f.chips() == ["Contador Público"], f.chips()

@caso("CAR-09")
def _(f):
    f.tipo("otro"); f.paso(2)
    expect(f.p.locator("#carrera-opcional")).to_be_visible()
    f.sede("M"); f.fecha(dia(8)); f.ini("18:00"); f.escribir_titulo("Fashion Watch + Talk")
    f.agregar()
    assert f.err("sector") == "Elegí el sector organizador.", f.err("sector")
    assert f.paso_actual() == 3
    f.sector(159); f.agregar_ok()
    return ("Deja avanzar sin carrera, pero en 'Evento' pide elegir el sector organizador (sin carrera no hay de dónde "
            "sacarlo): vuelve solo al paso 3 con el aviso 'Elegí el sector organizador.'")

@caso("SED-01")
def _(f):
    assert f.p.locator("#seg-sede button[aria-pressed='true']").count() == 0

def variante(f): return f.p.locator("#chips select").input_value() if f.p.locator("#chips select").count() else f.p.inner_text("#chips .tag")

CAMBIO_SEDE = ("Regla nueva (pedido del equipo, punto 3): la versión de la carrera ya NO cambia con la modalidad de la "
               "reunión; se propone según la cuenta y el REN la cambia en el chip.")

@caso("SED-02")
def _(f):
    f.cuenta("online"); f.carrera("abogacia", "Abogacía")
    assert variante(f) == "online"; expect(f.p.locator("#chips .chip-node")).to_contain_text("ABOGACÍA (ONLINE)")
    return "Cuenta Online → versión Online. " + CAMBIO_SEDE

@caso("SED-03")
def _(f):
    f.cuenta("costa"); f.carrera("abogacia", "Abogacía")
    assert variante(f) == "costa"; expect(f.p.locator("#chips .chip-node")).to_contain_text("ABOGACÍA (COSTA ARGENTINA)")
    return "Cuenta Costa → versión Costa. " + CAMBIO_SEDE

@caso("SED-04")
def _(f):
    f.carrera("abogacia", "Abogacía"); assert variante(f) == "normal"
    for s_ in "OCM":
        f.sede(s_); assert variante(f) == "normal", (s_, variante(f))
    return "Cuenta de facultad → presencial, y sigue presencial aunque la reunión sea Online o en Costa. " + CAMBIO_SEDE

@caso("SED-05")
def _(f):
    f.cuenta("online"); f.carrera("contador", "Contador Público")
    assert variante(f) == "normal"
    expect(f.p.locator("#chips .note")).to_have_text("· No tiene versión Online: se usa la presencial")
    return "Cuenta Online + Contador Público (no tiene versión Online). Lic. en Psicología sí tiene Online."

@caso("SED-06")
def _(f):
    f.carrera("gastronomicos", "Diplomatura de Administración de Negocios Gastronómicos")
    expect(f.p.locator("#chips .note")).to_have_text("· Solo existe la versión Costa")
    return "'Solo existe la versión X' sale cuando la carrera no tiene versión presencial (ej. Diplomatura de Negocios Gastronómicos)."

@caso("SED-07")
def _(f):
    f.carrera("abogacia", "Abogacía")
    f.p.select_option("#chips select", "online")
    f.sede("C"); f.sede("M"); assert variante(f) == "online", variante(f)
    expect(f.p.locator("#chips .chip-node")).to_contain_text("ABOGACÍA (ONLINE)")

@caso("FCH-01")
def _(f):
    assert f.p.get_attribute("#fecha", "min") == HOY.isoformat()
    f.valido(fecha=dia(-1)); f.agregar()
    assert f.err("fecha") == "La fecha ya pasó.", f.err("fecha")
    assert f.tanda_n() == 0
    return "El calendario no deja elegir días anteriores; si se escribe a mano, sale 'La fecha ya pasó.'"

@caso("FCH-02")
def _(f):
    f.valido(fecha=HOY.isoformat()); f.agregar_ok()

@caso("FCH-03")
def _(f):
    f.ini("10:00"); assert f.p.input_value("#hora-fin") == "11:00"

@caso("FCH-04")
def _(f):
    assert f.p.locator("#quick-dur").count() == 0
    raise NoAplica("Se quitaron los botones de duración (pedido del equipo, punto 4): el fin se elige en la lista. "
                   "Sigue proponiendo 1 h al elegir el inicio.")

@caso("FCH-05")
def _(f):
    f.ini("23:00")
    assert f.p.input_value("#hora-fin") == "23:45", f.p.input_value("#hora-fin")
    opciones = f.p.eval_on_selector_all("#hora-fin option", "o => o.map(x => x.value)")
    assert opciones[-1] == "23:45"
    f.ini("23:45"); assert f.p.input_value("#hora-fin") == "23:45"
    f.carrera("abogacia", "Abogacía"); f.sede("M"); f.fecha(dia(9)); f.agregar()
    assert f.err("fecha") == "La hora de fin tiene que ser posterior a la de inicio."
    return "Con inicio 23:45 el fin queda igual (23:45) y no deja agregar: es el límite de la lista de horarios."

@caso("FCH-06")
def _(f):
    assert f.p.locator("#quick-dur").count() == 0
    raise NoAplica("Se quitaron los botones de duración (pedido del equipo, punto 4).")

@caso("FCH-07")
def _(f):
    f.valido(hora="14:00"); f.fin("16:30")
    assert f.p.input_value("#hora-fin") == "16:30"
    f.agregar_ok(); t = f.tanda()[0]; assert (t["hora_ini"], t["hora_fin"]) == ("14:00", "16:30"), t
    f.ini("14:00"); f.fin("16:30"); f.ini("15:00")
    return f"Además: si después se cambia el inicio, se mantiene la duración (15:00 → {f.p.input_value('#hora-fin')})."

@caso("TIT-01")
def _(f):
    d = dia(9); f.valido(fecha=d)
    assert f.titulo() == f"Reunión Informativa: Abogacía ({ddmm(d)})", f.titulo()

@caso("TIT-02")
def _(f):
    d = dia(9); f.valido(sede="O", fecha=d); f.paso(2)
    t = f.titulo(); assert t == f"Reunión Informativa Online: Abogacía ({ddmm(d)})", t
    f.p.select_option("#chips select", "online")
    t2 = f.titulo(); assert t2 == f"Reunión Informativa Online: Abogacía ({ddmm(d)})", t2
    f.sede("M"); t3 = f.titulo(); assert t3 == f"Reunión Informativa: Abogacía Online ({ddmm(d)})", t3
    return f"«{t}». Ya no repite 'Online' si la carrera también es la online; si la reunión es presencial y la carrera online: «{t3}»."

@caso("TIT-03")
def _(f):
    d = dia(9); f.carrera("administracion empresas lic", "Lic. en Administración de Empresas")
    f.carrera("ing ind", "Ing. Industrial"); f.sede("M"); f.fecha(d)
    assert f.titulo() == f"Reunión Informativa: Lic. en Administración de Empresas + Ing. Industrial ({ddmm(d)})", f.titulo()

@caso("TIT-04")
def _(f):
    assert f.titulo() == "Reunión Informativa: [carrera] (dd/mm)", f.titulo()

@caso("TIT-05")
def _(f):
    f.valido()
    expect(f.p.locator("#titulo-auto")).to_have_text("· automático")
    auto = f.titulo()
    f.escribir_titulo("Reunión Informativa Especial de Abogacía")
    expect(f.p.locator("#titulo-auto")).to_have_text("· editado a mano")
    expect(f.p.locator("#btn-titulo-auto")).to_be_visible()
    f.p.click("#btn-titulo-auto")
    assert f.titulo() == auto; expect(f.p.locator("#titulo-auto")).to_have_text("· automático")

@caso("TIT-06")
def _(f):
    f.tipo("otro")
    assert f.titulo() == ""; assert f.p.get_attribute("#titulo", "placeholder") == "Ej. Fashion Watch + Talk (27/11)"
    f.otro(); f.agregar()
    assert f.err("titulo") == "El título es muy corto."
    f.escribir_titulo("Fashion Watch + Talk (27/11)"); f.agregar_ok()
    assert f.tanda()[0]["titulo"] == "Fashion Watch + Talk (27/11)"

@caso("TIT-07")
def _(f):
    f.otro()
    f.escribir_titulo("Abc"); expect(f.p.locator("#titulo-count")).to_have_text("3/100"); f.agregar_ok()
    f.otro(hora="19:00")
    cien = ("Charla Abierta " * 10)[:99] + "X"; assert len(cien) == 100
    f.escribir_titulo(cien); expect(f.p.locator("#titulo-count")).to_have_text("100/100"); f.agregar_ok()
    f.escribir_titulo(""); f.p.type("#titulo", cien + "Z")
    assert len(f.titulo()) == 100, "deja escribir más de 100"
    return "Aceptó 3 y 100 caracteres; un carácter más no se puede escribir."

@caso("TIT-08")
def _(f):
    f.valido(); txt = "Conocé la carrera. " * 14
    f.copete(""); f.p.type("#copete", txt[:255])
    assert len(f.p.input_value("#copete")) == 250
    f.agregar_ok(); assert len(f.tanda()[0]["copete"]) == 250

@caso("TIT-09")
def _(f):
    f.valido(q="contador", nombre="Contador Público")
    d = f.p.input_value("#descripcion")
    for parte in ["Te invitamos a participar de una Reunión Informativa presencial",
                  "Campus Buenos Aires (Lima 757, CABA)", "Actividad libre y gratuita con inscripción previa.",
                  "Más información en face@uade.edu.ar"]:
        assert parte in d, f"falta «{parte}»"

@caso("TIT-10")
def _(f):
    f.carrera("abogacia", "Abogacía")
    for s in "RBC":
        f.sede(s); assert "[[dirección]]" in f.p.input_value("#descripcion"), s
    return "Recoleta, Belgrano y Costa traen [[dirección]] (falta que Marketing pase las direcciones)."

@caso("TIT-11")
def _(f):
    f.valido()
    f.descripcion("Texto de prueba"); expect(f.p.locator("#desc-count")).to_have_text("15/3000")
    f.p.fill("#descripcion", "x" * 2995); f.p.press("#descripcion", "End"); f.p.type("#descripcion", "y" * 10)
    assert len(f.p.input_value("#descripcion")) == 3000
    assert f.p.get_attribute("#descripcion", "spellcheck") == "true" and f.p.get_attribute("#descripcion", "lang") == "es-AR"
    return "Límite y contador OK. El subrayado rojo lo dibuja el navegador (spellcheck activado en español); no se puede verificar automáticamente."

@caso("OPT-01")
def _(f):
    expect(f.p.locator("#pasos button[data-paso='3']")).to_contain_text("Datos para Intranet")
    f.carrera("abogacia", "Abogacía"); f.paso(3)
    expect(f.p.locator("#categ-fija")).to_have_text("Charlas")
    raise NoAplica("Ya no hay sección plegada: 'Más opciones' pasó a ser el paso 3 'Datos para Intranet' (pedido del equipo, punto 5).")

@caso("OPT-02")
def _(f):
    f.valido(); f.abrir_mas(); f.destildar("#ck-perfil")
    f.agregar()
    assert f.paso_actual() == 3, f.paso_actual()
    expect(f.p.locator("#pasos button[data-paso='3']")).to_have_class(re.compile("con-error"))
    assert f.err("perfil") == "Elegí al menos una audiencia."
    return "Al agregar vuelve solo al paso 3, que queda marcado en rojo con el aviso."

def marcados(f, sel): return f.p.eval_on_selector_all(f"{sel} input:checked", "l => l.map(x => Number(x.value))")

@caso("OPT-03")
def _(f):
    f.carrera("abogacia", "Abogacía"); f.carrera("contador", "Contador Público"); f.sede("M"); f.abrir_mas()
    expect(f.p.locator("#categ-fija")).to_have_text("Charlas"); assert marcados(f, "#ck-perfil") == [3, 100]
    assert sorted(marcados(f, "#ck-sector")) == [176, 182], marcados(f, "#ck-sector")
    f.sede("O"); f.abrir_mas(); expect(f.p.locator("#categ-fija")).to_have_text("Charlas")
    f.sede("C"); f.abrir_mas(); assert 257 in marcados(f, "#ck-sector")
    return "Categoría fija 'Charlas' (pedido del equipo, punto 9). Costa suma el sector UADE Costa Argentina."

@caso("OPT-04")
def _(f):
    assert f.p.input_value("#origen-crm") == "R" and f.p.input_value("#categ-crm") == "12"
    f.tipo("otro")
    assert f.p.input_value("#origen-crm") == "A" and f.p.input_value("#categ-crm") == "8"
    f.tipo("ovo")
    assert f.p.input_value("#origen-crm") == "O" and f.p.input_value("#categ-crm") == "38"
    opciones = f.p.eval_on_selector_all("#categ-crm option", "l => l.map(o => o.text)")
    assert opciones == ["Charlas", "Reuni. Infor.", "Taller Orientación Vocacional"], opciones
    return "RI → RI / Reuni. Infor.; Evento → Actividades Agenda / Charlas; Taller OVO → OVO / Taller Orientación Vocacional. Categoría CRM solo con las 3 opciones pedidas."

@caso("NUE-13")
def _(f):
    f.paso(3)
    for origen, categ in (("A", "8"), ("O", "38"), ("R", "12")):
        f.p.select_option("#origen-crm", origen)
        assert f.p.input_value("#categ-crm") == categ, (origen, f.p.input_value("#categ-crm"))
    f.p.select_option("#categ-crm", "8")
    assert f.p.input_value("#origen-crm") == "R" and f.p.input_value("#categ-crm") == "8"
    return "Origen RI → Reuni. Infor.; Actividades Agenda → Charlas; OVO → Taller Orientación Vocacional. La categoría se puede cambiar a mano después."

@caso("OPT-05")
def _(f):
    f.valido(); f.abrir_mas(); f.p.fill("#cupo", "50"); f.agregar_ok()
    assert f.tanda()[0]["cupo"] == 50
    f.valido(fecha=dia(11)); f.abrir_mas(); f.p.fill("#cupo", "0"); f.agregar_ok()
    assert f.tanda()[1]["cupo"] is None
    return "Cupo 0 o vacío se guarda como 'sin cupo'."

@caso("OPT-06")
def _(f):
    f.valido(); f.abrir_mas()
    expect(f.p.locator("#insc-fija")).to_have_text("Sí (siempre, salvo en Talleres OVO)")
    f.agregar_ok(); assert f.tanda()[0]["requiere_inscripcion"] is True
    f.tipo("ovo"); f.abrir_mas()
    expect(f.p.locator("#insc-fija")).to_have_text("No (los Talleres OVO no llevan inscripción)")
    f.sede("M"); f.fecha(dia(9)); f.ini("10:00"); f.escribir_titulo("Taller de Orientación Vocacional"); f.agregar_ok()
    assert f.tanda()[1]["requiere_inscripcion"] is False and f.tanda()[1]["tipo"] == "ovo"
    return "Ya no es un interruptor: Sí siempre, No en Talleres OVO (pedido del equipo, punto 11)."

@caso("VAL-01")
def _(f):
    f.sede("M"); f.fecha(dia(7)); f.ini("10:00")
    f.agregar()
    assert f.err("carreras") == "Elegí al menos una carrera."
    assert f.paso_actual() == 2
    expect(f.p.locator("#combo")).to_be_visible()
    return "Vuelve solo al paso 2 (Carrera), marcado en rojo."

@caso("VAL-02")
def _(f):
    f.carrera("abogacia", "Abogacía"); f.fecha(dia(7)); f.ini("10:00"); f.agregar()
    assert f.err("sede") == "Elegí la sede o modalidad."

@caso("VAL-03")
def _(f):
    f.carrera("abogacia", "Abogacía"); f.sede("M"); f.agregar()
    assert f.err("fecha") == "Poné la fecha."

@caso("VAL-04")
def _(f):
    f.valido(fecha=dia(-3)); f.agregar(); assert f.err("fecha") == "La fecha ya pasó."

@caso("VAL-05")
def _(f):
    f.valido(hora=None); f.agregar(); assert f.err("fecha") == "Elegí hora de inicio y de fin."

@caso("VAL-06")
def _(f):
    f.valido(hora="11:00"); f.fin("10:00"); f.agregar()
    assert f.err("fecha") == "La hora de fin tiene que ser posterior a la de inicio."

@caso("VAL-07")
def _(f):
    f.valido(); f.escribir_titulo("Ab"); f.agregar(); assert f.err("titulo") == "El título es muy corto."

@caso("VAL-08")
def _(f):
    f.valido()
    f.p.evaluate("t => { const i = document.querySelector('#titulo'); i.removeAttribute('maxlength'); i.value = t; i.dispatchEvent(new Event('input')); }", "A" * 101)
    f.agregar(); assert f.err("titulo") == "El título no puede pasar los 100 caracteres."
    return "El campo no deja escribir más de 100; el mensaje se probó forzando el valor."

@caso("VAL-09")
def _(f):
    f.carrera("abogacia", "Abogacía"); f.sede("M"); f.ini("10:00")
    f.agregar()
    assert f.err("fecha") == "Poné la fecha." and f.err("titulo") == "Al título le falta la carrera o la fecha.", f.err("titulo")
    f.paso(2); f.p.locator("#chips .chip-x").click(); f.fecha(dia(7)); f.agregar()
    assert f.err("titulo") == "Al título le falta la carrera o la fecha."

@caso("VAL-10")
def _(f):
    f.valido()
    f.p.evaluate("t => { const i = document.querySelector('#descripcion'); i.removeAttribute('maxlength'); i.value = t; i.dispatchEvent(new Event('input')); }", "x" * 3001)
    f.agregar(); assert f.err("descripcion") == "La descripción no puede pasar los 3000 caracteres."
    return "El campo no deja escribir más de 3000; el mensaje se probó forzando el valor."

@caso("VAL-11")
def _(f):
    f.valido(sede="R"); f.agregar()
    assert f.err("descripcion") == 'Completá "dirección" en la descripción (está entre [[ ]]).', f.err("descripcion")

@caso("VAL-12")
def _(f):
    f.valido(); f.abrir_mas(); f.destildar("#ck-perfil"); f.destildar("#ck-sector")
    f.agregar()
    assert f.err("perfil") == "Elegí al menos una audiencia." and f.err("sector") == "Elegí el sector organizador."

@caso("VAL-13")
def _(f):
    d = dia(7); f.valido(fecha=d); f.agregar_ok()
    f.carrera("abogacia", "Abogacía"); f.fecha(d); f.ini("10:00"); f.agregar()
    assert f.err("fecha") == f'Ya existe "Reunión Informativa: Abogacía ({ddmm(d)})" con la misma carrera, fecha y hora.', f.err("fecha")
    assert f.tanda_n() == 1

@caso("VAL-14")
def _(f):
    d = dia(7); f.valido(fecha=d); f.agregar_ok(); f.confirmar()
    f.p.click(".tab[data-view='nuevo']")
    f.carrera("abogacia", "Abogacía"); f.fecha(d); f.ini("10:00"); f.agregar()
    assert f.err("fecha").startswith('Ya existe "Reunión Informativa: Abogacía'), f.err("fecha")

# ---------- revisión de mayúsculas y ortografía (LanguageTool real salvo donde se indica)
def titulo_mal(f, t="charla de marketing digital con egresados", fecha=None):
    f.otro(fecha=fecha); f.escribir_titulo(t)

@caso("REV-01", modo="lt")
def _(f):
    titulo_mal(f); f.agregar(); expect(f.dlg()).to_be_visible(timeout=12000)
    expect(f.p.locator("#dlg .rev-nota")).to_have_text("Lo que cargás se publica tal cual en la web: prestá atención a la ortografía.")

@caso("REV-02", modo="lt")
def _(f):
    titulo_mal(f); f.agregar(); expect(f.dlg()).to_be_visible(timeout=12000); f.dlg_boton("Aplicar y agregar")
    titulo_mal(f, fecha=dia(9)); f.agregar(); expect(f.dlg()).to_be_visible(timeout=12000)
    expect(f.p.locator("#dlg .rev-nota")).to_contain_text("Ya te marcamos errores una vez.")
    f.dlg_boton("Aplicar y agregar")
    titulo_mal(f, fecha=dia(10)); f.agregar(); expect(f.dlg()).to_be_visible(timeout=12000)
    expect(f.p.locator("#dlg .rev-nota")).to_contain_text("Ya te marcamos errores 2 veces.")

@caso("REV-03", modo="lt")
def _(f):
    titulo_mal(f); f.agregar(); expect(f.dlg()).to_be_visible(timeout=12000)
    item = f.p.locator("#dlg [data-rev='may']")
    expect(item.locator(".rev-mal")).to_contain_text("Lo escribiste así:")
    assert item.locator(".rev-mal mark").count() >= 3
    expect(item.locator(".rev-bien")).to_have_text("Así queda: Charla de Marketing Digital con Egresados")
    color = f.p.eval_on_selector("#dlg .rev-mal", "e => getComputedStyle(e).color")
    f.dlg_boton("Aplicar y agregar")
    expect(f.p.locator("#tanda-count")).to_have_text("1")
    assert f.tanda()[0]["titulo"] == "Charla de Marketing Digital con Egresados"
    return f"Bloque rojo (color {color}) y verde OK; se guardó el título corregido."

@caso("REV-04", modo="lt")
def _(f):
    titulo_mal(f, "¿cómo estudiar administración en uade?"); f.agregar()
    f.p.wait_for_timeout(2500)
    hay_may = f.p.locator("#dlg[open] [data-rev='may']").count()
    assert hay_may == 0, "corrigió mayúsculas en una pregunta sin separador"
    if f.dlg().count(): f.dlg_boton("Volver a editar")
    titulo_mal(f, "charla abierta: ¿cómo estudiar en uade?", fecha=dia(9)); f.agregar()
    expect(f.dlg()).to_be_visible(timeout=12000)
    expect(f.p.locator("#dlg [data-rev='may'] .rev-bien")).to_have_text("Así queda: Charla Abierta: ¿cómo estudiar en UADE?")
    return "Sin ':' o ' - ' no toca la pregunta; con ':' corrige solo lo de antes ('Charla Abierta: ¿cómo estudiar en UADE?'; 'uade' ya se pasa a mayúsculas al escribir)."

@caso("REV-05", modo="lt")
def _(f):
    titulo_mal(f); f.agregar(); expect(f.dlg()).to_be_visible(timeout=12000)
    f.p.locator("#dlg [data-rev='may'] .rev-opt", has_text="Dejar así").click()
    f.dlg_boton("Aplicar y agregar"); expect(f.p.locator("#tanda-count")).to_have_text("1")
    assert f.tanda()[0]["titulo"] == "charla de marketing digital con egresados"

@caso("REV-06", modo="lt")
def _(f):
    f.valido(); f.copete("Escribinos a UADE para consultar por la carrera"); f.agregar()
    expect(f.p.locator("#tanda-count")).to_have_text("1", timeout=12000)
    assert f.dlg().count() == 0

@caso("REV-07", modo="lt")
def _(f):
    f.valido(); f.copete("Vení a conoser la facultad"); f.agregar()
    expect(f.dlg()).to_be_visible(timeout=12000)
    item = f.p.locator("#dlg .rev-item[data-rev='0']")
    expect(item.locator(".rev-head")).to_contain_text("Ortografía · Copete")
    expect(item.locator(".rev-mal mark")).to_have_text("conoser")
    opts = item.locator(".rev-opt")
    n = opts.count(); assert 2 <= n <= 4, n
    assert opts.first.get_attribute("aria-pressed") == "true" and opts.first.inner_text() == "conocer"
    assert opts.last.inner_text() == "Dejar así"
    return f"{n - 1} sugerencias + 'Dejar así'; la primera ('conocer') viene elegida."

@caso("REV-08", modo="lt")
def _(f):
    # LanguageTool casi no marca gramática en frases cortas: se simula una respuesta de gramática
    def gram(route):
        route.fulfill(status=200, content_type="application/json", body=json.dumps({"matches": [{
            "offset": 0, "length": 3, "replacements": [{"value": "Los"}],
            "rule": {"issueType": "grammar", "category": {"id": "GRAMMAR"}}}]}))
    f.p.route(LT, gram)
    f.valido(); f.copete("Las alumnos vienen"); f.agregar()
    expect(f.dlg()).to_be_visible()
    item = f.p.locator("#dlg .rev-item[data-rev='0']")
    expect(item.locator(".rev-head")).to_contain_text("Gramática · Copete")
    expect(item.locator(".rev-opt[aria-pressed='true']")).to_have_text("Dejar así")
    return "Respuesta de gramática simulada (LanguageTool real casi no marca gramática en textos cortos)."

@caso("REV-09", modo="lt")
def _(f):
    titulo_mal(f); f.agregar(); expect(f.dlg()).to_be_visible(timeout=12000)
    f.dlg_boton("Volver a editar"); expect(f.dlg()).to_have_count(0)
    assert f.tanda_n() == 0 and f.titulo() == "charla de marketing digital con egresados"
    f.agregar(); expect(f.dlg()).to_be_visible(timeout=12000)
    f.p.keyboard.press("Escape"); expect(f.dlg()).to_have_count(0)
    assert f.tanda_n() == 0

@caso("REV-10", modo="lt")
def _(f):
    titulo_mal(f); f.copete("Vení a conoser a los egresados"); f.agregar()
    expect(f.dlg()).to_be_visible(timeout=12000); f.dlg_boton("Aplicar y agregar")
    expect(f.p.locator("#tanda-count")).to_have_text("1")
    t = f.tanda()[0]
    assert t["titulo"] == "Charla de Marketing Digital con Egresados" and t["copete"] == "Vení a conocer a los egresados", t

@caso("REV-11", modo="lt")
def _(f):
    f.p.route(LT, lambda r: r.abort())
    titulo_mal(f); f.agregar()
    expect(f.toast()).to_have_text("No se pudo revisar la ortografía: revisala a ojo.")
    expect(f.p.locator("#dlg [data-rev='may']")).to_be_visible()
    f.dlg_boton("Volver a editar"); f.p.unroute(LT)
    colgados = []
    f.p.route(LT, lambda r: colgados.append(r))  # nunca responde → corta a los 8 s
    f.p.evaluate("document.querySelector('#toast').textContent = ''")
    t0 = time.time(); f.agregar()
    expect(f.toast()).to_have_text("No se pudo revisar la ortografía: revisala a ojo.", timeout=12000)
    seg = time.time() - t0
    expect(f.p.locator("#dlg [data-rev='may']")).to_be_visible()
    return f"Caída: aviso inmediato. Sin respuesta: aviso a los {seg:.0f} s. En los dos casos sigue con las mayúsculas."

@caso("REV-12", modo="lt")
def _(f):
    f.valido(); f.agregar(); expect(f.p.locator("#tanda-count")).to_have_text("1")
    assert f.dlg().count() == 0

@caso("REV-13", modo="lt")
def _(f):
    f.valido(); f.copete("Conocé la carrera y su plan de estudios")
    f.p.evaluate("""() => { window.__log = []; const b = document.querySelector('#btn-agregar');
      new MutationObserver(() => __log.push([b.textContent, b.disabled])).observe(b, {attributes: true, childList: true, characterData: true, subtree: true}); }""")
    f.agregar(); expect(f.p.locator("#tanda-count")).to_have_text("1", timeout=12000)
    log = f.p.evaluate("__log")
    assert ["Revisando ortografía…", True] in log, log

# ---------- tanda
@caso("TND-01")
def _(f):
    expect(f.p.locator("#tanda-count")).to_have_text("0")
    expect(f.p.locator("#tanda-empty p").first).to_have_text("Todavía no agregaste eventos.")
    assert f.p.is_disabled("#btn-confirmar")

@caso("TND-02")
def _(f):
    d = dia(7); f.valido(fecha=d); f.agregar_ok()
    f.valido(q="contador", nombre="Contador Público", fecha=dia(8), hora="15:00"); f.agregar_ok()
    it = f.p.locator("#tanda-list .tanda-item").first
    dias = ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"]
    esperado = f"{dias[datetime.fromisoformat(d).weekday()]} {ddmm(d)} · 10:00–11:00 · Monserrat"
    expect(it.locator(".ti-meta")).to_have_text(esperado)
    expect(it.locator(".ti-actions button")).to_have_text(["Editar", "Duplicar", "Quitar"])

@caso("TND-03")
def _(f):
    f.valido(); f.agregar_ok()
    f.p.locator("#tanda-list [data-acc='editar']").click()
    expect(f.p.locator("#form-title")).to_have_text("Editar evento")
    expect(f.p.locator("#btn-agregar")).to_have_text("Guardar cambios")
    expect(f.p.locator("#btn-limpiar")).to_have_text("Cancelar edición")
    assert f.p.is_disabled("#btn-confirmar")
    f.ini("12:00"); f.agregar()
    expect(f.toast()).to_have_text("Evento actualizado en la tanda.")
    assert f.tanda_n() == 1 and f.tanda()[0]["hora_ini"] == "12:00"

@caso("TND-04")
def _(f):
    f.valido(); f.agregar_ok()
    f.p.locator("#tanda-list [data-acc='duplicar']").click()
    expect(f.toast()).to_have_text("Copiado al formulario: cambiá la fecha y agregalo.")
    assert f.p.input_value("#fecha") == "" and f.chips() == ["Abogacía"]
    d = dia(14); f.fecha(d); f.agregar_ok()
    assert f.tanda()[1]["titulo"] == f"Reunión Informativa: Abogacía ({ddmm(d)})", f.tanda()[1]["titulo"]

@caso("TND-05")
def _(f):
    f.valido(); f.agregar_ok(); f.valido(q="contador", nombre="Contador Público", fecha=dia(8)); f.agregar_ok()
    f.p.locator("#tanda-list .tanda-item").first.locator("[data-acc='quitar']").click()
    assert f.tanda_n() == 1 and "Contador" in f.tanda()[0]["titulo"]

@caso("TND-06")
def _(f):
    f.valido(); f.agregar_ok(); f.valido(q="contador", nombre="Contador Público", fecha=dia(8)); f.agregar_ok()
    f.p.click("#btn-vaciar")
    expect(f.p.locator("#dlg-title")).to_have_text("¿Vaciar la tanda?")
    expect(f.p.locator("#dlg-content")).to_have_text("Se borran los 2 eventos sin confirmar.")
    f.dlg_boton("Vaciar"); expect(f.p.locator("#tanda-count")).to_have_text("0"); assert f.tanda() == []

@caso("TND-07")
def _(f):
    f.valido(sede="B"); f.descripcion("Te esperamos en Belgrano."); f.agregar_ok()
    expect(f.p.locator("#seg-sede button[data-v='B']")).to_have_attribute("aria-pressed", "true")
    expect(f.p.locator("#seg-tipo button[data-v='ri_grado']")).to_have_attribute("aria-pressed", "true")
    assert f.chips() == [] and f.p.input_value("#fecha") == "" and f.p.input_value("#hora-ini") == ""

@caso("TND-08")
def _(f):
    f.valido(); f.agregar_ok(); f.p.reload(); expect(f.p.locator("#tanda-count")).to_have_text("1")

@caso("CNF-01")
def _(f):
    f.valido(); f.agregar_ok(); expect(f.p.locator("#btn-confirmar")).to_have_text("Enviar a revisión")
    f.valido(fecha=dia(8)); f.agregar_ok(); expect(f.p.locator("#btn-confirmar")).to_have_text("Enviar 2 eventos a revisión")

@caso("CNF-02")
def _(f):
    f.valido(); f.agregar_ok()
    f.p.evaluate("d => { const t = JSON.parse(localStorage.getItem('uade_alta_tanda')); t[0].fecha = d; localStorage.setItem('uade_alta_tanda', JSON.stringify(t)); }", dia(-2))
    f.p.reload()
    item = f.p.locator("#tanda-list .tanda-item").first
    expect(item).to_have_class(re.compile("con-error")); expect(item.locator(".ti-error")).to_have_text("⚠ La fecha ya pasó.")
    f.p.click("#btn-confirmar")
    expect(f.p.locator("#dlg-title")).to_have_text("Hay 1 evento para corregir")
    expect(f.p.locator("#dlg-content li")).to_contain_text("La fecha ya pasó.")
    f.dlg_boton("Corregirlo ahora")
    expect(f.p.locator("#pasos button[data-paso='4']")).to_have_attribute("aria-current", "step")
    assert f.err("fecha") == "La fecha ya pasó."
    expect(f.p.locator("#pasos button[data-paso='4']")).to_have_class(re.compile("con-error"))
    f.fecha(dia(10)); f.agregar(); expect(f.toast()).to_have_text("Evento actualizado en la tanda.")
    expect(item).not_to_have_class(re.compile("con-error"))
    return ("Pedido del equipo, punto 2: el evento con error queda en rojo en la tanda con el motivo; 'Corregirlo ahora' "
            "lo abre directo en el paso del error (marcado en rojo). Simulado con una fecha vencida.")

@caso("CNF-03")
def _(f):
    f.valido(); f.agregar_ok(); f.valido(fecha=dia(8)); f.agregar_ok()
    f.p.click("#btn-confirmar")
    expect(f.p.locator("#dlg-title")).to_have_text("¿Enviar 2 eventos a revisión?")
    expect(f.p.locator("#dlg-content li")).to_have_count(2)
    expect(f.p.locator("#dlg-content")).to_contain_text("(modo prueba: no se envían)")
    f.dlg_boton("Volver"); assert f.tanda_n() == 2

@caso("CNF-04")
def _(f):
    f.valido(); f.agregar_ok(); f.p.click("#btn-confirmar"); f.dlg_boton("Enviar a revisión")
    expect(f.toast()).to_have_text("Enviado a revisión.")
    expect(f.p.locator("#view-mis")).to_be_visible()
    assert f.tanda() == [] and f.p.locator("#tabla-mis tbody tr").count() == 1
    assert f.eventos()[0]["estado"] == "para_revisar" and f.eventos()[0]["accion_pendiente"] is None
    return "Cambio del panel de control: confirmar ahora envía a revisión (no va a Intranet hasta que Marketing lo aprueba)."

@caso("CNF-05")
def _(f):
    for i in range(3): f.valido(fecha=dia(7 + i)); f.agregar_ok()
    f.confirmar()
    ids = {e["tanda_id"] for e in f.eventos()}; assert len(ids) == 1 and len(f.eventos()) == 3

@caso("EVT-01")
def _(f):
    f.valido(fecha=dia(12), hora="09:00"); f.agregar_ok(); f.valido(fecha=dia(7), hora="15:00"); f.agregar_ok()
    f.valido(fecha=dia(7), hora="09:00", q="contador", nombre="Contador Público"); f.agregar_ok(); f.confirmar()
    ids = f.p.eval_on_selector_all("#tabla-mis tbody tr", "rs => rs.map(r => r.dataset.id)")
    esperado = [e["id"] for e in sorted(f.eventos(), key=lambda e: e["fecha"] + e["hora_ini"])]
    assert ids == esperado, (ids, esperado)
    return "Orden por fecha y hora OK. El filtro de 30 días se prueba en modo real."

@caso("EVT-07")
def _(f):
    f.valido(); f.abrir_mas(); f.p.fill("#cupo", "40"); f.agregar_ok(); f.confirmar()
    f.p.locator("#tabla-mis [data-acc='ver']").click()
    expect(f.dlg()).to_be_visible()
    claves = f.p.eval_on_selector_all("#dlg dt", "l => l.map(x => x.textContent)")
    assert claves == ["Estado", "Carreras (Umbraco)", "Fecha", "Sede", "Categoría", "Audiencia", "Sector",
                      "Origen / Categ. CRM", "Inscripción / cupo", "Copete", "Descripción"], claves
    expect(f.p.locator("#dlg dd").nth(8)).to_have_text("Sí / 40")

@caso("EVT-09")
def _(f):
    f.valido(); f.agregar_ok(); f.confirmar()
    f.p.locator("#tabla-mis [data-acc='editar']").click()
    expect(f.p.locator("#btn-agregar")).to_have_text("Guardar y reenviar")
    expect(f.p.locator("#btn-agregar")).to_be_visible()
    f.ini("16:00"); f.agregar()
    expect(f.toast()).to_have_text("Cambios guardados: vuelven a revisión.")
    expect(f.p.locator("#view-mis")).to_be_visible()
    assert f.eventos()[0]["hora_ini"] == "16:00" and f.eventos()[0]["estado"] == "para_revisar"
    return "Editar lo vuelve a 'Para revisar'. 'Cambios para revisar' (ya en Intranet) se prueba en modo real."

@caso("EVT-10")
def _(f):
    f.valido(); f.agregar_ok(); f.confirmar()
    f.p.locator("#tabla-mis [data-acc='cancelar']").click()
    expect(f.p.locator("#dlg-content")).to_contain_text("Todavía no está en Intranet: no se va a dar de alta.")
    f.dlg_boton("Cancelar evento"); expect(f.toast()).to_have_text("Evento cancelado.")
    assert f.eventos()[0]["estado"] == "cancelado"
    return "Caso 'en cola' probado acá; el caso 'ya en Intranet' (baja) se prueba en modo real."

@caso("EVT-12")
def _(f):
    for i in range(3): f.valido(fecha=dia(7 + i)); f.agregar_ok()
    f.confirmar(); expect(f.p.locator("#mis-count")).to_have_text("3")
    f.p.locator("#tabla-mis [data-acc='cancelar']").first.click(); f.dlg_boton("Cancelar evento")
    expect(f.p.locator("#mis-count")).to_have_text("2")

# ---------- cambios pedidos por el equipo (casos nuevos)
NUEVOS = {
    "NUE-01": ("Cuentas", "Tipos de evento según la cuenta", "Facultades/Online/Costa: RI de grado, Taller OVO y Evento; UBS: RI de posgrado y Evento; las carreras se filtran por nivel."),
    "NUE-02": ("Pasos", "Carga por pasos con Siguiente/Anterior", "Siguiente no avanza si el paso tiene errores; los números de arriba llevan a cualquier paso."),
    "NUE-03": ("Dónde y cuándo", "Link obligatorio si la reunión es online", "Con modalidad Online el copete pasa a 'Link de la reunión online' y exige https://."),
    "NUE-04": ("Textos", "UADE siempre en mayúsculas", "Al escribir 'uade' en título, copete o descripción queda 'UADE'; no toca mails ni webs."),
    "NUE-05": ("Taller OVO", "Taller OVO completo", "Sin inscripción, Origen OVO, Categoría CRM Taller Orientación Vocacional, sector Admisiones, carrera opcional."),
    "NUE-06": ("Taller OVO", "Taller OVO se graba en Supabase", "Modo real: el tipo 'ovo' se guarda con sus valores."),
    "NUE-07": ("Panel de control", "Simulación de Intranet y de Umbraco", "Cada evento para revisar muestra los campos de Intranet y la carrera, School y Site que se aplican en Umbraco."),
    "NUE-08": ("Panel de control", "Corregir en el panel y devolver al REN", "Las mayúsculas se aplican con un clic; devolver exige comentario; el REN lo ve, corrige y vuelve a revisión."),
    "NUE-09": ("Panel de control", "Aprobar por evento o por tanda", "Lo que tiene errores no se puede aprobar; 'Aprobar los N listos' deja el resto para revisar; lo aprobado queda en cola de alta."),
    "NUE-11": ("Panel de control", "Circuito completo en el HTML de prueba", "Formulario y panel en un solo archivo: el REN envía, el revisor aprueba y el REN ve el estado."),
    "NUE-12": ("Panel de control", "Circuito completo dentro del visor de Claude", "Abierto en un visor aislado (sin guardado ni navegación): el link al panel funciona y el panel ve lo cargado."),
    "NUE-13": ("Opciones del evento", "Categoría CRM según Origen CRM", "Al elegir el Origen CRM, la Categoría CRM se completa sola y se puede cambiar."),
    "NUE-10": ("Panel de control", "Permisos del panel en Supabase", "Modo real: un REN no entra al panel ni aprueba por API; un revisor aprueba y queda registrado quién."),
}

def a_panel(f):
    f.p.goto(PANEL); expect(f.p.locator("#view-panel")).to_be_visible()

def tarjeta(f, titulo):
    return f.p.locator(".rev-ev").filter(has=f.p.locator("h3", has_text=re.compile("^" + re.escape(titulo) + "$")))

@caso("NUE-07")
def _(f):
    f.valido(sede="B"); f.descripcion("Te esperamos en Belgrano."); f.agregar_ok(); f.confirmar()
    a_panel(f)
    titulo = f"Reunión Informativa: Abogacía ({ddmm(dia(7))})"
    t = tarjeta(f, titulo); expect(t).to_have_count(1)
    expect(f.p.locator(".grupo h2")).to_have_text("Tanda de un REN (modo prueba)")
    intra, umb = t.locator(".sim").nth(0), t.locator(".sim").nth(1)
    expect(intra).to_contain_text("TitActiv"); expect(intra).to_contain_text("Belgrano (B)")
    expect(intra).to_contain_text("Charlas (8)"); expect(intra).to_contain_text("Reuni. Infor. (12)")
    expect(umb.locator("a")).to_have_text("ABOGACÍA"); expect(umb.locator("a")).to_have_attribute("href", re.compile(r"^https?://"))
    expect(umb).to_contain_text("Facultad de Ciencias Jurídicas y de la Comunicación")
    expect(umb).to_contain_text("Belgrano"); expect(umb).to_contain_text("Apagado")
    expect(t.locator(".al-ok")).to_have_text("✓ Sin observaciones.")
    expect(t.locator("[data-acc='aprobar']")).to_be_enabled()
    return "Intranet: título, sede, categorías. Umbraco: página ABOGACÍA (link), Schools de la facultad, Sites Belgrano, switch apagado."

@caso("NUE-08")
def _(f):
    f.otro(); f.escribir_titulo("charla abierta en la facultad"); f.agregar()
    # el formulario también avisa las mayúsculas: el REN elige "Dejar así" y llega mal al panel
    expect(f.dlg()).to_be_visible(timeout=8000)
    f.p.locator("#dlg-content [data-rev='may'] .rev-opt", has_text="Dejar así").click()
    f.dlg_boton("Aplicar y agregar"); expect(f.p.locator("#tanda-count")).to_have_text("1")
    f.confirmar()
    a_panel(f)
    t = tarjeta(f, "charla abierta en la facultad")
    expect(t.locator(".al-aviso", has_text="Mayúsculas")).to_contain_text('"Charla Abierta en la Facultad"')
    t.locator("[data-fix='mayusculas']").click()
    expect(f.toast()).to_have_text("Corrección aplicada.")
    t = tarjeta(f, "Charla Abierta en la Facultad"); expect(t).to_have_count(1)
    # devolver: sin comentario no se devuelve
    t.locator("[data-acc='devolver']").click(); f.dlg_boton("Devolver")
    expect(f.toast()).to_have_text("No se devolvió: escribí qué tiene que corregir.")
    t.locator("[data-acc='devolver']").click(); f.p.fill("#comentario-dev", "Cambiá el horario a la tarde."); f.dlg_boton("Devolver")
    expect(f.toast()).to_have_text("Devuelto al REN.")
    expect(f.p.locator("#filtros [data-f='devuelto'] .muted")).to_have_text("1")
    # el REN lo ve y lo corrige
    f.p.goto(HTML); f.p.click(".tab[data-view='mis']")
    fila_ = f.p.locator("#tabla-mis tbody tr").first
    expect(fila_.locator(".estado")).to_have_text("Devuelto para corregir")
    expect(fila_.locator(".comentario-rev")).to_have_text("Marketing: Cambiá el horario a la tarde.")
    fila_.locator("[data-acc='editar']", has_text="Corregir").click()
    f.ini("16:00"); f.agregar()
    expect(f.toast()).to_have_text("Cambios guardados: vuelven a revisión.")
    a_panel(f)
    t = tarjeta(f, "Charla Abierta en la Facultad")
    expect(t.locator(".comentario-rev")).to_have_text("Se lo habían devuelto: Cambiá el horario a la tarde.")
    expect(t.locator(".rev-ev-head .muted")).to_contain_text("16:00")
    return "Mayúsculas con un clic; devolver sin comentario no hace nada; el REN ve el comentario, corrige y vuelve al panel con el comentario anterior a la vista."

@caso("NUE-09")
def _(f):
    f.valido(); f.agregar_ok(); f.valido(fecha=dia(8)); f.agregar_ok(); f.confirmar()
    f.p.evaluate("d => { const t = JSON.parse(localStorage.getItem('uade_alta_eventos')); t[1].fecha = d; localStorage.setItem('uade_alta_eventos', JSON.stringify(t)); }", dia(-2))
    a_panel(f)
    expect(f.p.locator(".rev-ev.con-error")).to_have_count(1)
    expect(f.p.locator(".rev-ev.con-error .al-bloquea")).to_contain_text("La fecha ya pasó.")
    expect(f.p.locator(".rev-ev.con-error [data-acc='aprobar']")).to_be_disabled()
    boton = f.p.locator("[data-acc='aprobar-tanda']")
    expect(boton).to_have_text("Aprobar 1 de 2 (sin errores)")
    boton.click()
    expect(f.p.locator("#dlg-content li")).to_have_count(1)
    f.dlg_boton("Aprobar")
    expect(f.toast()).to_have_text("Aprobado: pasa a la cola de Intranet.")
    estados = sorted((e["estado"], e["accion_pendiente"]) for e in f.eventos())
    assert estados == [("aprobado", "alta"), ("para_revisar", None)], estados
    expect(f.p.locator("#filtros [data-f='proceso'] .muted")).to_have_text("1")
    return "El evento con fecha vencida queda bloqueado; 'Aprobar 1 de 2 (sin errores)' aprueba solo el bueno y lo deja en cola de alta."

@caso("NUE-11")
def _(f):
    f.p.goto(UNICO); expect(f.p.locator("#view-nuevo")).to_be_visible()
    f.p.route(LT, lt_vacio)
    f.valido(); f.agregar_ok(); f.confirmar()
    titulo = f"Reunión Informativa: Abogacía ({ddmm(dia(7))})"
    f.p.click("#link-panel")
    expect(f.p.locator("#view-panel")).to_be_visible()
    t = tarjeta(f, titulo); expect(t).to_have_count(1)
    t.locator("[data-acc='aprobar']").click(); f.dlg_boton("Aprobar")
    expect(f.toast()).to_have_text("Aprobado: pasa a la cola de Intranet.")
    f.p.click(".who [data-ir='formulario']")
    expect(f.p.locator("#view-nuevo")).to_be_visible()
    f.p.click(".tab[data-view='mis']")
    expect(f.p.locator("#tabla-mis tbody tr .estado")).to_have_text("Aprobado, en cola")
    return "En un solo archivo: el REN envía a revisión, pasa al panel con el link, aprueba y al volver ve 'Aprobado, en cola'."

@caso("NUE-12")
def _(f):
    # El visor de archivos de Claude abre el HTML en un iframe aislado: sin localStorage y con links restringidos.
    f.p.goto(REAL + "pruebas/visor_simulado.html")
    fl = f.p.frame_locator("#f")
    expect(fl.locator("#view-nuevo")).to_be_visible(timeout=15000)
    g = F(f.p.query_selector("#f").content_frame())
    expect(fl.locator("#banner-prueba")).to_contain_text("Este visor no deja guardar")
    g.valido(); g.agregar_ok(); g.confirmar()
    g.p.click("#link-panel")
    expect(fl.locator("#view-panel")).to_be_visible()
    titulo = f"Reunión Informativa: Abogacía ({ddmm(dia(7))})"
    t = fl.locator(".rev-ev").filter(has=fl.locator("h3", has_text=re.compile("^" + re.escape(titulo) + "$")))
    expect(t).to_have_count(1)
    t.locator("[data-acc='aprobar']").click(); fl.locator("#dlg-actions button", has_text="Aprobar").click()
    expect(fl.locator("#toast")).to_have_text("Aprobado: pasa a la cola de Intranet.")
    fl.locator(".who [data-ir='formulario']").click()
    expect(fl.locator("#view-nuevo")).to_be_visible()
    fl.locator(".tab[data-view='mis']").click()
    expect(fl.locator("#tabla-mis tbody tr .estado")).to_have_text("Aprobado, en cola")
    return ("Dentro de un visor aislado como el de Claude (sin guardado en el navegador): el link al panel funciona, "
            "el panel ve el evento cargado, se aprueba y el REN ve el estado. Lo cargado dura mientras el archivo esté abierto.")


@caso("NUE-01")
def _(f):
    assert f.tipos() == ["ri_grado", "ovo", "otro"], f.tipos()
    f.cuenta("ubs"); assert f.tipos() == ["ri_posgrado", "otro"], f.tipos()
    f.buscar("abogacia"); expect(f.p.locator("#sugerencias li.vacio")).to_be_visible()
    f.buscar("marketing"); assert f.sug_nombres() == ["Especialización en Dirección de Marketing"], f.sug_nombres()
    f.cuenta("online"); assert f.tipos() == ["ri_grado", "ovo", "otro"]
    f.buscar("marketing"); assert all(not n.startswith("Especialización") for n in f.sug_nombres())
    f.cuenta("prueba.formulario"); assert f.tipos() == ["ri_grado", "ri_posgrado", "ovo", "otro"]
    return "En modo prueba se elige la cuenta arriba ('Probar como'); en modo real sale del mail con el que entra."

@caso("NUE-02")
def _(f):
    assert f.paso_actual() == 1 and f.p.is_hidden("#btn-agregar") and f.p.is_hidden("#btn-anterior")
    f.p.click("#btn-siguiente"); assert f.paso_actual() == 2
    f.p.click("#btn-siguiente"); assert f.paso_actual() == 2 and f.err("carreras") == "Elegí al menos una carrera."
    f.carrera("abogacia", "Abogacía"); f.p.click("#btn-siguiente"); assert f.paso_actual() == 3
    f.p.click("#btn-siguiente"); assert f.paso_actual() == 4
    f.p.click("#btn-siguiente"); assert f.paso_actual() == 4 and f.err("sede") == "Elegí la sede o modalidad."
    f.sede("M"); f.fecha(dia(7)); f.ini("10:00"); f.p.click("#btn-siguiente"); assert f.paso_actual() == 5
    assert f.p.is_visible("#btn-agregar") and f.p.is_hidden("#btn-siguiente")
    f.p.click("#btn-anterior"); assert f.paso_actual() == 4
    f.agregar_ok(); assert f.paso_actual() == 1

@caso("NUE-03")
def _(f):
    f.carrera("abogacia", "Abogacía"); f.sede("O"); f.fecha(dia(7)); f.ini("10:00"); f.paso(5)
    expect(f.p.locator("#copete-lbl")).to_have_text("Link de la reunión online (obligatorio)")
    f.agregar(); assert f.err("copete") == "Pegá el link de la reunión online (empieza con https://)."
    f.copete("zoom punto com"); f.agregar(); assert f.err("copete").startswith("Pegá el link")
    f.copete("https://teams.microsoft.com/l/meetup-join/abc"); f.agregar_ok()
    f.sede("M"); f.paso(5); expect(f.p.locator("#copete-lbl")).to_have_text("Copete (opcional)")

@caso("NUE-04")
def _(f):
    f.tipo("otro"); f.escribir_titulo("charla en uade")
    assert f.titulo() == "charla en UADE", f.titulo()
    f.copete("Vení a uade, escribinos a face@uade.edu.ar o mirá www.uade.edu.ar")
    assert f.p.input_value("#copete") == "Vení a UADE, escribinos a face@uade.edu.ar o mirá www.uade.edu.ar", f.p.input_value("#copete")
    f.descripcion("Uade te invita. Uade.")
    assert f.p.input_value("#descripcion") == "UADE te invita. UADE.", f.p.input_value("#descripcion")

@caso("NUE-05")
def _(f):
    f.tipo("ovo"); f.paso(2); expect(f.p.locator("#carrera-opcional")).to_be_visible()
    f.sede("M"); f.fecha(dia(8)); f.ini("10:00"); f.escribir_titulo("Taller de Orientación Vocacional"); f.agregar_ok()
    t = f.tanda()[0]
    assert (t["tipo"], t["requiere_inscripcion"], t["origen_crm"], t["categ_crm"], t["sector"], t["categ"]) == ("ovo", False, "O", 38, [159], [8]), t
    return "Intranet no tiene un sector 'Taller OVO': lo OVO va en Origen CRM = OVO. Sector propuesto: Admisiones (se puede cambiar)."

# ---------- responsive y modo oscuro
@caso("RES-01", modo="res")
def _(f):
    f.p.set_viewport_size({"width": 1366, "height": 900})
    a, b = f.p.locator("#form").bounding_box(), f.p.locator("#tanda").bounding_box()
    assert b["x"] > a["x"] + a["width"] - 1 and abs(b["y"] - a["y"]) < 40, (a, b)

@caso("RES-02", modo="res")
def _(f):
    f.p.set_viewport_size({"width": 800, "height": 900})
    a, b = f.p.locator("#form").bounding_box(), f.p.locator("#tanda").bounding_box()
    assert b["y"] >= a["y"] + a["height"] - 1, (a, b)

@caso("RES-03", modo="res")
def _(f):
    f.p.set_viewport_size({"width": 390, "height": 844})
    assert f.p.evaluate("document.documentElement.scrollWidth <= innerWidth"), "hay scroll horizontal"
    f.valido(); f.agregar_ok()
    f.p.screenshot(path=str(CAPTURAS / "celular_formulario.png"), full_page=True)
    titulo_mal(f); f.agregar(); expect(f.dlg()).to_be_visible(timeout=12000)
    f.p.screenshot(path=str(CAPTURAS / "celular_aviso.png"))
    caja = f.p.locator("#dlg").bounding_box()
    assert caja["x"] >= 0 and caja["x"] + caja["width"] <= 390, caja
    return "Capturas en dist/capturas/celular_*.png (incluye el aviso de ortografía)."

@caso("RES-04", modo="oscuro")
def _(f):
    fondo = f.p.evaluate("getComputedStyle(document.body).backgroundColor")
    nums = [int(x) for x in re.findall(r"\d+", fondo)[:3]]
    assert sum(nums) / 3 < 80, fondo
    f.valido(); f.agregar_ok(); titulo_mal(f); f.copete("Vení a conoser la facultad"); f.agregar()
    expect(f.dlg()).to_be_visible(timeout=12000)
    f.p.screenshot(path=str(CAPTURAS / "oscuro_aviso.png"))
    f.dlg_boton("Volver a editar")
    f.p.screenshot(path=str(CAPTURAS / "oscuro_formulario.png"), full_page=True)
    return f"Fondo en oscuro {fondo}. Capturas en dist/capturas/oscuro_*.png."


# =====================================================================================
#                                   CASOS · MODO REAL
# =====================================================================================
CTX = {}

def preparar_real():
    if not SECRETA: raise Bloqueado("Falta la clave secreta en privado/.env")
    st, us = svc("GET", "/auth/v1/admin/users?per_page=200")
    if st != 200: raise Bloqueado(f"No pude leer usuarios ({st})")
    lista = us["users"] if isinstance(us, dict) else us
    ids = {u["email"]: u["id"] for u in lista}
    CTX["yo"], CTX["otro"] = ids[MAIL_PRUEBA], ids["face@uade.edu.ar"]
    CTX["clave"] = clave_prueba()
    svc("DELETE", f"/rest/v1/eventos?creado_por=eq.{CTX['yo']}")
    svc("DELETE", "/rest/v1/eventos?titulo=like.PRUEBA%20AUTO*")
    yo = dict(creado_por=CTX["yo"], creado_email=MAIL_PRUEBA)
    filas = {
        "otro": fila_evento(creado_por=CTX["otro"], creado_email="face@uade.edu.ar", titulo="PRUEBA AUTO · Evento de otro REN", carreras=[ABOGACIA]),
        "viejo": fila_evento(**yo, fecha=dia(-40), titulo="PRUEBA AUTO · Hace 40 días"),
        "pasado": fila_evento(**yo, fecha=dia(-10), titulo="PRUEBA AUTO · Hace 10 días"),
        "intranet": fila_evento(**yo, fecha=dia(21), titulo="PRUEBA AUTO · En Intranet", estado="en_intranet", accion_pendiente=None, id_actividad=990000001),
        "manual": fila_evento(**yo, fecha=dia(22), titulo="PRUEBA AUTO · Alta manual", estado="alta_manual", accion_pendiente=None, id_actividad=990000002),
        "web": fila_evento(**yo, fecha=dia(23), titulo="PRUEBA AUTO · Publicado", estado="en_umbraco", accion_pendiente=None, id_actividad=990000003),
        "error": fila_evento(**yo, fecha=dia(24), titulo="PRUEBA AUTO · Con error", estado="error_intranet", error="Prueba: error simulado de Intranet"),
        "cancelado": fila_evento(**yo, fecha=dia(25), titulo="PRUEBA AUTO · Cancelado", estado="cancelado", accion_pendiente=None),
    }
    for k, fila in filas.items():
        st, r = svc("POST", "/rest/v1/eventos", fila)
        if st != 201: raise Bloqueado(f"No pude crear el evento de prueba '{k}': {st} {r}")
        CTX[k] = r[0]["id"]
    st, tok = sb("POST", "/auth/v1/token?grant_type=password", {"email": MAIL_PRUEBA, "password": CTX["clave"]}, prefer="")
    if st != 200: raise Bloqueado(f"No pude iniciar sesión con la cuenta de prueba ({st})")
    CTX["token"] = tok["access_token"]

def limpiar_real():
    revisor(False)
    if "yo" in CTX:
        svc("DELETE", f"/rest/v1/eventos?creado_por=eq.{CTX['yo']}")
    svc("DELETE", "/rest/v1/eventos?titulo=like.PRUEBA%20AUTO*")
    st, quedan = svc("GET", f"/rest/v1/eventos?select=id&or=(creado_por.eq.{CTX.get('yo', uuid.uuid4())},titulo.like.PRUEBA%20AUTO*)")
    return quedan

def login_ui(f, mail, clave):
    f.p.fill("#login-email", mail); f.p.fill("#login-clave", clave); f.p.click("#btn-entrar")

def fila(f, titulo):
    """Fila de un evento de prueba por el final de su título ('PRUEBA AUTO · <titulo>')."""
    t = titulo if titulo.startswith(("PRUEBA", "Reunión")) else "PRUEBA AUTO · " + titulo
    return f.p.locator("#tabla-mis tbody tr").filter(has=f.p.locator("td:first-child > div:first-child", has_text=re.compile("^" + re.escape(t) + "$")))

@caso("LOG-02", modo="real")
def _(f):
    login_ui(f, "usuario@gmail.com", "Pass1234")
    expect(f.p.locator("#login-err")).to_have_text("Usá tu mail @uade.edu.ar.")

@caso("LOG-03", modo="real")
def _(f):
    login_ui(f, MAIL_PRUEBA, "ClaveFalsa")
    expect(f.p.locator("#login-err")).to_have_text("Mail o contraseña incorrectos.", timeout=15000)

@caso("LOG-04", modo="real")
def _(f):
    f.p.context.set_offline(True)
    try:
        login_ui(f, MAIL_PRUEBA, "ClaveFalsa")
        expect(f.p.locator("#login-err")).to_have_text("Sin conexión. Probá de nuevo.", timeout=15000)
    finally:
        f.p.context.set_offline(False)

@caso("SEG-01", modo="real")
def _(f):
    expect(f.p.locator("#view-login")).to_be_visible()
    assert f.p.is_hidden("#tabs") and f.p.is_hidden("#view-nuevo") and f.p.is_hidden("#view-mis")
    st, r = sb("GET", "/rest/v1/eventos?select=id,titulo")
    assert st in (401, 403) or r == [], (st, r)
    return f"Sin sesión: solo pantalla de ingreso. La API sin login responde {st} (sin datos)."

@caso("LOG-05", modo="real")
def _(f):
    f.p.evaluate("""() => { window.__log = []; const b = document.querySelector('#btn-entrar');
      new MutationObserver(() => __log.push([b.textContent, b.disabled])).observe(b, {attributes: true, childList: true, subtree: true, characterData: true}); }""")
    login_ui(f, MAIL_PRUEBA, CTX["clave"])
    expect(f.p.locator("#view-nuevo")).to_be_visible(timeout=15000)
    assert ["Entrando…", True] in f.p.evaluate("__log")

@caso("LOG-01", modo="real")
def _(f):
    expect(f.p.locator("#tabs")).to_be_visible()
    expect(f.p.locator(".tab")).to_have_text(["Nuevo evento", re.compile(r"^Mis eventos")])
    expect(f.p.locator("#who")).to_have_text(MAIL_PRUEBA)
    assert f.p.is_hidden("#banner-prueba")
    assert f.tipos() == ["ri_grado", "ri_posgrado", "ovo", "otro"], f.tipos()
    return "Probado con la cuenta prueba.formulario@ (la del caso no existe); esa cuenta ve los 4 tipos."

@caso("LOG-06", modo="real")
def _(f):
    f.p.reload(); expect(f.p.locator("#view-nuevo")).to_be_visible(timeout=15000)
    expect(f.p.locator("#who")).to_have_text(MAIL_PRUEBA)

@caso("EVT-01", modo="real")
def _(f):
    f.p.click(".tab[data-view='mis']")
    expect(fila(f, "Hace 10 días")).to_have_count(1, timeout=10000)
    expect(fila(f, "Hace 40 días")).to_have_count(0)
    return "Muestra el de hace 10 días y no el de hace 40."

@caso("EVT-05", modo="real")
def _(f):
    for t, txt in [("En Intranet", "En Intranet #990000001"),  # títulos de las filas: 'PRUEBA AUTO · <t>' ("Alta manual", "En Intranet (a mano) #990000002"),
                   ("Publicado", "Publicado en la web #990000003"), ("Con error", "Error en Intranet"),
                   ("Cancelado", "Cancelado"), ("Hace 10 días", "Para revisar")]:
        expect(fila(f, t).locator("td").nth(3)).to_have_text(txt)

@caso("EVT-04", modo="real")
def _(f):
    expect(f.p.locator("#tabla-mis thead th")).to_have_text(["Evento", "Fecha", "Sede", "Estado", ""])
    err = fila(f, "Con error").locator(".t-sub", has_text="Prueba: error simulado")
    expect(err).to_be_visible()
    color = err.evaluate("e => getComputedStyle(e).color")
    return f"El error se ve debajo del título en rojo ({color})."

@caso("EVT-02", modo="real")
def _(f):
    cuenta = lambda code: int(f.p.locator(f"#filtros [data-f='{code}'] .muted").inner_text())
    esperado = {"todos": 6, "revision": 1, "devuelto": 0, "cola": 0, "intranet": 2, "web": 1, "error": 1, "cancelado": 1}
    obtenido = {k: cuenta(k) for k in esperado}
    assert obtenido == esperado, obtenido
    f.p.click("#filtros [data-f='intranet']"); expect(f.p.locator("#tabla-mis tbody tr")).to_have_count(2)
    f.p.click("#filtros [data-f='todos']")
    return "Contadores: " + ", ".join(f"{k} {v}" for k, v in obtenido.items()) + "."

@caso("EVT-03", modo="real")
def _(f):
    expect(fila(f, "Evento de otro REN")).to_have_count(0)
    f.p.click("#filtros [data-alcance]")
    expect(f.p.locator("#filtros [data-alcance]")).to_have_text("De todos los RENs")
    expect(fila(f, "Evento de otro REN").locator(".t-sub").first).to_contain_text("cargó face")

@caso("EVT-08", modo="real")
def _(f):
    for t in ["Evento de otro REN", "Hace 10 días", "Cancelado"]:
        expect(fila(f, t).locator("[data-acc='editar']")).to_have_count(0)
        expect(fila(f, t).locator("[data-acc='cancelar']")).to_have_count(0)
    expect(fila(f, "En Intranet").locator("[data-acc='editar']")).to_have_count(1)
    f.p.click("#filtros [data-alcance]")

@caso("EVT-12", modo="real")
def _(f):
    expect(f.p.locator("#mis-count")).to_have_text("5")
    return "Cuenta 5: los 6 propios del último mes menos el cancelado (no cuenta el del otro REN)."

@caso("CNF-05", modo="real")
def _(f):
    f.p.click(".tab[data-view='nuevo']")
    f.p.route(LT, lt_vacio)
    f.valido(fecha=dia(30), hora="10:00"); f.agregar_ok(); f.valido(fecha=dia(31), hora="10:00"); f.agregar_ok()
    f.p.click("#btn-confirmar")
    expect(f.p.locator("#dlg-content")).not_to_contain_text("modo prueba")
    f.dlg_boton("Enviar a revisión")
    expect(f.toast()).to_have_text("Enviado a revisión.", timeout=15000)
    st, r = svc("GET", f"/rest/v1/eventos?select=tanda_id,estado,accion_pendiente,creado_email&creado_por=eq.{CTX['yo']}&fecha=gte.{dia(30)}")
    assert len(r) == 2 and len({x["tanda_id"] for x in r}) == 1, r
    assert all(x["estado"] == "para_revisar" and x["accion_pendiente"] is None and x["creado_email"] == MAIL_PRUEBA for x in r), r
    return "Grabó 2 filas en Supabase con el mismo tanda_id, estado 'para_revisar' y sin acción (no va a Intranet hasta que se apruebe)."

@caso("NUE-06", modo="real")
def _(f):
    f.p.click(".tab[data-view='nuevo']"); f.p.route(LT, lt_vacio)
    f.tipo("ovo"); f.sede("M"); f.fecha(dia(33)); f.ini("10:00"); f.escribir_titulo("Taller de Orientación Vocacional"); f.agregar_ok()
    f.confirmar()
    st, r = svc("GET", f"/rest/v1/eventos?select=tipo,requiere_inscripcion,origen_crm,categ_crm,sector,categ&creado_por=eq.{CTX['yo']}&fecha=eq.{dia(33)}")
    assert r == [{"tipo": "ovo", "requiere_inscripcion": False, "origen_crm": "O", "categ_crm": 38, "sector": [159], "categ": [8]}], r
    return "Supabase acepta el tipo nuevo (sql/03_taller_ovo.sql) y guarda los valores del Taller OVO."

@caso("EVT-09", modo="real")
def _(f):
    expect(f.p.locator("#view-mis")).to_be_visible()
    fila(f, "PRUEBA AUTO · En Intranet").locator("[data-acc='editar']").click()
    expect(f.p.locator("#btn-agregar")).to_have_text("Guardar y reenviar")
    f.p.route(LT, lt_vacio)
    f.ini("18:00"); f.agregar()
    expect(f.toast()).to_have_text("Cambios guardados: vuelven a revisión.", timeout=15000)
    expect(fila(f, "PRUEBA AUTO · En Intranet").locator("td").nth(3)).to_have_text("Cambios para revisar #990000001")
    st, r = svc("GET", f"/rest/v1/eventos?select=estado,accion_pendiente,hora_ini,id_actividad&id=eq.{CTX['intranet']}")
    assert r[0] == {"estado": "para_revisar", "accion_pendiente": None, "hora_ini": "18:00", "id_actividad": 990000001}, r
    return "Editar algo que ya está en Intranet lo vuelve a revisión ('Cambios para revisar'); al aprobarlo se graba con MODIFICAR."

@caso("EVT-06", modo="real")
def _(f):
    fila(f, "PRUEBA AUTO · Alta manual").locator("[data-acc='cancelar']").click()
    expect(f.p.locator("#dlg-content")).to_contain_text("Se va a dar de baja en Intranet.")
    f.dlg_boton("Cancelar evento"); expect(f.toast()).to_have_text("Evento cancelado.", timeout=15000)
    expect(fila(f, "PRUEBA AUTO · Alta manual").locator("td").nth(3)).to_have_text("Baja en cola #990000002")
    return "Cancelar algo que ya está en Intranet queda 'Baja en cola' (no pasa por revisión)."

@caso("EVT-10", modo="real")
def _(f):
    r = fila(f, f"Reunión Informativa: Abogacía ({ddmm(dia(30))})")
    r.locator("[data-acc='cancelar']").click()
    expect(f.p.locator("#dlg-content")).to_contain_text("Todavía no está en Intranet: no se va a dar de alta.")
    f.dlg_boton("Cancelar evento"); expect(f.toast()).to_have_text("Evento cancelado.", timeout=15000)
    expect(r.locator("td").nth(3)).to_have_text("Cancelado")
    st, x = svc("GET", f"/rest/v1/eventos?select=estado,accion_pendiente&creado_por=eq.{CTX['yo']}&fecha=eq.{dia(30)}")
    assert x == [{"estado": "cancelado", "accion_pendiente": None}], x
    return "Los dos avisos OK (con y sin IdActividad); en la base queda la acción correcta."

@caso("EVT-11", modo="real")
def _(f):
    st, r = svc("PATCH", f"/rest/v1/eventos?id=eq.{CTX['error']}", {"estado": "en_umbraco", "error": None, "id_actividad": 990000004, "accion_pendiente": None})
    assert st == 200, (st, r)
    expect(fila(f, "PRUEBA AUTO · Con error").locator("td").nth(3)).to_have_text("Publicado en la web #990000004", timeout=15000)
    return "Se cambió el estado desde la base (como lo hará el proceso automático) y la pantalla se actualizó sola."

# ---------- seguridad por API, con el token de la cuenta de prueba
def api_ren(metodo, ruta, cuerpo=None): return sb(metodo, ruta, cuerpo, token=CTX["token"])

@caso("SEG-02", modo="real")
def _(f):
    st, r = api_ren("GET", f"/rest/v1/eventos?select=titulo&id=eq.{CTX['otro']}")
    assert st == 200 and len(r) == 1, (st, r)
    st, r = api_ren("PATCH", f"/rest/v1/eventos?id=eq.{CTX['otro']}", {"titulo": "Hackeado"})
    _, x = svc("GET", f"/rest/v1/eventos?select=titulo,estado&id=eq.{CTX['otro']}")
    assert x[0]["titulo"] == "PRUEBA AUTO · Evento de otro REN", x
    st2, r2 = api_ren("PATCH", f"/rest/v1/eventos?id=eq.{CTX['otro']}", {"estado": "cancelado"})
    _, x = svc("GET", f"/rest/v1/eventos?select=estado&id=eq.{CTX['otro']}")
    assert x[0]["estado"] == "para_revisar", x
    return f"Lo ve; editar ({st}, {len(r) if isinstance(r, list) else r} filas) y cancelar por API no cambian nada."

@caso("SEG-03", modo="real")
def _(f):
    st, r = api_ren("DELETE", f"/rest/v1/eventos?id=eq.{CTX['pasado']}")
    _, x = svc("GET", f"/rest/v1/eventos?select=id&id=eq.{CTX['pasado']}")
    assert len(x) == 1, "se pudo borrar"
    assert f.p.locator("text=Eliminar").count() == 0 and f.p.locator("text=Borrar").count() == 0
    return f"Borrar por API responde {st} y el evento sigue. En la pantalla no hay opción de borrar."

@caso("SEG-04", modo="real")
def _(f):
    st, r = api_ren("PATCH", f"/rest/v1/eventos?id=eq.{CTX['viejo']}", {"estado": "en_umbraco", "id_actividad": 123456, "creado_por": CTX["otro"]})
    _, x = svc("GET", f"/rest/v1/eventos?select=estado,id_actividad,creado_por&id=eq.{CTX['viejo']}")
    assert x[0] == {"estado": "para_revisar", "id_actividad": None, "creado_por": CTX["yo"]}, x
    st, r = api_ren("PATCH", f"/rest/v1/eventos?id=eq.{CTX['viejo']}", {"estado": "aprobado"})
    _, x = svc("GET", f"/rest/v1/eventos?select=estado,accion_pendiente&id=eq.{CTX['viejo']}")
    assert x[0] == {"estado": "para_revisar", "accion_pendiente": None}, x
    st, r = api_ren("POST", "/rest/v1/eventos", fila_evento(fecha=dia(40), titulo="PRUEBA AUTO · Alta forzada", estado="en_umbraco", id_actividad=777777, creado_por=CTX["otro"]))
    assert st == 201, (st, r)
    assert (r[0]["estado"], r[0]["id_actividad"], r[0]["creado_por"]) == ("para_revisar", None, CTX["yo"]), r[0]
    return "Por API no se puede cambiar estado, IdActividad ni dueño (ni al editar ni al crear), ni autoaprobarse: la base los pisa."

@caso("SEG-05", modo="real")
def _(f):
    st, r = api_ren("POST", "/rest/v1/eventos", fila_evento(fecha=dia(-1), titulo="PRUEBA AUTO · Fecha pasada"))
    assert st >= 400 and "ya pasó" in json.dumps(r, ensure_ascii=False), (st, r)
    return f"Rechazado ({st}): 'La fecha del evento ya pasó.'"

@caso("SEG-06", modo="real")
def _(f):
    st, r = api_ren("PATCH", f"/rest/v1/eventos?id=eq.{CTX['cancelado']}", {"titulo": "Revivido", "estado": "para_revisar"})
    _, x = svc("GET", f"/rest/v1/eventos?select=titulo,estado&id=eq.{CTX['cancelado']}")
    assert x[0]["estado"] == "cancelado" and x[0]["titulo"] == "PRUEBA AUTO · Cancelado", x
    return f"Rechazado ({st}): 'El evento está cancelado.' En pantalla el cancelado no tiene Editar."

def revisor(si):
    if si: svc("POST", "/rest/v1/revisores", {"email": MAIL_PRUEBA})
    else: svc("DELETE", f"/rest/v1/revisores?email=eq.{MAIL_PRUEBA}")

@caso("NUE-10", modo="real")
def _(f):
    p = f.p.context.new_page()
    try:
        p.goto(REAL + "panel.html")
        expect(p.locator("#view-sin-permiso")).to_be_visible(timeout=15000)
        revisor(True)
        p.reload(); expect(p.locator("#view-panel")).to_be_visible(timeout=15000)
        t = p.locator(".rev-ev").filter(has=p.locator("h3", has_text="PRUEBA AUTO · Evento de otro REN"))
        expect(t).to_have_count(1)
        expect(p.locator(".grupo h2").first).to_be_visible()
        expect(t.locator(".sim").nth(1)).to_contain_text("ABOGACÍA")
        # devolver sin comentario: la base lo rechaza
        st, r = api_ren("PATCH", f"/rest/v1/eventos?id=eq.{CTX['otro']}", {"estado": "devuelto"})
        assert st >= 400 and "comentario" in json.dumps(r, ensure_ascii=False), (st, r)
        t.locator("[data-acc='aprobar']").click()
        p.locator("#dlg-actions button", has_text="Aprobar").click()
        expect(p.locator("#toast")).to_have_text("Aprobado: pasa a la cola de Intranet.", timeout=15000)
        _, x = svc("GET", f"/rest/v1/eventos?select=estado,accion_pendiente,revisado_por,aprobado_at&id=eq.{CTX['otro']}")
        assert x[0]["estado"] == "aprobado" and x[0]["accion_pendiente"] == "alta" and x[0]["revisado_por"] == MAIL_PRUEBA and x[0]["aprobado_at"], x
    finally:
        revisor(False); p.close()
    return ("Sin ser revisor: 'No tenés acceso al panel'. Como revisor: ve el evento de otro REN con la simulación, "
            "devolver sin comentario lo rechaza la base, y al aprobar queda 'aprobado', acción 'alta' y quién lo revisó.")

@caso("LOG-07", modo="real")
def _(f):
    f.p.click("#btn-salir"); expect(f.p.locator("#view-login")).to_be_visible()
    assert f.p.is_hidden("#tabs")
    f.p.reload(); expect(f.p.locator("#view-login")).to_be_visible(timeout=15000)
    return "Después de recargar sigue pidiendo login."


# =====================================================================================
#                                   EJECUCIÓN
# =====================================================================================
def correr_uno(cid, fn, f):
    try:
        obs = fn(f) or ""
        RES[cid] = ("Pasó", obs)
    except NoAplica as e: RES[cid] = ("No aplica", str(e))
    except Bloqueado as e: RES[cid] = ("Bloqueado", str(e))
    except Exception as e:
        msg = str(e).split("\nCall log:")[0].strip()
        RES[cid] = ("Falló", f"{type(e).__name__}: {msg[:600]}")
        try: f.p.screenshot(path=str(CAPTURAS / f"falla_{cid}.png"))
        except Exception: pass
    print(f"{cid:8} {RES[cid][0]:9} {RES[cid][1][:140]}", flush=True)


def main():
    CAPTURAS.mkdir(parents=True, exist_ok=True)
    for x in CAPTURAS.glob("falla_*.png"): x.unlink()
    with sync_playwright() as pw:
        nav = pw.chromium.launch(channel="msedge")  # usa el Edge de Windows (sin descargar navegadores)
        opts = dict(locale="es-AR", timezone_id="America/Argentina/Buenos_Aires", viewport={"width": 1366, "height": 900})

        # -------- modo prueba: un navegador limpio por caso
        for cid, fn, modo in CASOS:
            if modo == "real": continue
            ctx = nav.new_context(**opts, color_scheme="dark" if modo == "oscuro" else "light")
            p = ctx.new_page()
            if modo not in ("lt", "res", "oscuro"): p.route(LT, lt_vacio)
            p.goto(HTML); expect(p.locator("#view-nuevo")).to_be_visible()
            correr_uno(cid, fn, F(p))
            ctx.close()
            if modo in ("lt", "res", "oscuro"): time.sleep(2)  # LanguageTool: ~20 pedidos por minuto

        # -------- modo real: una sola sesión, en orden
        reales = [(c, fn) for c, fn, m in CASOS if m == "real"]
        try:
            preparar_real()
        except Exception as e:
            for c, _ in reales: RES[c] = ("Bloqueado", f"No se pudo preparar el modo real: {e}")
            reales = []
        try:
            if reales:
                ctx = nav.new_context(**opts); p = ctx.new_page()
                p.goto(REAL); expect(p.locator("#view-login")).to_be_visible(timeout=20000)
                f = F(p)
                for cid, fn in reales:
                    rid = cid + ("·real" if cid in RES else "")
                    correr_uno(rid, fn, f)
                ctx.close()
        finally:
            quedan = limpiar_real()
            print("Limpieza de Supabase: quedan", quedan, flush=True)
        nav.close()


# ---------------------------------------------------------------- Excel de resultados
NO_APLICA_PRUEBA = {}
COLORES = {"Pasó": "C6EFCE", "Falló": "FFC7CE", "Bloqueado": "FFEB9C", "No aplica": "D9D9D9"}

def combinar(cid):
    """Junta el resultado en modo prueba y en modo real cuando el caso corrió en los dos."""
    a, b = RES.get(cid), RES.get(cid + "·real")
    if a and b:
        estado = "Falló" if "Falló" in (a[0], b[0]) else a[0]
        return estado, " | ".join(x for x in [f"Prueba: {a[0]}. {a[1]}".strip(), f"Real: {b[0]}. {b[1]}".strip()])
    return a or b


def escribir_excel(origen, destino):
    shutil.copy(origen, destino)
    wb = openpyxl.load_workbook(destino)
    ws = wb["Casos de Prueba"]
    # Gemini partió en columnas los títulos que tenían comas: se vuelven a juntar
    for fila_ in ws.iter_rows(min_row=2):
        vals = [c.value for c in fila_]
        if not vals[0]: continue
        extra = len([v for v in vals if v is not None]) - 11  # una fila normal ocupa A..K
        if extra > 0 and vals[10] not in ("Pendiente", None):
            titulo = ",".join(str(v) for v in vals[2:3 + extra])
            nuevos = vals[:2] + [titulo] + vals[3 + extra:]
            for i, c in enumerate(fila_): c.value = nuevos[i] if i < len(nuevos) else None
    for fila_ in ws.iter_rows(min_row=2):
        cid = fila_[0].value
        if not cid: continue
        r = combinar(cid)
        if not r: continue
        estado, obs = r
        fila_[10].value = estado; fila_[11].value = obs or None
        fila_[10].fill = PatternFill("solid", fgColor=COLORES[estado]); fila_[10].font = Font(bold=True)
        fila_[11].alignment = Alignment(wrap_text=True, vertical="top")
    ws.column_dimensions["L"].width = 70
    ultima = max(r for r in range(1, ws.max_row + 1) if ws.cell(r, 1).value)
    for cid, (mod, tit, esp) in NUEVOS.items():
        r = combinar(cid)
        if not r: continue
        ultima += 1
        modo = "Real" if cid in ("NUE-06", "NUE-10") else "Ambos"
        for col, v in enumerate([cid, mod, tit, "Cambio pedido por el equipo", "", "", esp, "Alta", "Positivo", modo], 1):
            ws.cell(ultima, col, v).alignment = Alignment(wrap_text=True, vertical="top")
        ws.cell(ultima, 11, r[0]).fill = PatternFill("solid", fgColor=COLORES[r[0]]); ws.cell(ultima, 11).font = Font(bold=True)
        ws.cell(ultima, 12, r[1] or None).alignment = Alignment(wrap_text=True, vertical="top")
    humo = wb["Set de Humo (10)"]
    for fila_ in humo.iter_rows(min_row=2):
        if not fila_[1].value: continue
        rel = [x.strip() for x in str(fila_[1].value).split("/")]
        est = [combinar(x)[0] for x in rel if combinar(x)]
        if est:
            e = "Falló" if "Falló" in est else ("Bloqueado" if "Bloqueado" in est else est[0])
            fila_[5].value = e; fila_[5].fill = PatternFill("solid", fgColor=COLORES[e]); fila_[5].font = Font(bold=True)
    wb.save(destino)


if __name__ == "__main__":
    origen = Path(sys.argv[1])
    solo = set(sys.argv[2].split(",")) if len(sys.argv) > 2 else None
    if solo: CASOS[:] = [c for c in CASOS if c[0] in solo]
    t0 = time.time()
    try:
        main()
    except Exception:
        traceback.print_exc()
    destino = RAIZ / "dist" / (origen.stem + " - resultados.xlsx")
    escribir_excel(origen, destino)
    (RAIZ / "dist" / "resultados.json").write_text(json.dumps(RES, ensure_ascii=False, indent=1), encoding="utf-8")
    tot = {}
    for v in RES.values(): tot[v[0]] = tot.get(v[0], 0) + 1
    print(f"\n{tot}  en {time.time() - t0:.0f} s  →  {destino}")
