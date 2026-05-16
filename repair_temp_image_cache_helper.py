from pathlib import Path
import re
from datetime import datetime

path = Path("index.js")
text = path.read_text(encoding="utf-8")

stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
backup = Path(f"index.js.bak-temp-cache-helper-repair-{stamp}")
backup.write_text(text, encoding="utf-8")
print(f"[SeekDeep] Backup written: {backup}")

helper = r'''
// SEEKDEEP_TEMP_IMAGE_CACHE_START
const seekdeepTempImageStateIndex = globalThis.__seekdeepTempImageStateIndex || new Map();
globalThis.__seekdeepTempImageStateIndex = seekdeepTempImageStateIndex;

const SEEKDEEP_IMAGE_CACHE_TTL_HOURS = Math.max(1, Number(process.env.SEEKDEEP_IMAGE_CACHE_TTL_HOURS || 24));
const SEEKDEEP_IMAGE_CACHE_TTL_MS = SEEKDEEP_IMAGE_CACHE_TTL_HOURS * 60 * 60 * 1000;
const SEEKDEEP_IMAGE_CACHE_DIR = path.join(__dirname, 'temp', 'image-cache');

function seekdeepEnsureImageCacheDir() {
  if (!fs.existsSync(SEEKDEEP_IMAGE_CACHE_DIR)) {
    fs.mkdirSync(SEEKDEEP_IMAGE_CACHE_DIR, { recursive: true });
  }
}

function seekdeepSafeImageFilename(name = 'seekdeep_image.png') {
  const cleaned = String(name || 'seekdeep_image.png')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, '_')
    .trim();

  return cleaned || 'seekdeep_image.png';
}

function seekdeepMakeImageActionId() {
  return `img_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function seekdeepImageCacheMetaPath(id) {
  return path.join(SEEKDEEP_IMAGE_CACHE_DIR, `${id}.json`);
}

function seekdeepImageCacheBinaryPath(id, filename = 'seekdeep_image.png') {
  const safe = seekdeepSafeImageFilename(filename);
  const ext = path.extname(safe) || '.png';
  return path.join(SEEKDEEP_IMAGE_CACHE_DIR, `${id}${ext}`);
}

function seekdeepNormalizeGeneratedImageResult(result) {
  const attachmentLike = result?.attachment || result?.file || result?.builder || null;

  let buffer =
    result?.buffer ||
    result?.fileBuffer ||
    result?.imageBuffer ||
    null;

  let filename =
    result?.filename ||
    result?.name ||
    attachmentLike?.name ||
    attachmentLike?.data?.name ||
    'seekdeep_image.png';

  if (!buffer && Buffer.isBuffer(attachmentLike?.attachment)) {
    buffer = attachmentLike.attachment;
  }

  if (!buffer && Buffer.isBuffer(result)) {
    buffer = result;
  }

  if (!buffer && typeof result?.image_b64 === 'string' && result.image_b64.length > 0) {
    buffer = Buffer.from(result.image_b64, 'base64');
  }

  if (!buffer || !Buffer.isBuffer(buffer)) {
    throw new Error('Generated image result did not include a usable Buffer.');
  }

  const attachment = attachmentLike || new AttachmentBuilder(buffer, { name: seekdeepSafeImageFilename(filename) });

  return {
    buffer,
    filename: seekdeepSafeImageFilename(filename),
    attachment,
  };
}

function seekdeepRememberTempImageState(state) {
  seekdeepEnsureImageCacheDir();

  const createdAt = Number(state?.createdAt || Date.now());
  const expiresAt = Number(state?.expiresAt || (createdAt + SEEKDEEP_IMAGE_CACHE_TTL_MS));
  const id = String(state?.id || seekdeepMakeImageActionId());
  const filename = seekdeepSafeImageFilename(state?.filename || 'seekdeep_image.png');
  const binaryPath = seekdeepImageCacheBinaryPath(id, filename);
  const metaPath = seekdeepImageCacheMetaPath(id);

  if (!state?.buffer || !Buffer.isBuffer(state.buffer)) {
    throw new Error('Temp image cache cannot persist a state without a Buffer.');
  }

  fs.writeFileSync(binaryPath, state.buffer);

  const meta = {
    id,
    prompt: state?.prompt || '',
    width: Number(state?.width || 1024),
    height: Number(state?.height || 1024),
    seed: state?.seed ?? null,
    filename,
    binaryPath,
    createdAt,
    expiresAt,
    mimeType: state?.mimeType || 'image/png',
  };

  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');

  const liveState = {
    ...meta,
    buffer: state.buffer,
  };

  seekdeepTempImageStateIndex.set(id, liveState);
  return liveState;
}

function seekdeepDeleteTempImageState(id, meta = null) {
  try {
    const state = meta || seekdeepTempImageStateIndex.get(id) || null;
    seekdeepTempImageStateIndex.delete(id);

    const metaPath = seekdeepImageCacheMetaPath(id);
    if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);

    const binaryPath = state?.binaryPath;
    if (binaryPath && fs.existsSync(binaryPath)) {
      fs.unlinkSync(binaryPath);
      return;
    }

    try {
      const files = fs.readdirSync(SEEKDEEP_IMAGE_CACHE_DIR);
      for (const file of files) {
        if (file.startsWith(`${id}.`)) {
          const full = path.join(SEEKDEEP_IMAGE_CACHE_DIR, file);
          if (fs.existsSync(full)) fs.unlinkSync(full);
        }
      }
    } catch {}
  } catch (err) {
    console.warn('Could not delete expired temp image cache entry:', err?.message || err);
  }
}

function seekdeepLoadTempImageState(id) {
  seekdeepEnsureImageCacheDir();

  const now = Date.now();
  const live = seekdeepTempImageStateIndex.get(id);

  if (live) {
    if (Number(live.expiresAt || 0) <= now) {
      seekdeepDeleteTempImageState(id, live);
      return null;
    }

    if (live.buffer && Buffer.isBuffer(live.buffer)) return live;
  }

  const metaPath = seekdeepImageCacheMetaPath(id);
  if (!fs.existsSync(metaPath)) return null;

  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));

    if (Number(meta?.expiresAt || 0) <= now) {
      seekdeepDeleteTempImageState(id, meta);
      return null;
    }

    if (!meta?.binaryPath || !fs.existsSync(meta.binaryPath)) {
      seekdeepDeleteTempImageState(id, meta);
      return null;
    }

    const buffer = fs.readFileSync(meta.binaryPath);
    const state = { ...meta, buffer };

    seekdeepTempImageStateIndex.set(id, state);
    return state;
  } catch (err) {
    console.warn('Could not load temp image state from disk:', err?.message || err);
    return null;
  }
}

function seekdeepSweepExpiredImageCache() {
  seekdeepEnsureImageCacheDir();

  const now = Date.now();

  for (const [id, state] of seekdeepTempImageStateIndex.entries()) {
    if (Number(state?.expiresAt || 0) <= now) {
      seekdeepDeleteTempImageState(id, state);
    }
  }

  try {
    const files = fs.readdirSync(SEEKDEEP_IMAGE_CACHE_DIR).filter((f) => f.endsWith('.json'));

    for (const file of files) {
      const full = path.join(SEEKDEEP_IMAGE_CACHE_DIR, file);

      try {
        const meta = JSON.parse(fs.readFileSync(full, 'utf8'));
        if (Number(meta?.expiresAt || 0) <= now) {
          seekdeepDeleteTempImageState(String(meta?.id || path.basename(file, '.json')), meta);
        }
      } catch {
        try { fs.unlinkSync(full); } catch {}
      }
    }
  } catch (err) {
    console.warn('Could not sweep temp image cache:', err?.message || err);
  }
}

seekdeepEnsureImageCacheDir();
seekdeepSweepExpiredImageCache();

const __seekdeepImageCacheSweepTimer = setInterval(() => {
  try {
    seekdeepSweepExpiredImageCache();
  } catch (err) {
    console.warn('Temp image cache sweep interval failed:', err?.message || err);
  }
}, 30 * 60 * 1000);

if (typeof __seekdeepImageCacheSweepTimer?.unref === 'function') {
  __seekdeepImageCacheSweepTimer.unref();
}
// SEEKDEEP_TEMP_IMAGE_CACHE_END
'''

if "SEEKDEEP_TEMP_IMAGE_CACHE_START" in text:
    text = re.sub(
        r"(?s)// SEEKDEEP_TEMP_IMAGE_CACHE_START.*?// SEEKDEEP_TEMP_IMAGE_CACHE_END\s*",
        helper + "\n\n",
        text,
    )
    print("[SeekDeep] Replaced existing temp image cache helper block.")
else:
    anchor = "function seekdeepArchiveImageStateToDisk(state) {"
    if anchor not in text:
        raise SystemExit("Could not find seekdeepArchiveImageStateToDisk anchor.")

    text = text.replace(anchor, helper + "\n\n" + anchor, 1)
    print("[SeekDeep] Inserted missing temp image cache helper block.")

required = [
    "seekdeepTempImageStateIndex",
    "seekdeepNormalizeGeneratedImageResult",
    "seekdeepRememberTempImageState",
    "seekdeepLoadTempImageState",
    "SEEKDEEP_IMAGE_CACHE_DIR",
]

missing = [item for item in required if item not in text]
if missing:
    raise SystemExit("Still missing: " + ", ".join(missing))

path.write_text(text, encoding="utf-8")
print("[SeekDeep] Temp cache helper repair written.")
