# Alta de eventos · UADE

Formulario web para que los RENs carguen eventos (Reuniones Informativas de grado y posgrado, Talleres OVO y otros
eventos). Reemplaza la carga manual en Intranet + Excel.

Publicado en https://uade-alta-eventos.vercel.app (se actualiza solo con cada push a `main`). El panel está en
`/panel.html`. Cada REN entra con su mail si tiene una fila activa en la tabla `cuentas` de Supabase.

1. El REN carga los eventos y los **envía a revisión**.
2. En el **panel de control** (`panel.html`) un revisor de Marketing ve cómo va a quedar cada evento en Intranet y
   en la web (carrera, School y Site de Umbraco), lo corrige o lo devuelve al REN con un comentario.
3. Con un solo OK, un proceso automático lo da de alta en Intranet, sincroniza Umbraco y le asigna la carrera
   cruzando por el número de actividad.

## Estructura

| Archivo | Qué es |
|---|---|
| `index.html`, `app.js` | Formulario de los RENs (estático, sin build) |
| `panel.html`, `panel.js` | Panel de control de los revisores |
| `comun.js` | Lo compartido: utilidades, ortografía, estados y la simulación de Intranet y Umbraco |
| `styles.css` | Estilos de las dos páginas |
| `config.js` | Opciones, valores propuestos por tipo de evento, copys y configuración de Supabase |
| `store.js` | Capa de datos: modo prueba en el navegador o Supabase |
| `sql/` | Esquema, permisos y estados de Supabase (correr en orden en el SQL Editor) |
| `data/carreras.json` | Catálogo de carreras de Umbraco agrupado por variante (Presencial / Online / Costa) |
| `scripts/generar_catalogo.py` | Regenera `data/carreras.json` desde `carreras_umbraco.xlsx` |
| `scripts/armar_html.py` | Arma los HTML de prueba que abren con doble clic (formulario y panel) |
| `pruebas/correr_pruebas.py` | Batería de pruebas automáticas (Playwright) |

## Probar local

```bash
py -m http.server 8939
```

Agregá `?prueba` a la URL (o dejá vacío `SUPABASE.url` en `config.js`) para el **modo prueba**: guarda en el
navegador y no envía nada. Lo que se envía a revisión en el formulario aparece en el panel del mismo navegador.
