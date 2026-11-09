// Quita el fondo a las fotos que ya están en el stock y BORRA las originales para no ocupar disco.
// Uso (desde la raíz del proyecto):  npm run remove-bg
import "../src/config/env.js"; // siempre primero: carga el .env
import fs from "node:fs/promises";
import path from "node:path";
import mongoose from "mongoose";
import { connectDb } from "../src/db.js";
import { Car } from "../src/models/Car.js";
import { processCarImage } from "../src/utils/removeBackground.js";
import { UnsupportedImageError } from "../src/utils/imageValidation.js";
import { removeFile, uploadsDir } from "../src/utils/uploads.js";

const relativePath = (imageUrl = "") => imageUrl.replace(/^\/uploads\//, "");

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

await connectDb();

// 1) Reparación: si el archivo de un auto no existe, apunta a su recorte o a su copia en originals/
let repaired = 0;
for (const car of await Car.find({})) {
  const rel = relativePath(car.imageUrl);
  if (!rel || (await exists(path.join(uploadsDir, rel)))) continue;

  const name = path.basename(rel);
  const candidates = [`${path.parse(name).name}-cutout.webp`, `${path.parse(name).name}-photo.webp`, `originals/${name}`];
  for (const candidate of candidates) {
    if (await exists(path.join(uploadsDir, candidate))) {
      await Car.updateOne({ _id: car._id }, { $set: { imageUrl: `/uploads/${candidate}` } });
      repaired += 1;
      console.log(`↺ ${car.name}: enlace reparado (${candidate})`);
      break;
    }
  }
}

// 2) Recorte de fondo
const cars = await Car.find({ imageUrl: { $not: /-(cutout|photo)\.webp$/ } });
console.log(`Autos por procesar: ${cars.length}`);

let done = 0;
let skipped = 0;

for (const car of cars) {
  const rel = relativePath(car.imageUrl);
  const input = path.join(uploadsDir, rel);

  try {
    const result = await processCarImage(input, uploadsDir);

    // Primero se actualiza la base de datos; solo después se borra la original
    await Car.updateOne({ _id: car._id }, { $set: { imageUrl: `/uploads/${result.filename}` } });
    await removeFile(input);
    done += 1;
    console.log(`${result.kind === "cutout" ? "✓ recortada" : "✓ foto limpia"}: ${car.name}`);
  } catch (error) {
    skipped += 1;
    console.log(
      error instanceof UnsupportedImageError
        ? `⚠ ${car.name}: el archivo NO es una imagen válida (${error.message}). Ejecuta npm run cleanup-uploads para revisarlo.`
        : `- ${car.name}: error (${error.message})`
    );
  }
}

console.log(`Listo: ${done} procesadas, ${skipped} sin cambios, ${repaired} enlaces reparados.`);
console.log("Para borrar archivos sobrantes de antes (originales, fotos de autos eliminados): npm run cleanup-uploads");
await mongoose.disconnect();
