import { getAppName } from "../utils/appUrl.js";

const escapeHtml = (value = "") =>
  String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

/** Marco común: tarjeta oscura, botón naranja y pie con el nombre de la app. */
function layout({ preheader, title, bodyHtml, buttonLabel, buttonUrl, footerHtml }) {
  const app = escapeHtml(getAppName());

  return `<!doctype html>
<html lang="es">
  <body style="margin:0;padding:0;background:#0b0c10;font-family:Inter,Segoe UI,Arial,sans-serif;">
    <span style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</span>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#0b0c10;padding:32px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;background:#14161e;border:1px solid #262833;border-radius:16px;">
            <tr>
              <td style="padding:28px 32px 8px;">
                <span style="display:inline-block;background:#ff5a1f;color:#160c08;font-weight:800;letter-spacing:.04em;text-transform:uppercase;font-size:13px;padding:6px 12px;border-radius:8px 3px 8px 3px;">${app}</span>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 32px 0;color:#f6f4ef;">
                <h1 style="margin:12px 0 12px;font-size:24px;line-height:1.2;color:#ffffff;">${escapeHtml(title)}</h1>
                <div style="font-size:15px;line-height:1.6;color:#c9ccd6;">${bodyHtml}</div>
              </td>
            </tr>
            ${
              buttonUrl
                ? `<tr>
              <td style="padding:24px 32px 8px;">
                <a href="${escapeHtml(buttonUrl)}" style="display:inline-block;background:linear-gradient(135deg,#ff5a1f,#ffb938);background-color:#ff7a1f;color:#160c08;font-weight:800;font-size:15px;text-decoration:none;padding:14px 26px;border-radius:12px;">${escapeHtml(buttonLabel)}</a>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 32px 0;font-size:12px;line-height:1.5;color:#8b90a0;">
                Si el botón no funciona, copia y pega este enlace en tu navegador:<br />
                <a href="${escapeHtml(buttonUrl)}" style="color:#4cdcff;word-break:break-all;">${escapeHtml(buttonUrl)}</a>
              </td>
            </tr>`
                : ""
            }
            <tr>
              <td style="padding:24px 32px 28px;font-size:12px;line-height:1.5;color:#8b90a0;">${footerHtml}</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function passwordResetEmail({ name, resetUrl, minutes }) {
  const app = getAppName();
  const subject = `Restablece tu contraseña de ${app}`;

  const text = [
    `Hola ${name},`,
    "",
    `Recibimos una solicitud para restablecer la contraseña de tu cuenta en ${app}.`,
    "Abre este enlace para crear una contraseña nueva:",
    resetUrl,
    "",
    `El enlace vence en ${minutes} minutos y solo se puede usar una vez.`,
    "Si no fuiste tú, ignora este correo: tu contraseña seguirá igual."
  ].join("\n");

  const html = layout({
    preheader: `Crea una contraseña nueva. El enlace vence en ${minutes} minutos.`,
    title: "Restablece tu contraseña",
    bodyHtml: `<p style="margin:0 0 12px;">Hola ${escapeHtml(name)},</p>
      <p style="margin:0 0 12px;">Recibimos una solicitud para restablecer la contraseña de tu cuenta. El enlace vence en <strong style="color:#fff;">${minutes} minutos</strong> y solo se puede usar una vez.</p>`,
    buttonLabel: "Crear contraseña nueva",
    buttonUrl: resetUrl,
    footerHtml: "Si no fuiste tú, ignora este correo: tu contraseña seguirá igual."
  });

  return { subject, text, html };
}

export function passwordChangedEmail({ name }) {
  const app = getAppName();
  const subject = `Tu contraseña de ${app} fue cambiada`;

  const text = [
    `Hola ${name},`,
    "",
    `La contraseña de tu cuenta en ${app} se cambió hace un momento y cerramos tus sesiones abiertas.`,
    "Si no fuiste tú, solicita un restablecimiento de contraseña de inmediato."
  ].join("\n");

  const html = layout({
    preheader: "La contraseña de tu cuenta se cambió.",
    title: "Contraseña actualizada",
    bodyHtml: `<p style="margin:0 0 12px;">Hola ${escapeHtml(name)},</p>
      <p style="margin:0;">La contraseña de tu cuenta se cambió hace un momento y cerramos tus sesiones abiertas.</p>`,
    footerHtml: "Si no fuiste tú, solicita un restablecimiento de contraseña de inmediato."
  });

  return { subject, text, html };
}
