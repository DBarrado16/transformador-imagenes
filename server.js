import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import archiver from 'archiver';
import decodificarHeic from 'heic-decode';
import exifr from 'exifr';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PUERTO = process.env.PORT || 3000;
const MAX_ARCHIVO = 200 * 1024 * 1024;  // 200 MB por archivo
const MAX_ARCHIVOS = 60;                // por lote
const VIDA_RESULTADO = 30 * 60 * 1000;  // 30 min antes de borrarse
const EN_PARALELO = 3;                  // un HEIC de 24 MP ocupa ~100 MB en crudo

const TEMP = path.join(os.tmpdir(), 'transformador-imagenes');
fs.rmSync(TEMP, { recursive: true, force: true });
fs.mkdirSync(TEMP, { recursive: true });

// id -> { nombre, tipo, ruta, creado }
const resultados = new Map();

setInterval(() => {
  const limite = Date.now() - VIDA_RESULTADO;
  for (const [id, r] of resultados) {
    if (r.creado < limite) {
      resultados.delete(id);
      fs.rm(r.ruta, { force: true }, () => {});
    }
  }
}, 60 * 1000).unref();

const app = express();
const subida = multer({
  dest: path.join(TEMP, 'entrada'),
  limits: { fileSize: MAX_ARCHIVO, files: MAX_ARCHIVOS },
});

app.use(express.static(path.join(__dirname, 'public')));

// --- Deteccion de formato por los bytes del archivo, no por la extension ---

const MARCAS_HEIC = ['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs'];
const MARCAS_AVIF = ['avif', 'avis', 'av01'];

function detectarFormato(cabecera) {
  const hex = cabecera.subarray(0, 16).toString('hex');
  const texto = cabecera.toString('latin1');

  if (hex.startsWith('89504e47')) return { tipo: 'png', etiqueta: 'PNG' };
  if (hex.startsWith('ffd8ff')) return { tipo: 'jpeg', etiqueta: 'JPEG' };
  if (hex.startsWith('47494638')) return { tipo: 'gif', etiqueta: 'GIF' };
  if (hex.startsWith('424d')) return { tipo: 'bmp', etiqueta: 'BMP' };
  if (hex.startsWith('49492a00') || hex.startsWith('4d4d002a')) {
    // Los RAW de Canon/Nikon/Sony se disfrazan de TIFF; sharp no los abre
    if (/CR2|NIKON|SONY/.test(texto)) return { tipo: 'raw', etiqueta: 'RAW' };
    return { tipo: 'tiff', etiqueta: 'TIFF' };
  }
  if (texto.startsWith('RIFF') && texto.slice(8, 12) === 'WEBP') return { tipo: 'webp', etiqueta: 'WEBP' };
  if (/^\s*(<\?xml|<svg)/i.test(texto)) return { tipo: 'svg', etiqueta: 'SVG' };

  if (texto.slice(4, 8) === 'ftyp') {
    // Las marcas de compatibilidad vienen despues de la principal
    const marcas = [];
    for (let i = 8; i + 4 <= cabecera.length; i += 4) marcas.push(texto.slice(i, i + 4));
    if (marcas.some((m) => MARCAS_AVIF.includes(m))) return { tipo: 'avif', etiqueta: 'AVIF' };
    if (marcas.some((m) => MARCAS_HEIC.includes(m))) return { tipo: 'heic', etiqueta: 'HEIC' };
    if (marcas.some((m) => m === 'qt  ' || m === 'mp42' || m === 'isom')) return { tipo: 'video', etiqueta: 'vídeo' };
    return { tipo: 'heic', etiqueta: 'HEIF' };
  }

  return { tipo: 'desconocido', etiqueta: 'desconocido' };
}

// --- Apertura de HEIC: libvips no trae el codec HEVC, se decodifica en JS ---

function girarSegunExif(img, orientacion, decodificadas, exif) {
  // libheif ya aplica los giros que vengan como propiedad del contenedor. Solo
  // aplicamos el EXIF si las dimensiones demuestran que aun no se ha girado.
  if (!orientacion || orientacion === 1) return img;

  const anchoExif = exif?.ExifImageWidth;
  const altoExif = exif?.ExifImageHeight;
  const giroDe90 = orientacion >= 5 && orientacion <= 8;

  if (giroDe90) {
    const yaGirada = anchoExif && altoExif
      && decodificadas.width === altoExif && decodificadas.height === anchoExif;
    if (yaGirada) return img;
    if (orientacion === 6) return img.rotate(90);
    if (orientacion === 8) return img.rotate(270);
    if (orientacion === 5) return img.flop().rotate(270);
    if (orientacion === 7) return img.flop().rotate(90);
  }

  // Los giros de 180 y los espejos no se pueden distinguir por dimensiones:
  // se dejan como los entrego libheif para no aplicarlos dos veces.
  return img;
}

async function abrirHeic(ruta) {
  const buffer = await fsp.readFile(ruta);
  const { width, height, data } = await decodificarHeic({ buffer });

  let img = sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), {
    raw: { width, height, channels: 4 },
  });

  const exif = await exifr.parse(buffer, { ifd0: true, exif: true, translateValues: false })
    .catch(() => null);
  img = girarSegunExif(img, exif?.Orientation, { width, height }, exif);

  return { img, formato: 'heic', ancho: width, alto: height, yaOrientada: true };
}

async function abrirNormal(ruta) {
  // density solo afecta a entradas vectoriales (SVG): mas resolucion al rasterizar
  const img = sharp(ruta, { density: 300, animated: false, failOn: 'none' });
  const meta = await img.metadata();
  return { img, formato: meta.format, ancho: meta.width, alto: meta.height, yaOrientada: false };
}

async function abrirImagen(ruta, deteccion) {
  if (deteccion.tipo === 'heic') return abrirHeic(ruta);
  try {
    return await abrirNormal(ruta);
  } catch (err) {
    // AVIF y otros contenedores ftyp que libvips rechace: segundo intento en JS
    if (deteccion.tipo === 'avif') return abrirHeic(ruta);
    throw err;
  }
}

async function convertir(archivo, opciones) {
  const { formato, calidad, ancho, alto, fondo } = opciones;

  const manejador = await fsp.open(archivo.path, 'r');
  const cabecera = Buffer.alloc(64);
  await manejador.read(cabecera, 0, 64, 0);
  await manejador.close();
  const deteccion = detectarFormato(cabecera);

  if (deteccion.tipo === 'raw') {
    throw Object.assign(new Error('Los RAW de cámara (CR2, NEF, ARW) no están soportados.'), { limpio: true });
  }
  if (deteccion.tipo === 'video') {
    throw Object.assign(new Error('Esto es un vídeo, no una imagen.'), { limpio: true });
  }

  const origen = await abrirImagen(archivo.path, deteccion);
  let img = origen.img;

  if (!origen.yaOrientada) img = img.rotate(); // auto-orienta segun EXIF

  if (ancho || alto) {
    img = img.resize({
      width: ancho || null,
      height: alto || null,
      fit: 'inside',
      withoutEnlargement: true,
    });
  }

  if (formato === 'jpeg') {
    // JPG no admite transparencia: se aplana sobre un color de fondo
    img = img.flatten({ background: fondo }).jpeg({ quality: calidad, mozjpeg: true });
  } else {
    // PNG: calidad guia la paleta/compresion sin perder el canal alfa
    img = img.png({ compressionLevel: 9, quality: calidad, effort: 7 });
  }

  const id = randomUUID();
  const nombre = nombreSalida(archivo.originalname, formato);
  const destino = path.join(TEMP, `${id}.${formato === 'jpeg' ? 'jpg' : 'png'}`);
  const info = await img.toFile(destino);

  resultados.set(id, {
    nombre,
    tipo: formato === 'jpeg' ? 'image/jpeg' : 'image/png',
    ruta: destino,
    creado: Date.now(),
  });

  return {
    ok: true,
    id,
    nombre,
    url: `/api/descargar/${id}`,
    origen: {
      formato: deteccion.etiqueta,
      bytes: archivo.size,
      ancho: origen.ancho,
      alto: origen.alto,
    },
    destino: { bytes: info.size, ancho: info.width, alto: info.height },
  };
}

function nombreSalida(original, formato) {
  const base = path.basename(original, path.extname(original)) || 'imagen';
  return `${base}.${formato === 'jpeg' ? 'jpg' : formato}`;
}

function mensajeError(err) {
  if (err && err.limpio) return err.message;
  const m = String((err && err.message) || err || 'Error desconocido');
  if (/unsupported image format|bad seek|VipsForeignLoad|buffer is not/i.test(m)) {
    return 'Formato no reconocido o archivo dañado.';
  }
  if (/memory|alloc|ENOMEM/i.test(m)) {
    return 'La imagen es demasiado grande para procesarla.';
  }
  return m.split('\n')[0];
}

// Procesa la cola con un tope de tareas simultaneas
async function enTanda(elementos, limite, tarea) {
  const salida = new Array(elementos.length);
  let siguiente = 0;
  const obreros = Array.from({ length: Math.min(limite, elementos.length) }, async () => {
    while (siguiente < elementos.length) {
      const i = siguiente++;
      salida[i] = await tarea(elementos[i], i);
    }
  });
  await Promise.all(obreros);
  return salida;
}

app.post('/api/convertir', subida.array('imagenes', MAX_ARCHIVOS), async (req, res) => {
  const archivos = req.files || [];
  if (archivos.length === 0) {
    return res.status(400).json({ error: 'No se ha recibido ninguna imagen.' });
  }

  const opciones = {
    formato: req.body.formato === 'jpg' ? 'jpeg' : 'png',
    calidad: Math.min(100, Math.max(1, parseInt(req.body.calidad, 10) || 85)),
    ancho: parseInt(req.body.ancho, 10) || 0,
    alto: parseInt(req.body.alto, 10) || 0,
    fondo: /^#[0-9a-f]{6}$/i.test(req.body.fondo || '') ? req.body.fondo : '#ffffff',
  };

  const items = await enTanda(archivos, EN_PARALELO, async (archivo) => {
    try {
      return await convertir(archivo, opciones);
    } catch (err) {
      console.error(`[fallo] ${archivo.originalname}:`, err.message);
      return { ok: false, nombre: archivo.originalname, error: mensajeError(err) };
    } finally {
      fs.rm(archivo.path, { force: true }, () => {});
    }
  });

  res.json({ items });
});

app.get('/api/descargar/:id', (req, res) => {
  const r = resultados.get(req.params.id);
  if (!r) return res.status(404).send('El archivo ya no está disponible (caduca a los 30 min).');
  res.setHeader('Content-Type', r.tipo);
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(r.nombre)}"`);
  fs.createReadStream(r.ruta).pipe(res);
});

app.get('/api/zip', (req, res) => {
  const ids = String(req.query.ids || '').split(',').filter(Boolean);
  const disponibles = ids.map((id) => resultados.get(id)).filter(Boolean);
  if (disponibles.length === 0) return res.status(404).send('No hay archivos disponibles.');

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="imagenes-convertidas.zip"');

  const zip = archiver('zip', { zlib: { level: 6 } });
  zip.on('error', () => res.end());
  zip.pipe(res);

  const usados = new Map();
  for (const r of disponibles) {
    // evita colisiones si dos originales tenian el mismo nombre
    const n = (usados.get(r.nombre) || 0) + 1;
    usados.set(r.nombre, n);
    const nombre = n === 1 ? r.nombre
      : `${path.basename(r.nombre, path.extname(r.nombre))}-${n}${path.extname(r.nombre)}`;
    zip.file(r.ruta, { name: nombre });
  }
  zip.finalize();
});

// Errores de multer (tamaño, numero de archivos)
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const texto = err.code === 'LIMIT_FILE_SIZE'
      ? `Archivo demasiado grande (máximo ${MAX_ARCHIVO / 1024 / 1024} MB).`
      : err.code === 'LIMIT_FILE_COUNT'
        ? `Demasiados archivos (máximo ${MAX_ARCHIVOS} por lote).`
        : err.message;
    return res.status(413).json({ error: texto });
  }
  console.error(err);
  res.status(500).json({ error: 'Error interno del servidor.' });
});

// Si no se fuerza un puerto con la variable PORT, busca el primero libre a
// partir del 3000. Asi la direccion es estable entre arranques aunque otro
// programa (Docker, por ejemplo) tenga cogido el 3000.
function arrancar(puerto, intentosRestantes) {
  const servidor = app.listen(puerto, () => {
    // Dentro de Docker el puerto de dentro no es el que usa el navegador
    const direccion = process.env.URL_PUBLICA || `http://localhost:${puerto}`;
    console.log(`\n  Transformador de imágenes -> ${direccion}\n`);
  });
  servidor.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && intentosRestantes > 0) {
      console.log(`  (el puerto ${puerto} está ocupado, probando el ${puerto + 1})`);
      arrancar(puerto + 1, intentosRestantes - 1);
    } else {
      console.error(`No se ha podido abrir el puerto ${puerto}:`, err.message);
      process.exit(1);
    }
  });
}

arrancar(Number(PUERTO), process.env.PORT ? 0 : 20);
