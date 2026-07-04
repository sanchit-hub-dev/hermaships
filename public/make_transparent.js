const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const inPath = path.join(__dirname, 'coral_logo_transparent.PNG');
const outPath = path.join(__dirname, 'coral_logo_transparent.PNG');

if (!fs.existsSync(inPath)) {
  console.error('Source PNG not found:', inPath);
  process.exit(1);
}

const data = fs.readFileSync(inPath);
const png = PNG.sync.read(data);
const { width, height, data: pixels } = png;

// Thresholds
const whiteThreshold = 180; // pixel value >= this considered white (more aggressive - lowered to catch light grays)
const alphaThreshold = 5; // if already mostly transparent, skip

for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const idx = (width * y + x) << 2;
    const r = pixels[idx];
    const g = pixels[idx + 1];
    const b = pixels[idx + 2];
    const a = pixels[idx + 3];

    // If pixel is near-white and not already transparent, make it transparent
    if (a > alphaThreshold && r >= whiteThreshold && g >= whiteThreshold && b >= whiteThreshold) {
      pixels[idx + 3] = 0;
    }
  }
}

const outBuf = PNG.sync.write(png);
fs.writeFileSync(outPath, outBuf);
console.log('Wrote transparent PNG:', outPath, outBuf.length);
