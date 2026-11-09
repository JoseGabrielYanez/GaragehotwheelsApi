import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Carpeta de fotos. Por defecto server/uploads; UPLOADS_DIR permite apuntar a otro disco/volumen. */
export const uploadsDir = process.env.UPLOADS_DIR ? path.resolve(process.env.UPLOADS_DIR) : path.resolve(__dirname, "../../uploads");

// Carpeta donde versiones anteriores guardaban las fotos originales (ya no se usa; se limpia con cleanup-uploads)
export const legacyOriginalsDirName = "originals";

/** Borra un archivo sin fallar si ya no existe. Devuelve true si lo borró. */
export async function removeFile(file) {
  try {
    await fs.unlink(file);
    return true;
  } catch (error) {
    if (error.code !== "ENOENT") console.error(`[uploads] No se pudo borrar ${file}: ${error.message}`);
    return false;
  }
}

/** "123-foto-cutout.webp" → "123-foto": identifica todas las versiones de una misma foto. */
const baseName = (filename) => path.parse(filename).name.replace(/-(cutout|photo)$/, "");

/**
 * Borra del disco todo lo que pertenece a la foto de un auto: la imagen que se muestra y,
 * si quedara alguna, su original (con cualquier extensión, en uploads/ o en uploads/originals/).
 * Solo toca archivos de /uploads/; las fotos con URL externa se ignoran. Devuelve cuántos archivos borró.
 */
export async function deleteCarFiles(imageUrl, baseDir = uploadsDir) {
  if (!imageUrl?.startsWith("/uploads/")) return 0;

  const filename = path.basename(imageUrl); // basename evita rutas con ../
  const base = baseName(filename);
  let removed = 0;

  for (const dir of [baseDir, path.join(baseDir, legacyOriginalsDirName)]) {
    let names;
    try {
      names = await fs.readdir(dir);
    } catch {
      continue; // la carpeta no existe
    }

    for (const name of names) {
      if (name === filename || baseName(name) === base) {
        if (await removeFile(path.join(dir, name))) removed += 1;
      }
    }
  }

  return removed;
}

/** Lista todos los archivos de la carpeta de fotos (incluye subcarpetas, ignora los que empiezan con punto). */
export async function listUploadFiles(dir = uploadsDir, base = dir) {
  const files = [];

  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await listUploadFiles(full, base)));
    } else {
      const { size } = await fs.stat(full);
      files.push({ full, rel: path.relative(base, full).split(path.sep).join("/"), size });
    }
  }

  return files;
}

/** Archivos que ningún auto usa: referenced es un Set de rutas relativas a uploads (p. ej. "123-foto-cutout.webp"). */
export const findOrphans = (files, referenced) => files.filter((file) => !referenced.has(file.rel));
