// Carga server/.env. Debe ser el PRIMER import de index.js y de los scripts, para que las
// variables ya existan cuando otros módulos las leen al cargarse (UPLOADS_DIR, PASSWORD_RESET_TTL_MINUTES...).
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.env") });
