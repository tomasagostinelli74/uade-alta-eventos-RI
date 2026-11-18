// Configuración del formulario. Lo que cambie el negocio se toca acá, no en app.js.
export const SUPABASE = {
  // Vacío = modo prueba (se guarda en este navegador). Agregá ?prueba a la URL para forzarlo.
  url: new URLSearchParams(location.search).has("prueba") ? "" : "https://kigfmductmgcccvcploe.supabase.co",
  anonKey: "sb_publishable_Q9VItQ8FcsbWwMrmd_u5Ug_XM3dvWIM", // clave publicable: va en el navegador a propósito. Nunca la secreta.
};

export const SEDES = [
  { code: "M", label: "Monserrat" },
  { code: "R", label: "Recoleta" },
  { code: "B", label: "Belgrano" },
  { code: "C", label: "Costa" },
  { code: "O", label: "Online" },
];

export const TIPOS = [
  { code: "ri_grado", label: "RI de grado", hint: "Reunión Informativa de carreras de grado" },
  { code: "ri_posgrado", label: "RI de posgrado", hint: "MBA, especializaciones, maestrías" },
  { code: "ovo", label: "Taller OVO", hint: "Orientación vocacional (sin inscripción)" },
  { code: "otro", label: "Evento", hint: "Charlas, talleres, experiencias" },
];

// Qué puede cargar cada cuenta (la parte del mail antes de @). Las facultades no están: usan CUENTA_DEFECTO.
// nivel: grado | posgrado | todos · variante: versión de la carrera que se propone primero.
export const CUENTAS = {
  ubs: { nivel: "posgrado", variante: "normal", nombre: "UBS (posgrado)" },
  online: { nivel: "grado", variante: "online", nombre: "Online" },
  costa: { nivel: "grado", variante: "costa", nombre: "Costa" },
  "prueba.formulario": { nivel: "todos", variante: "normal", nombre: "Prueba (todo)" },
};
export const CUENTA_DEFECTO = { nivel: "grado", variante: "normal", nombre: "Facultad (grado)" };
export const TIPOS_POR_NIVEL = {
  grado: ["ri_grado", "ovo", "otro"],
  posgrado: ["ri_posgrado", "otro"],
  todos: ["ri_grado", "ri_posgrado", "ovo", "otro"],
};
export const perfilDe = (email) => CUENTAS[String(email || "").split("@")[0].toLowerCase()] || CUENTA_DEFECTO;

// Opciones de Intranet (código = valor que espera GRABA_ACTIV.ASP)
// Categoría de Intranet: el equipo pidió "Charlas" para todos los eventos (fija, no se elige).
export const CATEG = [
  { code: 8, label: "Charlas" },
];
export const PERFIL = [
  { code: 3, label: "Alumnos" },
  { code: 100, label: "Web" },
];
export const SECTORES = [
  { code: 1421, label: "Fac. de Arquitectura y Urbanismo" },
  { code: 176, label: "Fac. de Ciencias Económicas" },
  { code: 182, label: "Fac. de Ciencias Jurídicas y de la Comunicación" },
  { code: 322, label: "Fac. de Ciencias de la Salud" },
  { code: 293, label: "Fac. de Diseño" },
  { code: 200, label: "Fac. de Entretenimiento, Hospitalidad y Medios" },
  { code: 191, label: "Fac. de Ingeniería y Ciencias Exactas" },
  { code: 174, label: "UADE Business School" },
  { code: 257, label: "UADE Costa Argentina" },
  { code: 159, label: "Admisiones" },
];
export const ORIGEN_CRM = [
  { code: "R", label: "RI" },
  { code: "A", label: "Actividades Agenda" },
  { code: "O", label: "OVO" },
];
export const CATEG_CRM = [
  { code: 8, label: "Charlas" },
  { code: 12, label: "Reuni. Infor." },
  { code: 38, label: "Taller Orientación Vocacional" },
];

// Valores propuestos por tipo de evento (el REN puede cambiar audiencia, sector y los de CRM en el paso 3)
export function defaultsPara(tipo) {
  const base = { categ: [8], perfil: [3, 100] };
  if (tipo === "ovo") return { ...base, origen_crm: "O", categ_crm: 38 };
  if (tipo === "otro") return { ...base, origen_crm: "A", categ_crm: 8 };
  return { ...base, origen_crm: "R", categ_crm: 12 };
}
// Inscripción: los Talleres OVO no llevan; todo lo demás, siempre.
export const requiereInscripcion = (tipo) => tipo !== "ovo";
// Sector cuando no hay carrera de donde sacarlo
export const SECTOR_SIN_CARRERA = { ovo: 159, posgrado: 174 };

// Copy general. [[...]] = dato que el REN tiene que completar antes de confirmar.
const LUGAR = {
  M: "Te esperamos en nuestro Campus Buenos Aires (Lima 757, CABA).",
  R: "Te esperamos en nuestra sede Recoleta ([[dirección]]).",
  B: "Te esperamos en nuestra sede Belgrano ([[dirección]]).",
  C: "Te esperamos en nuestro Campus Costa Argentina ([[dirección]]).",
};
// Sector de Intranet → mail de contacto de la facultad
const MAIL_FACULTAD = {
  176: "face@uade.edu.ar",      // Ciencias Económicas
  182: "faju@uade.edu.ar",      // Ciencias Jurídicas y de la Comunicación
  322: "fasa@uade.edu.ar",      // Ciencias de la Salud
  200: "faen@uade.edu.ar",      // Entretenimiento, Hospitalidad y Medios
  191: "fain@uade.edu.ar",      // Ingeniería y Ciencias Exactas
  293: "farufadi@uade.edu.ar",  // Diseño
  1421: "farufadi@uade.edu.ar", // Arquitectura y Urbanismo
};

export function copyGeneral(tipo, sede, sector) {
  const mail = MAIL_FACULTAD[sector] || "[[mail de contacto]]";
  const online = sede === "O";
  if (tipo === "otro" || tipo === "ovo") return "";
  if (tipo === "ri_posgrado") {
    return [
      `UADE Business School te invita a una Reunión Informativa ${online ? "Online" : "Presencial"}. Conocé nuestra propuesta, modalidad de cursada y plan de estudios.`,
      online ? null : LUGAR[sede],
      "Actividad libre y gratuita con inscripción previa.",
    ].filter(Boolean).join("\n\n");
  }
  return [
    online
      ? "Te invitamos a participar de una Reunión Informativa Online, en la que brindaremos información sobre los planes de estudio, alcances profesionales y salida laboral."
      : "Te invitamos a participar de una Reunión Informativa presencial en la que brindaremos información sobre los planes de estudio, alcances profesionales y salida laboral.",
    online ? null : LUGAR[sede],
    "Actividad libre y gratuita con inscripción previa.",
    `Más información en ${mail}`,
  ].filter(Boolean).join("\n\n");
}
