"""Arma un único HTML del formulario que abre con doble clic (sin servidor), en modo prueba.

Mete adentro el CSS, los tres módulos JS y el catálogo de carreras. Los eventos se guardan
solo en el navegador: no toca Supabase ni Intranet.

Uso:  python scripts/armar_html.py   →  dist/Alta de eventos (prueba).html
"""
import json
import re
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
SALIDA = RAIZ / "dist" / "Alta de eventos (prueba).html"


def leer(nombre):
    return (RAIZ / nombre).read_text(encoding="utf-8")


def sin_imports(js):
    return re.sub(r"^import\s[\s\S]*?;[ \t]*\n", "", js, flags=re.M)


def sin_exports(js):
    return re.sub(r"^export\s+", "", js, flags=re.M)


def nombres_exportados(js):
    return re.findall(r"^export\s+(?:const|let|function|async function|class)\s+(\w+)", js, flags=re.M)


config, store, app = leer("config.js"), leer("store.js"), leer("app.js")
cfg_nombres = nombres_exportados(config)
store_nombres = nombres_exportados(store)

fetch_catalogo = re.compile(
    r'const r = await fetch\("data/carreras\.json"\);\s*CARRERAS = \(await r\.json\(\)\)\.carreras;')
assert fetch_catalogo.search(app), "No encontré la carga del catálogo en app.js"
app = fetch_catalogo.sub("CARRERAS = window.__CATALOGO__.carreras;", sin_imports(app))

catalogo = json.dumps(json.loads(leer("data/carreras.json")), ensure_ascii=False, separators=(",", ":"))

modulo = f"""
const __cfg = (() => {{
{sin_exports(config)}
return {{ {", ".join(cfg_nombres)} }};
}})();
__cfg.SUPABASE.url = "";  // siempre modo prueba
const {{ {", ".join(cfg_nombres)} }} = __cfg;

const {{ store, tanda: tandaStore, uid, modoPrueba }} = (() => {{
{sin_exports(sin_imports(store))}
return {{ {", ".join(store_nombres)} }};
}})();

{app}
"""

html = leer("index.html")
css_tag = '<link rel="stylesheet" href="styles.css">'
js_tag = '<script type="module" src="app.js"></script>'
assert css_tag in html and js_tag in html
html = html.replace(css_tag, "<style>\n" + leer("styles.css") + "\n</style>")
html = html.replace(js_tag,
                    "<script>window.__CATALOGO__ = " + catalogo.replace("</", "<\\/") + ";</script>\n"
                    + '  <script type="module">' + modulo.replace("</script", "<\\/script") + "</script>")

SALIDA.parent.mkdir(exist_ok=True)
SALIDA.write_text(html, encoding="utf-8")
print(f"Listo: {SALIDA} ({SALIDA.stat().st_size // 1024} KB)")
