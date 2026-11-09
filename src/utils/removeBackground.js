import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { assertSupportedImage } from "./imageValidation.js";

/**
 * Quita el fondo de una foto tomada sobre una superficie de color uniforme
 * (por ejemplo el terciopelo rojo), conservando la tarjeta/blister completo.
 *
 * El color del fondo se calcula solo a partir de los bordes de la foto, así que
 * no está limitado al rojo. Todo corre en Node (sharp), sin modelos ni descargas.
 */

const MAX_SIDE = 1100;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function sortedCopy(values) {
  return Float32Array.from(values).sort();
}

function median(values) {
  const sorted = sortedCopy(values);
  return sorted[sorted.length >> 1];
}

function percentile(values, p) {
  const sorted = sortedCopy(values);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

/** Etiqueta componentes conectados. Devuelve { labels, count }. */
function labelComponents(mask, w, h, eight = false) {
  const labels = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  let count = 0;

  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || labels[start]) continue;
    count += 1;
    let sp = 0;
    stack[sp++] = start;
    labels[start] = count;

    while (sp) {
      const p = stack[--sp];
      const x = p % w;
      const y = (p - x) / w;

      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if ((dx === 0 && dy === 0) || (!eight && dx !== 0 && dy !== 0)) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const q = ny * w + nx;
          if (mask[q] && !labels[q]) {
            labels[q] = count;
            stack[sp++] = q;
          }
        }
      }
    }
  }

  return { labels, count };
}

function borderLabels(labels, w, h) {
  const found = new Set();
  for (let x = 0; x < w; x++) {
    found.add(labels[x]);
    found.add(labels[(h - 1) * w + x]);
  }
  for (let y = 0; y < h; y++) {
    found.add(labels[y * w]);
    found.add(labels[y * w + w - 1]);
  }
  found.delete(0);
  return found;
}

/**
 * Erosión/dilatación con kernel cuadrado (separable) en tiempo lineal: una ventana deslizante cuenta
 * cuántos píxeles de la ventana están activos (el costo ya no crece con el tamaño del kernel).
 * Fuera de la imagen se asume 1 para erosionar y 0 para dilatar.
 */
function morph(mask, w, h, r, erode) {
  const size = 2 * r + 1;
  const outside = erode ? 1 : 0;
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);

  // Una pasada 1D sobre `src` → `dst`: `length` elementos, separados por `step`, empezando en `start`
  const pass = (src, dst, start, length, step) => {
    const at = (k) => (k < 0 || k >= length ? outside : src[start + k * step]);
    let count = 0;
    for (let k = -r; k <= r; k++) count += at(k);

    for (let x = 0; x < length; x++) {
      dst[start + x * step] = erode ? (count === size ? 1 : 0) : count > 0 ? 1 : 0;
      count += at(x + r + 1) - at(x - r);
    }
  };

  for (let y = 0; y < h; y++) pass(mask, tmp, y * w, w, 1);
  for (let x = 0; x < w; x++) pass(tmp, out, x, h, w);

  return out;
}

function computeForeground(rgb, w, h, blurred) {
  const total = w * h;
  const rn = new Float32Array(total);
  const gn = new Float32Array(total);
  const v = new Float32Array(total);

  for (let i = 0; i < total; i++) {
    const r = blurred[i * 3] + 1;
    const g = blurred[i * 3 + 1] + 1;
    const b = blurred[i * 3 + 2] + 1;
    const sum = r + g + b;
    rn[i] = r / sum;
    gn[i] = g / sum;
    v[i] = Math.max(r, g, b) / 256;
  }

  // Modelo del fondo: anillo exterior de la foto
  const ringWidth = Math.max(3, Math.floor(Math.min(w, h) * 0.03));
  const ring = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x < ringWidth || y < ringWidth || x >= w - ringWidth || y >= h - ringWidth) ring.push(y * w + x);
    }
  }

  const c0r = median(ring.map((i) => rn[i]));
  const c0g = median(ring.map((i) => gn[i]));
  const d = new Float32Array(total);
  for (let i = 0; i < total; i++) d[i] = Math.hypot(rn[i] - c0r, gn[i] - c0g);

  const tc = clamp(2.5 * median(ring.map((i) => d[i])), 0.05, 0.1);
  const velvetV = ring.filter((i) => d[i] < tc).map((i) => v[i]);
  const vhi = velvetV.length > 50 ? percentile(velvetV, 0.97) * 1.12 : 0.6;

  // Tolerancia algo mayor en zonas oscuras, donde el tono es más ruidoso (sin pasarse: si no, el fondo "entra" por las partes oscuras de la tarjeta)
  const strict = new Uint8Array(total);
  const relaxed = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    const tol = tc * clamp(0.5 / (v[i] + 0.12), 1, 1.9);
    strict[i] = d[i] < tol && v[i] < vhi ? 1 : 0;
    relaxed[i] = d[i] < tol * 1.6 && v[i] < vhi * 1.05 ? 1 : 0;
  }

  // Fondo = zonas de color parecido conectadas con el borde de la foto
  const strictCc = labelComponents(strict, w, h);
  const edge = borderLabels(strictCc.labels, w, h);
  const bg = new Uint8Array(total);
  for (let i = 0; i < total; i++) if (edge.has(strictCc.labels[i])) bg[i] = 1;

  // Histéresis: crecer hacia zonas más tenues/oscuras del mismo fondo
  const relaxedCc = labelComponents(relaxed, w, h);
  const keep = new Set();
  for (let i = 0; i < total; i++) if (bg[i] && relaxed[i]) keep.add(relaxedCc.labels[i]);
  keep.delete(0);
  for (let i = 0; i < total; i++) if (keep.has(relaxedCc.labels[i])) bg[i] = 1;

  // Primer plano limpio: abrir/cerrar, quedarse con lo más grande y rellenar huecos internos
  let fg = new Uint8Array(total);
  for (let i = 0; i < total; i++) fg[i] = bg[i] ? 0 : 1;
  fg = morph(morph(fg, w, h, 2, true), w, h, 2, false);
  fg = morph(morph(fg, w, h, 2, false), w, h, 2, true);

  fg = largestComponent(fg, w, h);
  if (!fg) return null;
  fg = fillHoles(fg, w, h);

  return morph(fg, w, h, 2, true); // quita el halo de color del borde
}

/**
 * Genera un WebP con transparencia, recortado al contenido.
 * Devuelve { ok: true } o { ok: false, reason }.
 */
/* ───────── Método 2: por contorno (fondos neutros: blanco, gris, negro...) ───────── */

/** Gradiente de Sobel de un canal. Devuelve la magnitud (≈ niveles de brillo por píxel) y sus componentes. */
function sobelGradient(chan, w, h) {
  const total = w * h;
  const mag = new Float32Array(total);
  const gxs = new Float32Array(total);
  const gys = new Float32Array(total);

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const a = chan[i - w - 1], b = chan[i - w], c = chan[i - w + 1];
      const d = chan[i - 1], f = chan[i + 1];
      const g = chan[i + w - 1], hh = chan[i + w], k = chan[i + w + 1];
      const gx = c + 2 * f + k - (a + 2 * d + g);
      const gy = g + 2 * hh + k - (a + 2 * b + c);
      gxs[i] = gx;
      gys[i] = gy;
      mag[i] = Math.hypot(gx, gy) / 4;
    }
  }

  return { mag, gxs, gys };
}

/** Canny: borde fino en el pico del gradiente + histéresis (los débiles solo cuentan si tocan uno fuerte). */
function cannyFromGradient({ mag, gxs, gys }, w, h, lo, hi, out) {
  const total = w * h;
  const weak = new Uint8Array(total);
  const stack = [];

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const m = mag[i];
      if (m < lo) continue;

      const ax = Math.abs(gxs[i]);
      const ay = Math.abs(gys[i]);
      let n1, n2;
      if (ay <= 0.4142 * ax) { n1 = mag[i - 1]; n2 = mag[i + 1]; }
      else if (ay >= 2.4142 * ax) { n1 = mag[i - w]; n2 = mag[i + w]; }
      else if (gxs[i] * gys[i] > 0) { n1 = mag[i - w - 1]; n2 = mag[i + w + 1]; }
      else { n1 = mag[i - w + 1]; n2 = mag[i + w - 1]; }

      if (m > n1 && m >= n2) {
        weak[i] = 1;
        if (m >= hi) {
          out[i] = 1;
          stack.push(i);
        }
      }
    }
  }

  while (stack.length) {
    const p = stack.pop();
    const x = p % w;
    const y = (p - x) / w;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx;
        if (weak[q] && !out[q]) {
          out[q] = 1;
          stack.push(q);
        }
      }
    }
  }
}

/** Primer plano = región encerrada por el contorno de la tarjeta (no depende del color del fondo). */
function computeForegroundByEdges(w, h, blurredEdge) {
  const total = w * h;
  const gradients = [];
  const ringWidth = Math.max(3, Math.floor(Math.min(w, h) * 0.02));
  const ring = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x < ringWidth || y < ringWidth || x >= w - ringWidth || y >= h - ringWidth) ring.push(y * w + x);
    }
  }

  for (let c = 0; c < 3; c++) {
    const chan = new Float32Array(total);
    for (let i = 0; i < total; i++) chan[i] = blurredEdge[i * 3 + c];
    gradients.push(sobelGradient(chan, w, h));
  }

  // Ruido de gradiente del fondo → umbrales adaptativos
  const ringGradient = ring.map((i) => Math.max(gradients[0].mag[i], gradients[1].mag[i], gradients[2].mag[i]));
  const noise = percentile(ringGradient, 0.95);
  const hi = Math.max(8, 4 * noise);
  const lo = Math.max(3.5, 1.6 * noise);

  const edges = new Uint8Array(total);
  for (const gradient of gradients) cannyFromGradient(gradient, w, h, lo, hi, edges);

  // Cierra los huecos del contorno, rellena el interior y se queda con el objeto principal
  const k = Math.max(3, Math.round(Math.min(w, h) * 0.012));
  let fg = morph(morph(edges, w, h, k, false), w, h, k, true);
  fg = fillHoles(fg, w, h);

  fg = largestComponent(fg, w, h);
  if (!fg) return null;
  fg = largestComponent(morph(morph(fg, w, h, k, true), w, h, k, false), w, h); // quita rebabas (sombras, ruido)
  if (!fg) return null;

  return { mask: morph(fg, w, h, 1, true), edges };
}

/* ───────── Utilidades de máscara ───────── */

function largestComponent(mask, w, h) {
  const cc = labelComponents(mask, w, h, true);
  if (!cc.count) return null;

  const sizes = new Int32Array(cc.count + 1);
  for (let i = 0; i < mask.length; i++) sizes[cc.labels[i]] += 1;
  sizes[0] = 0;
  let biggest = 1;
  for (let l = 2; l <= cc.count; l++) if (sizes[l] > sizes[biggest]) biggest = l;

  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = cc.labels[i] === biggest ? 1 : 0;
  return out;
}

function fillHoles(mask, w, h) {
  const inverse = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) inverse[i] = mask[i] ? 0 : 1;
  const holes = labelComponents(inverse, w, h);
  const outside = borderLabels(holes.labels, w, h);

  const out = Uint8Array.from(mask);
  for (let i = 0; i < mask.length; i++) if (inverse[i] && !outside.has(holes.labels[i])) out[i] = 1;
  return out;
}

/** Área del casco convexo de la máscara (usa los extremos izquierdo y derecho de cada fila). */
function convexHullArea(mask, w, h) {
  const left = [];
  const right = [];
  for (let y = 0; y < h; y++) {
    let x0 = -1;
    let x1 = -1;
    for (let x = 0; x < w; x++) if (mask[y * w + x]) { x0 = x; break; }
    if (x0 < 0) continue;
    for (let x = w - 1; x >= 0; x--) if (mask[y * w + x]) { x1 = x; break; }
    left.push([x0, y]);
    right.push([x1 + 1, y + 1]);
  }

  const points = [...left, ...right].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const build = (pts) => {
    const chain = [];
    for (const p of pts) {
      while (chain.length >= 2 && cross(chain[chain.length - 2], chain[chain.length - 1], p) <= 0) chain.pop();
      chain.push(p);
    }
    return chain;
  };
  const hull = [...build(points).slice(0, -1), ...build([...points].reverse()).slice(0, -1)];

  let area = 0;
  for (let i = 0; i < hull.length; i++) {
    const [x1, y1] = hull[i];
    const [x2, y2] = hull[(i + 1) % hull.length];
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area) / 2;
}

/**
 * Mide si un recorte es creíble. Un recorte malo es peor que no recortar: si no pasa estas pruebas
 * la foto se conserva completa en vez de mutilarla.
 */
function assessMask(mask, w, h, edges) {
  let area = 0;
  let onBorder = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      area += 1;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) onBorder += 1;
    }
  }

  const quality = {
    ratio: area / (w * h), // cuánto de la foto ocupa
    borderTouch: onBorder / (2 * (w + h)), // fracción del marco de la foto que toca
    solidity: area ? area / convexHullArea(mask, w, h) : 0 // una tarjeta es casi convexa; un recorte mutilado no
  };

  if (edges) {
    // ¿El borde del recorte coincide con bordes reales de la foto?
    const nearEdge = morph(edges, w, h, 3, false);
    const inner = morph(mask, w, h, 1, true);
    let boundary = 0;
    let supported = 0;
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] && !inner[i]) {
        boundary += 1;
        if (nearEdge[i]) supported += 1;
      }
    }
    quality.edgeSupport = boundary ? supported / boundary : 0;
  }

  return quality;
}

const isAcceptable = (q) =>
  q.ratio >= 0.08 && q.ratio <= 0.92 && q.borderTouch <= 0.4 && q.solidity >= 0.8 && (q.edgeSupport === undefined || q.edgeSupport >= 0.55);

/** Saturación del fondo (anillo exterior): terciopelo rojo ≈ 0.8; blanco, gris o negro ≈ 0. */
function backgroundSaturation(blurred, w, h) {
  const ringWidth = Math.max(3, Math.floor(Math.min(w, h) * 0.02));
  const channels = [[], [], []];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x < ringWidth || y < ringWidth || x >= w - ringWidth || y >= h - ringWidth) {
        for (let c = 0; c < 3; c++) channels[c].push(blurred[(y * w + x) * 3 + c]);
      }
    }
  }
  const [r, g, b] = channels.map(median);
  const max = Math.max(r, g, b);
  return max > 0 ? (max - Math.min(r, g, b)) / max : 0;
}

/**
 * Elige cómo separar el fondo según su tipo y comprueba el resultado:
 *  - fondo con color (terciopelo, tela, fieltro): por color; si sale dudoso, por contorno;
 *  - fondo neutro (blanco, gris, negro): por contorno.
 * Devuelve { mask, strategy, quality } o null si ningún resultado es creíble.
 */
function chooseForeground({ rgb, w, h, blurredChroma, blurredEdge }) {
  const colored = backgroundSaturation(blurredChroma, w, h) > 0.28;

  const byColor = () => {
    const mask = computeForeground(rgb, w, h, blurredChroma);
    return mask ? { mask, edges: null, strategy: "color" } : null;
  };
  const byEdges = () => {
    const found = computeForegroundByEdges(w, h, blurredEdge);
    return found ? { ...found, strategy: "contorno" } : null;
  };

  for (const attempt of colored ? [byColor, byEdges] : [byEdges]) {
    const candidate = attempt();
    if (!candidate) continue;

    const quality = assessMask(candidate.mask, w, h, candidate.edges);
    if (isAcceptable(quality)) return { mask: candidate.mask, strategy: candidate.strategy, quality };
  }

  return null;
}

/** Carga la imagen a tamaño de trabajo y prepara las versiones suavizadas que usan los dos métodos. */
async function prepareForSegmentation(input) {
  const { data: rgb, info } = await sharp(input)
    .rotate()
    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width: w, height: h } = info;
  const blur = (sigma) => sharp(rgb, { raw: { width: w, height: h, channels: 3 } }).blur(sigma).raw().toBuffer();
  const [blurredChroma, blurredEdge] = await Promise.all([blur(Math.max(1.2, Math.min(w, h) / 260)), blur(1.6)]);

  return { rgb, w, h, blurredChroma, blurredEdge };
}

/** Segmenta la foto y devuelve la máscara (en el tamaño de trabajo) con la estrategia usada. */
export async function segmentImage(input) {
  const prepared = await prepareForSegmentation(input);
  return { ...prepared, found: chooseForeground(prepared) };
}

export async function removeBackgroundToFile(inputPath, outputPath) {
  const meta = await sharp(inputPath).metadata();

  if (meta.hasAlpha) {
    const { channels } = await sharp(inputPath).stats();
    if (channels[3] && channels[3].min < 250) return { ok: false, code: "transparent", reason: "La imagen ya tiene transparencia" };
  }

  const { rgb, w, h, found } = await segmentImage(inputPath);
  if (!found) return { ok: false, code: "not-uniform", reason: "No se pudo separar el fondo con seguridad" };
  const fg = found.mask;

  // Bordes suaves
  const fgBytes = Buffer.alloc(w * h);
  for (let i = 0; i < fg.length; i++) fgBytes[i] = fg[i] * 255;
  const soft = await sharp(fgBytes, { raw: { width: w, height: h, channels: 1 } })
    .blur(1.6)
    .extractChannel(0) // sharp devuelve 3 canales al desenfocar una máscara gris
    .raw()
    .toBuffer();

  const rgba = Buffer.alloc(w * h * 4);
  let minX = w, minY = h, maxX = 0, maxY = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const alpha = clamp(((soft[i] / 255) - 0.5) * 3 + 0.5, 0, 1);
      rgba[i * 4] = rgb[i * 3];
      rgba[i * 4 + 1] = rgb[i * 3 + 1];
      rgba[i * 4 + 2] = rgb[i * 3 + 2];
      rgba[i * 4 + 3] = Math.round(alpha * 255);
      if (alpha > 0.04) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX <= minX || maxY <= minY) return { ok: false, code: "not-uniform", reason: "Recorte vacío" };

  await sharp(rgba, { raw: { width: w, height: h, channels: 4 } })
    .extract({ left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 })
    .webp({ quality: 90, alphaQuality: 100 })
    .toFile(outputPath);

  return { ok: true, strategy: found.strategy };
}

/**
 * Foto sin recorte (por ejemplo un auto suelto en una vitrina): quita los márgenes
 * vacíos, la reduce y la guarda como WebP liviano.
 */
export async function trimPhotoToFile(inputPath, outputPath) {
  const rotated = await sharp(inputPath).rotate().flatten({ background: "#ffffff" }).toBuffer({ resolveWithObject: true });
  let source = rotated.data;

  try {
    const trimmed = await sharp(rotated.data).trim({ threshold: 22 }).toBuffer({ resolveWithObject: true });
    const ratio = (trimmed.info.width * trimmed.info.height) / (rotated.info.width * rotated.info.height);
    if (ratio > 0.2 && ratio < 0.97) source = trimmed.data; // solo si el recorte es razonable
  } catch {
    // sin márgenes que quitar: se usa la foto completa
  }

  await sharp(source)
    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 88 })
    .toFile(outputPath);

  return { ok: true };
}

/** Imagen que ya trae transparencia: no se recorta, pero igualmente se re-codifica (nunca se publican los bytes subidos). */
export async function normalizeTransparentToFile(input, outputPath) {
  await sharp(input)
    .rotate()
    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 90, alphaQuality: 100 })
    .toFile(outputPath);

  return { ok: true };
}

/**
 * Procesa la foto de un auto y SIEMPRE genera un archivo nuevo en WebP con nombre propio del servidor:
 *   1. Valida el contenido real (firma + lectura con sharp). Si no es una imagen permitida lanza UnsupportedImageError.
 *   2. Recorta el fondo si es posible ("cutout"); si ya era transparente la conserva ("cutout");
 *      si no, la limpia de márgenes ("photo").
 * Los bytes que subió el usuario nunca se guardan ni se publican: la salida se re-codifica y pierde metadatos (EXIF, GPS).
 *
 * input: Buffer o ruta. Con Buffer hay que indicar baseName. Devuelve { kind: "cutout" | "photo", filename, reason? }.
 */
export async function processCarImage(input, outDir, { baseName, removeBackground = true } = {}) {
  await assertSupportedImage(input);

  const base = baseName || (typeof input === "string" ? path.parse(input).name : null);
  if (!base) throw new Error("processCarImage necesita baseName cuando recibe un Buffer");

  await fs.mkdir(outDir, { recursive: true });
  let reason;

  if (removeBackground) {
    const cutoutName = `${base}-cutout.webp`;
    const cut = await removeBackgroundToFile(input, path.join(outDir, cutoutName));
    if (cut.ok) return { kind: "cutout", filename: cutoutName };

    if (cut.code === "transparent") {
      await normalizeTransparentToFile(input, path.join(outDir, cutoutName));
      return { kind: "cutout", filename: cutoutName, reason: cut.reason };
    }
    reason = cut.reason;
  }

  const photoName = `${base}-photo.webp`;
  await trimPhotoToFile(input, path.join(outDir, photoName));
  return { kind: "photo", filename: photoName, reason };
}
