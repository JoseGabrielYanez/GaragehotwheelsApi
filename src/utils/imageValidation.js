import fs from "node:fs/promises";
import sharp from "sharp";

/** Formatos de imagen admitidos y las únicas extensiones que se aceptan/entregan. */
export const ALLOWED_FORMATS = new Set(["jpeg", "png", "webp"]);
export const ALLOWED_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
export const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

const MAX_PIXELS = 60_000_000; // evita "bombas de descompresión" (imágenes diminutas en disco que ocupan GB al abrirlas)
const MAX_SIDE = 12_000;

export class UnsupportedImageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UnsupportedImageError";
    this.status = 415;
  }
}

/** Formato real según los primeros bytes del archivo (la firma), no según el nombre ni el tipo declarado. */
export function detectFormatBySignature(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpeg";
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buffer.subarray(0, 4).toString("latin1") === "RIFF" && buffer.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return null;
}

/**
 * Comprueba que el CONTENIDO sea de verdad una imagen JPG, PNG o WebP: firma binaria + lectura con sharp
 * (que debe coincidir con la firma) + tamaño razonable. Acepta un Buffer o la ruta de un archivo.
 * Lanza UnsupportedImageError si no cumple.
 */
export async function assertSupportedImage(input) {
  const buffer = Buffer.isBuffer(input) ? input : await fs.readFile(input);

  const signature = detectFormatBySignature(buffer);
  if (!signature) throw new UnsupportedImageError("El archivo no es una imagen JPG, PNG o WebP válida");

  let meta;
  try {
    meta = await sharp(buffer, { limitInputPixels: MAX_PIXELS, failOn: "error" }).metadata();
  } catch {
    throw new UnsupportedImageError("La imagen está dañada o es demasiado grande");
  }

  if (meta.format !== signature || !ALLOWED_FORMATS.has(meta.format)) {
    throw new UnsupportedImageError("El contenido del archivo no coincide con un formato de imagen permitido");
  }
  if (!meta.width || !meta.height || meta.width > MAX_SIDE || meta.height > MAX_SIDE) {
    throw new UnsupportedImageError("Las dimensiones de la imagen no son válidas");
  }

  return meta;
}

/** Solo mira la firma de un archivo del disco (para auditar lo que ya está guardado). */
export async function hasAllowedImageSignature(file) {
  let handle;
  try {
    handle = await fs.open(file, "r");
    const header = Buffer.alloc(12);
    const { bytesRead } = await handle.read(header, 0, 12, 0);
    return detectFormatBySignature(header.subarray(0, bytesRead)) !== null;
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}
