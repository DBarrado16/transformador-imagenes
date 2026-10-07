// Genera los iconos de la aplicacion a partir de public/icono-original.jpg.
// Ejecutar con: node generar-iconos.cjs
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const pngAIco = require('png-to-ico');

const ORIGEN = path.join(__dirname, 'public', 'icono-original.jpg');
const DESTINO = path.join(__dirname, 'public');

// A tamaños pequeños el detalle se empasta, asi que se afila al reducir
function escalar(tam) {
  return sharp(ORIGEN)
    .resize(tam, tam, { fit: 'cover', kernel: 'lanczos3' })
    .sharpen({ sigma: tam <= 48 ? 1.2 : 0.6 })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

(async () => {
  const tamanos = [16, 32, 48, 180, 192, 512];
  const buffers = {};
  for (const t of tamanos) buffers[t] = await escalar(t);

  fs.writeFileSync(path.join(DESTINO, 'icono-192.png'), buffers[192]);
  fs.writeFileSync(path.join(DESTINO, 'icono-512.png'), buffers[512]);
  fs.writeFileSync(path.join(DESTINO, 'apple-touch-icon.png'), buffers[180]);

  const ico = await pngAIco([buffers[16], buffers[32], buffers[48]]);
  fs.writeFileSync(path.join(DESTINO, 'favicon.ico'), ico);

  for (const f of ['favicon.ico', 'icono-192.png', 'icono-512.png', 'apple-touch-icon.png']) {
    console.log(f.padEnd(22), fs.statSync(path.join(DESTINO, f)).size, 'bytes');
  }
})();
