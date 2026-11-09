import crypto from "node:crypto";

/** Token de un solo uso: el valor en claro viaja por correo y en la base solo se guarda su hash. */
export function createResetToken() {
  const token = crypto.randomBytes(32).toString("hex"); // 64 caracteres hex (256 bits)
  return { token, hash: hashToken(token) };
}

export const hashToken = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");

export const isValidTokenFormat = (token) => /^[a-f0-9]{64}$/.test(String(token || ""));
