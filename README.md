# Alta de eventos · UADE

Formulario web para que los RENs carguen eventos (Reuniones Informativas de grado y posgrado, y otros eventos).
Reemplaza la carga manual en Intranet + Excel. Al confirmar, cada evento queda en cola y un proceso
automático lo da de alta en Intranet; después la carrera se asigna sola en Umbraco cruzando por el número
de actividad.

## Estructura

| Archivo | Qué es |
|---|---|
| `index.html`, `styles.css`, `app.js` | Formulario (estático, sin build) |
| `config.js` | Opciones, valores propuestos por tipo de evento, copys y configuración de Supabase |
| `store.js` | Capa de datos (hoy modo prueba en el navegador; Supabase en la próxima etapa) |
| `data/carreras.json` | Catálogo de carreras de Umbraco agrupado por variante (Presencial / Online / Costa) |
| `scripts/generar_catalogo.py` | Regenera `data/carreras.json` desde `carreras_umbraco.xlsx` |

## Probar local

```bash
py -m http.server 8939
```

Sin `SUPABASE.url` en `config.js` funciona en **modo prueba**: guarda en el navegador y no envía nada.
