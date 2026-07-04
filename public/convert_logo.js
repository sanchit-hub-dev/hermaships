const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const jpeg = require('jpeg-js');

const jpegPath = path.join(__dirname, 'WhatsApp Image 2026-07-02 at 5.37.48 PM.jpeg');
const pngPath = path.join(__dirname, 'coral_logo_transparent.PNG');

try {
  // Read JPEG
  const jpegData = fs.readFileSync(jpegPath);
  const rawImageData = jpeg.decode(jpegData);
  
  // Convert to PNG
  const png = new PNG({ width: rawImageData.width, height: rawImageData.height });
  
  // Process pixels - convert white/near-white to transparent
  const whiteThreshold = 200;
  for (let i = 0; i < rawImageData.data.length; i += 4) {
    const r = rawImageData.data[i];
    const g = rawImageData.data[i + 1];
    const b = rawImageData.data[i + 2];
    
    // If all RGB channels are >= threshold, make transparent
    if (r >= whiteThreshold && g >= whiteThreshold && b >= whiteThreshold) {
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = 0; // fully transparent
    } else {
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = 255; // fully opaque
    }
  }
  
  // Write PNG
  png.pack().pipe(fs.createWriteStream(pngPath))
    .on('finish', () => {
      console.log('✓ Logo converted to transparent PNG:', pngPath);
      console.log('Size:', fs.statSync(pngPath).size, 'bytes');
    })
    .on('error', (err) => {
      console.error('Write error:', err);
      process.exit(1);
    });
} catch (err) {
  console.error('Error:', err.message);
  process.exit(1);
}
