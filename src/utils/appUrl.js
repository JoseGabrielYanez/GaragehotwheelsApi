/**
 * URL pública del frontend, usada para armar los enlaces de los correos.
 * APP_URL tiene prioridad; si no existe se usa la primera URL de CLIENT_URL.
 */
export function getAppUrl() {
  const explicit = process.env.APP_URL?.trim();
  const first = (process.env.CLIENT_URL || "http://localhost:5173").split(",")[0].trim();
  return (explicit || first).replace(/\/+$/, "");
}

export const getAppName = () => process.env.APP_NAME?.trim() || "Collection Garage";
