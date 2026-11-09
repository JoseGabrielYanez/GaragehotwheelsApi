import "./config/env.js"; // siempre primero: carga el .env antes que el resto de módulos
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import { connectDb } from "./db.js";
import authRoutes from "./routes/auth.js";
import carRoutes from "./routes/cars.js";
import { verifyMail } from "./services/mailer.js";
import { serveUploads } from "./middleware/uploadsStatic.js";

const app = express();
const port = process.env.PORT || 4000;
const allowedOrigins = (process.env.CLIENT_URL || "http://localhost:5173,http://localhost:5174")
  .split(",")
  .map((origin) => origin.trim());

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      callback(new Error(`Origen no permitido por CORS: ${origin}`));
    },
    credentials: true
  })
);
app.use(express.json());
app.use(cookieParser());
app.disable("x-powered-by");
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
});
app.use("/uploads", serveUploads());

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api/auth", authRoutes);
app.use("/api/cars", carRoutes);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ message: err.message || "Error interno" });
});

await connectDb();
app.listen(port, () => {
  console.log(`API escuchando en http://localhost:${port}`);
  verifyMail(); // avisa de inmediato si el correo está mal configurado
});
