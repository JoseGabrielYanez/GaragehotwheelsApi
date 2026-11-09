import jwt from "jsonwebtoken";
import { User } from "../models/User.js";

export async function requireAuth(req, res, next) {
  try {
    const token = req.cookies?.token;

    if (!token) {
      return res.status(401).json({ message: "Sesion requerida" });
    }

    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(payload.sub).select("-passwordHash");

    if (!user) {
      return res.status(401).json({ message: "Usuario no encontrado" });
    }

    // Tras restablecer la contraseña, los tokens emitidos antes del cambio dejan de servir
    if (user.passwordChangedAt && payload.iat < Math.floor(user.passwordChangedAt.getTime() / 1000)) {
      return res.status(401).json({ message: "Sesion expirada, inicia sesion de nuevo" });
    }

    req.user = user;
    next();
  } catch {
    res.status(401).json({ message: "Sesion invalida" });
  }
}
