"""Arma HTML únicos que abren con doble clic (sin servidor), en modo prueba:

  dist/Alta de eventos (prueba).html    el formulario de los RENs
  dist/Panel de control (prueba).html   el panel de los revisores

Cada uno mete adentro el CSS, los módulos JS y el catálogo de carreras. Los eventos se guardan solo en el
navegador: no tocan Supabase ni Intranet. Abiertos desde la misma carpeta comparten lo guardado, así que lo que
se envía a revisión en el formulario aparece en el panel.

Uso:  py -X utf8 scripts/armar_html.py
"""
import json
import re
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
PAGINAS = [  # (html, módulo principal, salida)
    ("index.html", "app.js", "Alta de eventos (prueba).html"),
    ("panel.html", "panel.js", "Panel de control (prueba).html"),
]
FETCH_CATALOGO = re.compile(
    r'const r = await fetch\("data/carreras\.json"\);\s*CARRERAS = \(await r\.json\(\)\)\.carreras;')


def leer(nombre):
    return (RAIZ / nombre).read_text(encoding="utf-8")


def sin_imports(js):
    return re.sub(r"^import\s[\s\S]*?;[ \t]*\n", "", js, flags=re.M)


def sin_exports(js):
    return re.sub(r"^export\s+", "", js, flags=re.M)


def nombres_exportados(js):
    return re.findall(r"^export\s+(?:const|let|function|async function|class)\s+([\w$]+)", js, flags=re.M)


def envolver(nombre_js, extra=""):
    """El módulo dentro de una función que devuelve sus exports, y los exports sueltos en el scope."""
    js = leer(nombre_js)
    nombres = nombres_exportados(js)
    return f"""
const {{ {", ".join(nombres)} }} = (() => {{
{sin_exports(sin_imports(js))}
return {{ {", ".join(nombres)} }};
}})();
{extra}"""


def modulo(principal):
    js = leer(principal)
    assert FETCH_CATALOGO.search(js), f"No encontré la carga del catálogo en {principal}"
    js = FETCH_CATALOGO.sub("CARRERAS = window.__CATALOGO__.carreras;", sin_imports(js))
    config = leer("config.js")
    cfg = nombres_exportados(config)
    return (f"""
const {{ {", ".join(cfg)} }} = (() => {{
{sin_exports(config)}
return {{ {", ".join(cfg)} }};
}})();
SUPABASE.url = "";  // siempre modo prueba
"""
            + envolver("store.js").replace("const { ", "const { tanda: tandaStore, ", 1).replace(", tanda,", ",", 1)
            + envolver("comun.js")
            + js)


catalogo = json.dumps(json.loads(leer("data/carreras.json")), ensure_ascii=False, separators=(",", ":"))
for html_nombre, principal, salida_nombre in PAGINAS:
    html = leer(html_nombre)
    css_tag = '<link rel="stylesheet" href="styles.css">'
    js_tag = f'<script type="module" src="{principal}"></script>'
    assert css_tag in html and js_tag in html, html_nombre
    html = html.replace(css_tag, "<style>\n" + leer("styles.css") + "\n</style>")
    html = html.replace(js_tag,
                        "<script>window.__CATALOGO__ = " + catalogo.replace("</", "<\\/") + ";</script>\n"
                        + '  <script type="module">' + modulo(principal).replace("</script", "<\\/script") + "</script>")
    # los links entre páginas apuntan a las versiones de prueba
    html = html.replace('href="panel.html"', 'href="Panel de control (prueba).html"')
    html = html.replace('href="index.html"', 'href="Alta de eventos (prueba).html"')
    salida = RAIZ / "dist" / salida_nombre
    salida.parent.mkdir(exist_ok=True)
    salida.write_text(html, encoding="utf-8")
    print(f"Listo: {salida} ({salida.stat().st_size // 1024} KB)")
