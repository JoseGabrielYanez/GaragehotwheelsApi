import path from "node:path";
import express from "express";
import { ALLOWED_EXTENSIONS } from "../utils/imageValidation.js";
import { uploadsDir } from "../utils/uploads.js";

/**
 * Entrega /uploads únicamente como imágenes:
 *  - solo extensiones de imagen permitidas (un .html, .svg o .js guardado ahí jamás se sirve),
 *  - nosniff: el navegador no adivina otro tipo de contenido,
 *  - CSP con sandbox y Content-Disposition: attachment: aunque alguien abra la URL directamente no se ejecuta nada
 *    (las etiquetas <img> siguen mostrando la imagen con normalidad).
 */
export function serveUploads(dir = uploadsDir) {
  // Cada foto tiene un nombre único (marca de tiempo + aleatorio) y nunca cambia: se puede guardar un año en caché
  const files = express.static(dir, { index: false, redirect: false, dotfiles: "ignore", fallthrough: true, maxAge: "365d", immutable: true });
  const notFound = (res) => res.status(404).json({ message: "No encontrado" });

  return (req, res) => {
    if (!ALLOWED_EXTENSIONS.has(path.extname(req.path).toLowerCase())) return notFound(res);

    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self'; style-src 'none'; sandbox");
    res.setHeader("Content-Disposition", "attachment");
    files(req, res, () => notFound(res));
  };
}
