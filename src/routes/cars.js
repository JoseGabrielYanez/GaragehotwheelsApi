import crypto from "node:crypto";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { Car } from "../models/Car.js";
import { requireAuth } from "../middleware/auth.js";
import { processCarImage } from "../utils/removeBackground.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { deleteCarFiles, uploadsDir } from "../utils/uploads.js";
import { ALLOWED_EXTENSIONS, ALLOWED_MIME_TYPES, UnsupportedImageError } from "../utils/imageValidation.js";

const router = Router();

// La foto se recibe en MEMORIA: el archivo subido nunca toca la carpeta pública. Solo se escribe el resultado
// ya validado y re-codificado (WebP) con un nombre generado por el servidor.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    // Primer filtro (barato): tipo y extensión declarados. La validación de verdad es sobre el contenido (assertSupportedImage).
    const extension = path.extname(file.originalname || "").toLowerCase();

    if (!ALLOWED_MIME_TYPES.has(file.mimetype) || !ALLOWED_EXTENSIONS.has(extension)) {
      return cb(new UnsupportedImageError("Formato no permitido: sube una foto JPG, PNG o WebP"));
    }

    cb(null, true);
  }
});

// Errores de la subida como JSON claro (por defecto Express respondería una página HTML con código 500)
const handleUpload = (req, res, next) =>
  upload.single("image")(req, res, (error) => {
    if (!error) return next();

    if (error instanceof multer.MulterError) {
      const tooBig = error.code === "LIMIT_FILE_SIZE";
      return res.status(tooBig ? 413 : 400).json({ message: tooBig ? "La foto supera el máximo de 8 MB" : "La subida no es válida" });
    }

    if (error.status) return res.status(error.status).json({ message: error.message });
    next(error);
  });

router.use(requireAuth);

router.get("/", async (req, res) => {
  const search = String(req.query.search || "").trim();
  const query = { user: req.user._id };

  if (search) {
    query.name = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
  }

  const total = await Car.countDocuments(query);
  const requestedLimit = parseInt(req.query.limit, 10);

  // Sin "limit" devuelve todo el stock (lo usa el carrusel).
  if (!requestedLimit) {
    const cars = await Car.find(query).sort({ createdAt: -1 });
    return res.json({ cars, total, page: 1, pages: 1, limit: total });
  }

  const limit = Math.min(Math.max(requestedLimit, 1), 100);
  const pages = Math.max(Math.ceil(total / limit), 1);
  const page = Math.min(Math.max(parseInt(req.query.page, 10) || 1, 1), pages);
  const cars = await Car.find(query)
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit);

  res.json({ cars, total, page, pages, limit });
});

router.post(
  "/",
  handleUpload,
  asyncHandler(async (req, res) => {
    const { name, notes, ocrText } = req.body;

    if (!req.file) {
      return res.status(400).json({ message: "La foto es obligatoria" });
    }

    if (!name?.trim()) {
      return res.status(400).json({ message: "El nombre es obligatorio" }); // nada se guardó en disco todavía
    }

    // El nombre del archivo lo decide el servidor (el nombre y la extensión del cliente no se usan)
    const baseName = `${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
    let result;

    try {
      // Valida el contenido real y genera un WebP nuevo (recorte de fondo o foto limpia). REMOVE_BG=false solo omite el recorte.
      result = await processCarImage(req.file.buffer, uploadsDir, { baseName, removeBackground: process.env.REMOVE_BG !== "false" });
    } catch (error) {
      // Si no se puede procesar NO se publica nada: no existe un "plan B" que guarde el archivo original
      if (error instanceof UnsupportedImageError) return res.status(415).json({ message: error.message });

      console.error("[foto] No se pudo procesar la imagen:", error.message);
      return res.status(422).json({ message: "No se pudo procesar la imagen. Prueba con otra foto (JPG, PNG o WebP)." });
    }

    if (result.kind === "photo" && result.reason) console.log(`[foto] Sin recorte de fondo (${result.reason}): ${result.filename}`);

    try {
      const car = await Car.create({
        user: req.user._id,
        name,
        notes,
        ocrText,
        imageUrl: `/uploads/${result.filename}`
      });

      res.status(201).json({ car });
    } catch (error) {
      await deleteCarFiles(`/uploads/${result.filename}`); // si no se pudo guardar el auto, tampoco quedan archivos
      throw error;
    }
  })
);

router.put("/:id", async (req, res) => {
  const { name, notes } = req.body;

  if (!name?.trim()) {
    return res.status(400).json({ message: "El nombre es obligatorio" });
  }

  const car = await Car.findOneAndUpdate(
    { _id: req.params.id, user: req.user._id },
    { name, notes },
    { new: true }
  );

  if (!car) {
    return res.status(404).json({ message: "Auto no encontrado" });
  }

  res.json({ car });
});

router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const car = await Car.findOneAndDelete({ _id: req.params.id, user: req.user._id });

    if (!car) {
      return res.status(404).json({ message: "Auto no encontrado" });
    }

    // Se borra la foto del disco (salvo que otro auto la esté usando)
    const stillUsed = await Car.exists({ imageUrl: car.imageUrl });
    if (!stillUsed) {
      await deleteCarFiles(car.imageUrl).catch((error) => console.error("[uploads] No se pudo borrar la foto:", error.message));
    }

    res.json({ ok: true });
  })
);

export default router;
