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
  { code: "otro", label: "Otro evento", hint: "Charlas, talleres, experiencias" },
];

// Opciones de Intranet (código = valor que espera GRABA_ACTIV.ASP)
export const CATEG = [
  { code: 12, label: "Reuni. Infor." },
  { code: 53, label: "Reunión Info. Online" },
  { code: 39, label: "Charla" },
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
  { code: 12, label: "Reuni. Infor." },
  { code: 8, label: "Charlas" },
  { code: 13, label: "Talleres" },
  { code: 56, label: "Taller OVO Colegios" },
  { code: 57, label: "Taller OVO EXPO UADE" },
  { code: 38, label: "Taller Orientación Vocacional" },
  { code: 59, label: "EXPO UADE" },
];

// Valores propuestos por tipo de evento (el REN los puede cambiar en "Más opciones")
export function defaultsPara(tipo, sede) {
  const online = sede === "O";
  if (tipo === "otro") return { categ: [39], perfil: [3, 100], origen_crm: "A", categ_crm: 8 };
  return { categ: [online ? 53 : 12], perfil: [3, 100], origen_crm: "R", categ_crm: 12 };
}

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
  if (tipo === "otro") return "";
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
