const fs = require('fs');
const zlib = require('zlib');

const width = 128;
const height = 128;
const stride = width * 4 + 1;
const pixels = Buffer.alloc(stride * height);

for (let y = 0; y < height; y++) {
  const rowStart = y * stride;
  pixels[rowStart] = 0; // filter byte

  for (let x = 0; x < width; x++) {
    const idx = rowStart + 1 + x * 4;
    let r = 0, g = 0, b = 0, a = 0;

    const dx = x - 64;
    const dy = y - 44;
    if (dx * dx + dy * dy < 24 * 24) {
      r = 255;
      g = 155;
      b = 0;
      a = 255;
    }

    const wave = Math.sin((x / width) * Math.PI * 2 + y / 10) * 14;
    if (y > 74 && y < 94 && Math.abs(y - 84 - wave) < 7) {
      r = 0;
      g = 160;
      b = 220;
      a = 220;
    }
    if (y > 88 && y < 108 && Math.abs(y - 98 - wave * 0.6) < 6) {
      r = 0;
      g = 120;
      b = 195;
      a = 220;
    }
    if (y > 100 && y < 118 && Math.abs(y - 110 - wave * 0.4) < 5) {
      r = 0;
      g = 85;
      b = 175;
      a = 220;
    }

    pixels[idx] = r;
    pixels[idx + 1] = g;
    pixels[idx + 2] = b;
    pixels[idx + 3] = a;
  }
}

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(buf) {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcBuf), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(width, 0);
ihdr.writeUInt32BE(height, 4);
ihdr[8] = 8;
ihdr[9] = 6;
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const idat = zlib.deflateSync(pixels);
const png = Buffer.concat([pngSignature, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
const targetPath = require('path').join(__dirname, 'public', 'coral_logo_transparent.png');
fs.writeFileSync(targetPath, png);
console.log('wrote', targetPath, png.length, 'bytes');
