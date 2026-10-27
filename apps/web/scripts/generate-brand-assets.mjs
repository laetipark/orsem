import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

// Keep every icon derived from the praying hands and ascending bars used by the header and footer.
// Run `npm run brand:generate -w @orsem/web` after editing the source SVG, then
// update the public icon URL version in index.html, both manifests, and sw.js.
const webRoot = new URL('../', import.meta.url);
const source = await readFile(new URL('src/assets/orsem-mark.svg', webRoot), 'utf8');
const sourceViewBox = source.match(/viewBox="([^"]+)"/)?.[1];
const bounds = sourceViewBox?.split(/\s+/).map(Number);
if (!bounds || bounds.length !== 4 || bounds.some((value) => !Number.isFinite(value))) {
  throw new Error('The brand source must define a numeric SVG viewBox.');
}
const [left, top, width, height] = bounds;
if (width <= 0 || height <= 0)
  throw new Error('The brand source viewBox must have positive dimensions.');
const centerX = left + width / 2;
const centerY = top + height / 2;
const background = '#091012';

function squareSvg(side, opaque = false) {
  const x = centerX - side / 2;
  const y = centerY - side / 2;
  const square = source.replace(/viewBox="[^"]+"/, `viewBox="${x} ${y} ${side} ${side}"`);
  return opaque
    ? square.replace(
        /(<svg\b[^>]*>)/,
        `$1\n  <rect x="${x}" y="${y}" width="${side}" height="${side}" fill="${background}"/>`,
      )
    : square;
}

// The source paths, gradients, and proportions remain untouched. Favicon and
// in-app icon use a tight square; installed icons add breathing room.
const favicon = squareSvg(Math.max(width, height));
const installed = squareSvg(Math.max(width, height) / 0.88, true);
// Fit the complete source rectangle inside the central 80%-diameter safe circle.
// This preserves the complete hands and ascending bars under circular and rounded launchers.
const maskable = squareSvg(Math.hypot(width, height) / 0.8, true);
const outputs = new Map([
  ['src/assets/orsem-icon.svg', Buffer.from(favicon)],
  ['public/favicon.svg', Buffer.from(favicon)],
]);

for (const [name, size, svg] of [
  ['icon-192.png', 192, installed],
  ['icon-512.png', 512, installed],
  ['icon-maskable-512.png', 512, maskable],
  ['apple-touch-icon.png', 180, installed],
]) {
  outputs.set(
    `public/icons/${name}`,
    await sharp(Buffer.from(svg), { density: 192 })
      .resize(size, size)
      .flatten({ background })
      .png({ compressionLevel: 9 })
      .toBuffer(),
  );
}

const check = process.argv.includes('--check');
for (const [path, contents] of outputs) {
  const destination = new URL(path, webRoot);
  if (check) {
    const current = await readFile(destination);
    if (!current.equals(contents)) {
      throw new Error(`Brand asset is out of date: ${fileURLToPath(destination)}`);
    }
  } else {
    await writeFile(destination, contents);
  }
}
console.log(
  `${check ? 'Verified' : 'Generated'} ${outputs.size} brand assets from orsem-mark.svg.`,
);
