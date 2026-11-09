import nodemailer from "nodemailer";

let transporter;

export const isMailConfigured = () => Boolean(process.env.SMTP_HOST?.trim());

function getTransporter() {
  if (!transporter) {
    const port = Number(process.env.SMTP_PORT) || 587;
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST.trim(),
      port,
      secure: process.env.SMTP_SECURE === "true" || port === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
    });
  }
  return transporter;
}

/** Detecta variables mal escritas en el .env, p. ej. SMPT_HOST en vez de SMTP_HOST. */
function misspelledVariables() {
  return Object.keys(process.env).filter((key) => key.startsWith("SMPT_"));
}

/** Traduce los errores típicos de SMTP a una pista que se pueda accionar. */
export function explainMailError(error) {
  const host = process.env.SMTP_HOST || "";
  const port = process.env.SMTP_PORT || 587;

  if (error.code === "EAUTH" || [534, 535].includes(error.responseCode)) {
    return host.includes("gmail")
      ? "Gmail rechazó el usuario o la clave. Necesitas una «contraseña de aplicación» (Cuenta de Google → Seguridad → Verificación en 2 pasos → Contraseñas de aplicaciones); la contraseña normal de la cuenta no funciona."
      : "El servidor SMTP rechazó el usuario o la clave: revisa SMTP_USER y SMTP_PASS.";
  }

  if (["ECONNECTION", "ETIMEDOUT", "ESOCKET", "ECONNREFUSED", "ENOTFOUND", "EDNS"].includes(error.code)) {
    return `No se pudo conectar a ${host}:${port}. Revisa SMTP_HOST y SMTP_PORT, tu conexión a internet o el firewall.`;
  }

  if (error.code === "EENVELOPE") return "La dirección de origen o de destino no es válida (revisa MAIL_FROM y el correo del usuario).";
  return null;
}

export function logMailError(context, error) {
  const hint = explainMailError(error);
  console.error(`[mail] ${context}: ${error.message}${hint ? `\n[mail] → ${hint}` : ""}`);
}

/** Al arrancar el servidor: avisa si el correo está configurado y si las credenciales funcionan. */
export async function verifyMail() {
  if (!isMailConfigured()) {
    const typos = misspelledVariables();
    console.log(
      typos.length
        ? `[mail] ⚠ SMTP sin configurar: en el .env hay ${typos.join(", ")}; el nombre correcto es ${typos.map((key) => key.replace("SMPT_", "SMTP_")).join(", ")} (SMTP, no SMPT).`
        : "[mail] SMTP sin configurar (falta SMTP_HOST): los correos se imprimirán en esta consola."
    );
    return;
  }

  try {
    await getTransporter().verify();
    console.log(`[mail] SMTP listo: ${process.env.SMTP_HOST}:${process.env.SMTP_PORT || 587}${process.env.SMTP_USER ? ` como ${process.env.SMTP_USER}` : ""}`);
  } catch (error) {
    logMailError("No se pudo conectar al SMTP", error);
  }
}

/**
 * Envía un correo por SMTP.
 * Sin SMTP_HOST (modo desarrollo) no se envía nada: el contenido se imprime en la consola del servidor.
 */
export async function sendMail({ to, subject, text, html }) {
  if (!isMailConfigured()) {
    console.log(`\n[mail] SMTP no configurado (falta SMTP_HOST): el correo NO se envió. Contenido para ${to}\nAsunto: ${subject}\n${text}\n`);
    const typos = misspelledVariables();
    console.warn(
      typos.length
        ? `[mail] ⚠ En el .env hay ${typos.join(", ")}: el nombre correcto es ${typos.map((key) => key.replace("SMPT_", "SMTP_")).join(", ")} (SMTP, no SMPT). Corrígelo y reinicia el servidor.`
        : "[mail] Si ya lo configuraste, revisa que la variable se llame SMTP_HOST en server/.env y reinicia el servidor."
    );
    return { sent: false };
  }

  const from = process.env.MAIL_FROM?.trim() || process.env.SMTP_USER || "no-reply@localhost";
  await getTransporter().sendMail({ from, to, subject, text, html });
  return { sent: true };
}
