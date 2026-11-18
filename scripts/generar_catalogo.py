"""Genera data/carreras.json para el formulario a partir del catálogo de Umbraco.

Uso:  py scripts/generar_catalogo.py [ruta a carreras_umbraco.xlsx]

Agrupa las variantes de cada carrera (normal / ONLINE / COSTA) en una sola entrada, para que el REN
elija la carrera y el formulario resuelva la variante según la sede. Los ciclos son carreras aparte.
Descarta copias despublicadas (URL "#") y duplicados "NOMBRE (1)".
"""
import json
import re
import sys
import unicodedata
from pathlib import Path

import openpyxl

RAIZ = Path(__file__).resolve().parent.parent
ORIGEN = Path(sys.argv[1]) if len(sys.argv) > 1 else RAIZ.parent / "Reuniones Informativas Umbraco" / "carreras_umbraco.xlsx"

# Facultad de Umbraco -> Sector organizador de Intranet
SECTOR = {
    "ESCUELA DE DIRECCIÓN DE EMPRESAS": 174,
    "FACULTAD DE ARQUITECTURA Y URBANISMO": 1421,
    "FACULTAD DE CIENCIAS DE LA SALUD": 322,
    "FACULTAD DE CIENCIAS ECONÓMICAS": 176,
    "FACULTAD DE CIENCIAS JURÍDICAS Y DE LA COMUNICACIÓN": 182,
    "FACULTAD DE DISEÑO": 293,
    "FACULTAD DE ENTRETENIMIENTO, HOSPITALIDAD Y MEDIOS": 200,
    "FACULTAD DE INGENIERÍA Y CIENCIAS EXACTAS": 191,
}

POSGRADO = re.compile(r"^(ESPECIALIZACI[ÓO]N|MAESTR[ÍI]A|PROGRAMA CORTO|DIPLOMATURA)", re.I)

VAR_ONLINE = re.compile(r"\s*\((?:ONLINE)\)\s*$", re.I)
VAR_COSTA = re.compile(r"\s*\((?:COSTA ARGENTINA|COSTA ARG\.?)\)\s*$", re.I)
VAR_PRES_ONLINE = re.compile(r"\s*\(PRESENCIAL Y ONLINE\)\s*$", re.I)
COPIA = re.compile(r"\s*\(\d+\)\s*$")

ABREV = [
    (r"^LICENCIATURA EN ", "Lic. en "),
    (r"^INGENIER[ÍI]A EN ", "Ing. en "),
    (r"^INGENIER[ÍI]A ", "Ing. "),
    (r"^TECNICATURA UNIVERSITARIA EN ", "Tec. Univ. en "),
    (r"^TECNICATURA EN ", "Tec. en "),
    (r"^DOBLE TITULACI[ÓO]N EN ", "Doble Tit. en "),
]
MINUS = {"de", "del", "la", "las", "los", "el", "y", "e", "en", "para", "con", "a", "o", "of", "in", "and", "the"}
SIGLAS = {"SAP", "XR", "TI", "IA", "MBA"}


def sin_tildes(s):
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")


def titulo(s):
    """'LICENCIATURA EN DISEÑO GRÁFICO' -> 'Lic. en Diseño Gráfico'."""
    for pat, rep in ABREV:
        if re.match(pat, s, re.I):
            s = re.sub(pat, rep, s, flags=re.I)
            break
    out = []
    for i, w in enumerate(s.split(" ")):
        core = w.strip("(),.-")
        if core.upper() in SIGLAS:
            out.append(w.upper())
        elif w in ("Lic.", "Ing.", "Tec.", "Univ.", "Doble", "Tit.") or w[:1].islower():
            out.append(w)
        elif i > 0 and core.lower() in MINUS:
            out.append(w.lower())
        else:
            out.append(re.sub(r"[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+",
                              lambda m: m.group(0)[:1].upper() + m.group(0)[1:].lower(), w))
    return " ".join(out).replace(" Y ", " y ").replace("Next-gen", "Next-Gen")


def main():
    filas = list(openpyxl.load_workbook(ORIGEN, read_only=True).active.iter_rows(values_only=True))[1:]
    grupos = {}
    for nombre, _var, facultad, url, nid, udi in filas:
        if not url or url == "#" or COPIA.search(nombre):
            continue
        base, variante = nombre.strip(), "normal"
        if VAR_PRES_ONLINE.search(base):
            base = VAR_PRES_ONLINE.sub("", base)
        elif VAR_ONLINE.search(base):
            base, variante = VAR_ONLINE.sub("", base), "online"
        elif VAR_COSTA.search(base):
            base, variante = VAR_COSTA.sub("", base), "costa"
        clave = sin_tildes(base.upper())
        g = grupos.setdefault(clave, {
            "base": base, "corto": titulo(base), "facultad": facultad,
            "sector": SECTOR.get(facultad), "nivel": "posgrado" if facultad.startswith("ESCUELA") else "grado",
            "variantes": {},
        })
        if variante in g["variantes"]:
            print(f"  aviso: variante repetida {variante} en {base!r}: {nombre!r}", file=sys.stderr)
            continue
        g["variantes"][variante] = {"id": nid, "udi": udi, "nombre": nombre, "url": url}

    carreras = sorted(grupos.values(), key=lambda g: (g["nivel"], sin_tildes(g["corto"]).lower()))
    for i, g in enumerate(carreras, 1):
        g["key"] = f"c{i}"
    destino = RAIZ / "data" / "carreras.json"
    destino.parent.mkdir(exist_ok=True)
    destino.write_text(json.dumps({"origen": ORIGEN.name, "carreras": carreras}, ensure_ascii=False, indent=1),
                       encoding="utf-8")
    sin_sector = [g["base"] for g in carreras if not g["sector"]]
    print(f"{len(carreras)} carreras ({sum(len(g['variantes']) for g in carreras)} nodos) -> {destino}")
    if sin_sector:
        print("Sin sector:", sin_sector)


if __name__ == "__main__":
    main()
