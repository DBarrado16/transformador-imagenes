# Transformador de imágenes

Conversor local de imágenes a **PNG** o **JPG**. El servidor corre en tu ordenador:
las imágenes no salen de tu máquina.

## Uso

```
npm install     # solo la primera vez
npm start
```

Al arrancar, el servidor escribe en la consola la dirección exacta. Busca el primer
puerto libre a partir del 3000, así que en esta máquina cae en
**http://localhost:3002** (Docker ocupa el 3000 y el 3001).

Para fijar el puerto tú mismo: `PORT=4000 npm start`.

Arrastra las imágenes, elige formato y pulsa **Convertir**. Con varios archivos
aparece también un botón para descargarlos todos en un `.zip`.

## Formatos de entrada

Soportados: **JPEG, PNG, WEBP, AVIF, TIFF, GIF, SVG, HEIC/HEIF** (los HEIC del iPhone
se decodifican con `heic-decode`, porque el `libvips` que trae `sharp` no incluye
el códec HEVC).

No soportados: RAW de cámara (CR2, NEF, ARW, DNG). Para esos hace falta
`dcraw`/`libraw` o exportarlos antes desde el programa de la cámara.

De GIF y TIFF multipágina se convierte el primer fotograma.

## Opciones

| Opción | Qué hace |
| --- | --- |
| Formato | PNG (conserva transparencia) o JPG (más ligero) |
| Calidad | 1-100. En JPG controla la compresión; en PNG, la paleta |
| Fondo | Color con el que se rellena la transparencia al pasar a JPG |
| Ancho / Alto máx. | Reduce la imagen sin deformarla y sin ampliarla nunca |

Las imágenes se auto-orientan según su EXIF, así que las fotos de móvil no salen tumbadas.

## Límites

- 60 archivos por lote, 200 MB por archivo, 3 conversiones simultáneas.
- Los resultados se guardan en la carpeta temporal del sistema y se borran a los 30
  minutos (y al arrancar el servidor).
- Un HEIC de 24 MP tarda ~1,5 s en convertirse. A PNG pesa mucho más que a JPG:
  para fotos, usa JPG.

## Archivos

- `server.js` — servidor Express + conversión con [sharp](https://sharp.pixelplumbing.com/)
- `public/index.html` — interfaz (una sola página, sin dependencias)

## Icono

El icono sale de `public/icono-original.jpg`. Si lo cambias, regenera los tamaños con:

```
node generar-iconos.cjs
```

Eso escribe `favicon.ico` (16/32/48), `icono-192.png`, `icono-512.png` y
`apple-touch-icon.png` dentro de `public/`.

## Ejecutar con Docker

El contenedor se levanta con:

```
docker compose up -d
```

Queda en **http://localhost:3002** y aparece en Docker Desktop como
`transformador-imagenes`. Lleva `restart: unless-stopped`, así que vuelve solo
cada vez que arranca Docker; no hace falta lanzarlo a mano.

Comandos útiles:

| Acción | Comando |
| --- | --- |
| Parar | `docker compose stop` |
| Volver a arrancar | `docker compose start` |
| Ver el log | `docker compose logs -f` |
| Aplicar cambios del código | `docker compose up -d --build` |
| Borrarlo del todo | `docker compose down` |

Dentro del contenedor la app escucha en el 3000; el 3002 es el puerto de fuera,
elegido para no chocar con los contenedores que ya usan el 3000 y el 3001.
