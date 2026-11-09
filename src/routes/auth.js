import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import { User } from "../models/User.js";
import { requireAuth } from "../middleware/auth.js";
import { logMailError, sendMail } from "../services/mailer.js";
import { passwordChangedEmail, passwordResetEmail } from "../services/emailTemplates.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { getAppUrl } from "../utils/appUrl.js";
import { createResetToken, hashToken, isValidTokenFormat } from "../utils/tokens.js";

const router = Router();
const cookieOptions = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  maxAge: 1000 * 60 * 60 * 24 * 7
};
// Para borrar la cookie no se envía maxAge (Express 5 lo ignora y Express 4 ya lo desaconseja)
const { maxAge: _maxAge, ...clearCookieOptions } = cookieOptions;

function signToken(userId) {
  return jwt.sign({ sub: userId }, process.env.JWT_SECRET, { expiresIn: "7d" });
}

function publicUser(user) {
  return {
    id: user._id,
    name: user.name,
    email: user.email
  };
}

router.post("/register", async (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password || password.length < 6) {
    return res.status(400).json({ message: "Completa nombre, email y password de al menos 6 caracteres" });
  }

  const exists = await User.findOne({ email: email.toLowerCase() });
  if (exists) {
    return res.status(409).json({ message: "Ese email ya esta registrado" });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await User.create({ name, email, passwordHash });
  res.cookie("token", signToken(user._id), cookieOptions);
  res.status(201).json({ user: publicUser(user) });
});

router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ email: email?.toLowerCase() });

  if (!user || !(await bcrypt.compare(password || "", user.passwordHash))) {
    return res.status(401).json({ message: "Credenciales invalidas" });
  }

  res.cookie("token", signToken(user._id), cookieOptions);
  res.json({ user: publicUser(user) });
});

router.post("/logout", (_req, res) => {
  res.clearCookie("token", clearCookieOptions);
  res.json({ ok: true });
});

router.get("/me", requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

/* ───────── Recuperación de contraseña ───────── */

const RESET_TTL_MINUTES = Number(process.env.PASSWORD_RESET_TTL_MINUTES) || 30;
const RESEND_COOLDOWN_MS = 60 * 1000; // no se reenvía otro correo a la misma cuenta antes de 1 minuto
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVALID_LINK = { code: "INVALID_TOKEN", message: "El enlace no es válido o ya expiró. Solicita uno nuevo." };

const tooMany = { message: "Demasiados intentos. Espera unos minutos e inténtalo de nuevo." };
const forgotLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 6, standardHeaders: true, legacyHeaders: false, message: tooMany });
const resetLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false, message: tooMany });

const RESET_FIELDS = "+passwordResetToken +passwordResetExpires +passwordResetSentAt";

function findUserByResetToken(token) {
  if (!isValidTokenFormat(token)) return null;
  return User.findOne({ passwordResetToken: hashToken(token), passwordResetExpires: { $gt: new Date() } }).select(RESET_FIELDS);
}

// 1) El usuario pide el enlace. La respuesta es siempre la misma exista o no la cuenta (no revela quién está registrado).
router.post(
  "/forgot-password",
  forgotLimiter,
  asyncHandler(async (req, res) => {
    const email = String(req.body?.email || "").trim().toLowerCase();

    if (!EMAIL_PATTERN.test(email)) {
      return res.status(400).json({ message: "Ingresa un correo válido" });
    }

    const user = await User.findOne({ email }).select(RESET_FIELDS);
    const recentlySent = user?.passwordResetSentAt && Date.now() - user.passwordResetSentAt.getTime() < RESEND_COOLDOWN_MS;

    if (user && !recentlySent) {
      const { token, hash } = createResetToken();
      user.passwordResetToken = hash;
      user.passwordResetExpires = new Date(Date.now() + RESET_TTL_MINUTES * 60 * 1000);
      user.passwordResetSentAt = new Date();
      await user.save();

      const mail = passwordResetEmail({ name: user.name, resetUrl: `${getAppUrl()}/reset-password/${token}`, minutes: RESET_TTL_MINUTES });
      // En segundo plano: así la respuesta tarda igual haya o no cuenta
      sendMail({ to: user.email, ...mail }).catch((error) => logMailError("No se pudo enviar el correo de recuperación", error));
    }

    res.json({
      message: "Si el correo está registrado, te enviamos un enlace para restablecer tu contraseña.",
      expiresInMinutes: RESET_TTL_MINUTES
    });
  })
);

// 2) La pantalla de restablecimiento comprueba el enlace antes de mostrar el formulario.
router.get(
  "/reset-password/:token",
  resetLimiter,
  asyncHandler(async (req, res) => {
    const user = await findUserByResetToken(req.params.token);
    if (!user) return res.status(400).json(INVALID_LINK);

    res.json({ valid: true });
  })
);

// 3) Se guarda la contraseña nueva. El token es de un solo uso y las sesiones anteriores se invalidan.
router.post(
  "/reset-password",
  resetLimiter,
  asyncHandler(async (req, res) => {
    const { token, password } = req.body || {};

    if (typeof password !== "string" || password.length < 6 || password.length > 128) {
      return res.status(400).json({ message: "La contraseña debe tener entre 6 y 128 caracteres" });
    }

    const user = await findUserByResetToken(token);
    if (!user) return res.status(400).json(INVALID_LINK);

    user.passwordHash = await bcrypt.hash(password, 12);
    user.passwordChangedAt = new Date();
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    user.passwordResetSentAt = undefined;
    await user.save();

    const mail = passwordChangedEmail({ name: user.name });
    sendMail({ to: user.email, ...mail }).catch((error) => logMailError("No se pudo enviar el aviso de cambio", error));

    res.clearCookie("token", clearCookieOptions);
    res.json({ message: "Contraseña actualizada. Ya puedes iniciar sesión." });
  })
);

export default router;
