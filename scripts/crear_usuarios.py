"""Crea las cuentas de los RENs en Supabase (mail + contraseña), sin mandar mails.

Uso (desde la carpeta del proyecto):
    py scripts/crear_usuarios.py privado/rens.xlsx            # crea las cuentas que falten
    py scripts/crear_usuarios.py --reset nombre@uade.edu.ar   # nueva contraseña para una cuenta

- El Excel tiene una columna "Mail" (y opcionalmente "Nombre" y "Contraseña").
- Contraseña de cada cuenta nueva, en este orden: la columna "Contraseña" del Excel; si no hay,
  CLAVE_INICIAL de privado/.env; si tampoco, una al azar. Queda anotada SOLO en privado/cuentas_<fecha>.xlsx.
- Sumar gente: agregá la fila al Excel y volvé a correrlo; las cuentas que ya existen no se tocan.
- privado/.env (no se sube a GitHub):
      SUPABASE_SECRET_KEY=sb_secret_...   (Supabase → Project Settings → API Keys → Secret keys)
      CLAVE_INICIAL=...                   (opcional)
"""
import json
import secrets
import string
import sys
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

import openpyxl

RAIZ = Path(__file__).resolve().parent.parent
URL = "https://kigfmductmgcccvcploe.supabase.co"


def leer_env():
    env = RAIZ / "privado" / ".env"
    out = {}
    if env.exists():
        for linea in env.read_text(encoding="utf-8-sig").splitlines():
            if "=" in linea and not linea.strip().startswith("#"):
                k, v = linea.split("=", 1)
                out[k.strip()] = v.strip()
    return out


ENV = leer_env()
KEY = ENV.get("SUPABASE_SECRET_KEY") or sys.exit("Falta SUPABASE_SECRET_KEY en privado/.env")
CLAVE_INICIAL = ENV.get("CLAVE_INICIAL", "")


def api(metodo, ruta, cuerpo=None):
    req = urllib.request.Request(
        URL + ruta, method=metodo, data=json.dumps(cuerpo).encode() if cuerpo is not None else None,
        headers={"apikey": KEY, "Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def nueva_clave():
    abc = string.ascii_letters + string.digits
    while True:
        c = "".join(secrets.choice(abc) for _ in range(12))
        if any(x.isdigit() for x in c) and any(x.isupper() for x in c) and any(x.islower() for x in c):
            return c


def usuarios_existentes():
    out, pagina = {}, 1
    while True:
        st, data = api("GET", f"/auth/v1/admin/users?page={pagina}&per_page=200")
        if st != 200:
            sys.exit(f"No pude listar usuarios ({st}): {data}")
        us = data.get("users", [])
        out.update({u["email"].lower(): u["id"] for u in us if u.get("email")})
        if len(us) < 200:
            return out
        pagina += 1


def guardar(filas):
    destino = RAIZ / "privado" / f"cuentas_{datetime.now():%Y%m%d_%H%M%S}.xlsx"
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(["Mail", "Nombre", "Contraseña", "Resultado"])
    for f in filas:
        ws.append(f)
    for col, ancho in zip("ABCD", (34, 24, 16, 40)):
        ws.column_dimensions[col].width = ancho
    wb.save(destino)
    print(f"\nGuardado en {destino}  (no compartir: tiene contraseñas)")


def crear(excel):
    wb = openpyxl.load_workbook(excel, read_only=True)
    filas = list(wb.active.iter_rows(values_only=True))
    cab = [str(c or "").strip().lower() for c in filas[0]]
    if "mail" not in cab:
        sys.exit('El Excel tiene que tener una columna "Mail".')
    i_mail, i_nom = cab.index("mail"), (cab.index("nombre") if "nombre" in cab else None)
    i_clave = cab.index("contraseña") if "contraseña" in cab else None
    existentes = usuarios_existentes()
    salida = []
    for f in filas[1:]:
        mail = str(f[i_mail] or "").strip().lower()
        nombre = str(f[i_nom] or "").strip() if i_nom is not None else ""
        if not mail:
            continue
        if not mail.endswith("@uade.edu.ar"):
            salida.append([mail, nombre, "", "NO creado: no es @uade.edu.ar"])
            continue
        if mail in existentes:
            salida.append([mail, nombre, "", "Ya existía (no se cambió la contraseña)"])
            continue
        clave = (str(f[i_clave] or "").strip() if i_clave is not None else "") or CLAVE_INICIAL or nueva_clave()
        st, data = api("POST", "/auth/v1/admin/users",
                       {"email": mail, "password": clave, "email_confirm": True, "user_metadata": {"nombre": nombre}})
        ok = st in (200, 201)
        salida.append([mail, nombre, clave if ok else "", "Creado" if ok else f"Error {st}: {data.get('msg') or data}"])
        print(("OK   " if ok else "ERR  ") + mail)
    guardar(salida)


def resetear(mail):
    uid = usuarios_existentes().get(mail.lower())
    if not uid:
        sys.exit(f"No existe la cuenta {mail}")
    clave = nueva_clave()
    st, data = api("PUT", f"/auth/v1/admin/users/{uid}", {"password": clave})
    if st != 200:
        sys.exit(f"Error {st}: {data}")
    guardar([[mail, "", clave, "Contraseña nueva"]])


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--reset":
        resetear(sys.argv[2])
    elif len(sys.argv) == 2:
        crear(sys.argv[1])
    else:
        sys.exit(__doc__)
