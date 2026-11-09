// Limpia server/uploads:
//   1) fotos que ningún auto usa (originales antiguas, fotos de autos ya eliminados...),
//   2) archivos que NO son imágenes de verdad (extensión no permitida o contenido que no es JPG/PNG/WebP),
//      por ejemplo un .html subido antes de que se validara el contenido.
//
//   npm run cleanup-uploads          → solo muestra qué se borraría (no toca nada)
//   npm run cleanup-uploads:apply    → borra de verdad
import "../src/config/env.js"; // siempre primero: carga el .env
import fs from "node:fs/promises";
import path from "node:path";
import mongoose from "mongoose";
import { connectDb } from "../src/db.js";
import { Car } from "../src/models/Car.js";
import { ALLOWED_EXTENSIONS, hasAllowedImageSignature } from "../src/utils/imageValidation.js";
import { findOrphans, listUploadFiles, removeFile, uploadsDir } from "../src/utils/uploads.js";

const apply = process.argv.includes("--apply");
const force = process.argv.includes("--force");
const megabytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

await connectDb();

const cars = await Car.find({}).select("imageUrl");
const referenced = new Set(cars.map((car) => (car.imageUrl || "").replace(/^\/uploads\//, "")));

const files = await listUploadFiles(uploadsDir).catch(() => []);

// 1) Sobrantes. Con la base vacía todo parecería sobrante (p. ej. si el .env apunta a otra base): no se toca salvo --force
let orphans = findOrphans(files, referenced);
const orphansBlocked = !cars.length && orphans.length > 0 && !force;
if (orphansBlocked) {
  console.log("⚠ No hay autos en la base de datos: no se borran los sobrantes. Revisa MONGODB_URI o usa --force si estás seguro.");
  orphans = [];
}

// 2) Archivos que no son imágenes válidas (esto no depende de la base de datos)
const suspicious = [];
for (const file of files) {
  const validExtension = ALLOWED_EXTENSIONS.has(path.extname(file.rel).toLowerCase());
  if (!validExtension || !(await hasAllowedImageSignature(file.full))) suspicious.push(file);
}

const toDelete = [...new Map([...orphans, ...suspicious].map((file) => [file.full, file])).values()];
const totalBytes = toDelete.reduce((sum, file) => sum + file.size, 0);

console.log(
  `Autos en la base de datos: ${cars.length} · archivos en uploads: ${files.length} · sobrantes: ${orphans.length} · NO son imagen válida: ${suspicious.length}`
);

if (suspicious.length) {
  console.log("\n⚠ Archivos que no son imágenes válidas (posible contenido peligroso):");
  suspicious.forEach((file) => console.log(`  ${file.rel} ${referenced.has(file.rel) ? "(lo usa un auto: ese auto se quedará sin foto)" : ""}`));
}

if (toDelete.length) {
  console.log(`\nA borrar: ${toDelete.length} archivos (${megabytes(totalBytes)})`);
  toDelete.slice(0, 40).forEach((file) => console.log(`  ${apply ? "borrando" : "sobra"}: ${file.rel} (${megabytes(file.size)})`));
  if (toDelete.length > 40) console.log(`  ... y ${toDelete.length - 40} más`);
}

if (!apply) {
  console.log(toDelete.length ? "\nSimulación: no se borró nada. Para borrar de verdad: npm run cleanup-uploads:apply" : "\nNo hay nada que limpiar.");
} else {
  let removed = 0;
  for (const file of toDelete) if (await removeFile(file.full)) removed += 1;

  // Quita las subcarpetas que hayan quedado vacías (p. ej. uploads/originals)
  for (const entry of await fs.readdir(uploadsDir, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) await fs.rmdir(path.join(uploadsDir, entry.name)).catch(() => {});
  }

  console.log(`\nListo: ${removed} archivos borrados, ${megabytes(totalBytes)} liberados.`);
}

await mongoose.disconnect();
