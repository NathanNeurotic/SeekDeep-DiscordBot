// Pure leaf helpers extracted from index.js (no Discord/Client/shared state):
// image-MIME classification from extension, declared content-type, or magic bytes.
export function seekdeepImageMimeFromExtension(value = '') {
  const text = String(value || '').toLowerCase().split(/[?#]/, 1)[0];
  if (/\.png$/.test(text)) return 'image/png';
  if (/\.jpe?g$/.test(text)) return 'image/jpeg';
  if (/\.gif$/.test(text)) return 'image/gif';
  if (/\.webp$/.test(text)) return 'image/webp';
  if (/\.bmp$/.test(text)) return 'image/bmp';
  if (/\.(tif|tiff)$/.test(text)) return 'image/tiff';
  if (/\.avif$/.test(text)) return 'image/avif';
  return '';
}

export function seekdeepNormalizeImageMime(value = '') {
  const mime = String(value || '').split(';', 1)[0].trim().toLowerCase();
  if (mime === 'image/jpg') return 'image/jpeg';
  return mime;
}

export function seekdeepDetectImageMime(buffer) {
  const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && (b.slice(0, 6).toString('ascii') === 'GIF87a' || b.slice(0, 6).toString('ascii') === 'GIF89a')) return 'image/gif';
  if (b.length >= 12 && b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  if (b.length >= 4 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a))) return 'image/tiff';
  if (b.length >= 12 && b.slice(4, 8).toString('ascii') === 'ftyp' && /^(?:avif|avis|mif1|heic|heix|hevc|hevx)$/.test(b.slice(8, 12).toString('ascii'))) return 'image/avif';
  return '';
}

export function seekdeepIsSupportedImageMime(mime = '') {
  return new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/tiff', 'image/avif']).has(seekdeepNormalizeImageMime(mime));
}
