// Filesystem-backed library model for the hdr.toys host-gallery protocol.
//
// An "asset" is one image file in the served root directory (recursively). Its
// opaque `image_id` is the URL-safe base64 of its path *relative to the root*,
// so ids are stable across restarts and never leak absolute paths. Recipes and
// rendered exports are written into a sibling `.hdrtoys/` sidecar folder inside
// the root, keyed by that same id — never mutating the originals.
//
// This implements the protocol's "minimum self-hostable subset" (§6) plus the
// streaming gallery list API (§3.1/§3.2), entirely against the local disk.

import { promises as fs } from 'node:fs';
import path from 'node:path';

// Supported source extensions (protocol §4.4). Lowercase, no dot.
const RASTER_EXT = new Set(['jpg', 'jpeg', 'jpe', 'png', 'webp', 'avif', 'gif']);
const EXR_EXT = new Set(['exr']);
const RAW_EXT = new Set([
    'cr2', 'cr3', 'nef', 'nrw', 'arw', 'dng', 'orf', 'rw2', 'rwl', 'pef',
    'srw', 'kdc', 'dcr', 'mrw', '3fr', 'iiq', 'crw', 'raf', 'x3f',
]);

const MIME_BY_EXT = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg',
    png: 'image/png', webp: 'image/webp', avif: 'image/avif', gif: 'image/gif',
    exr: 'image/x-exr',
};

/** The sidecar folder (inside the library root) where recipes/renders live. */
export const SIDECAR_DIR = '.hdrtoys';

function extOf(name) {
    const dot = name.lastIndexOf('.');
    return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** True if this filename is a source type hdr.toys can ingest (§4.4). */
export function isSupportedImage(name) {
    const ext = extOf(name);
    return RASTER_EXT.has(ext) || EXR_EXT.has(ext) || RAW_EXT.has(ext);
}

/** Protocol `kind` for an asset (§3.1). RAW/EXR are first-class; rest is jpeg/png. */
export function kindOf(name) {
    const ext = extOf(name);
    if (RAW_EXT.has(ext)) return 'raw';
    if (EXR_EXT.has(ext)) return 'exr';
    if (ext === 'png') return 'png';
    // UltraHDR is a JPEG with an embedded gain map; we can't cheaply detect the
    // map without parsing, so JPEGs report "jpeg". hdr.toys still extracts the
    // gain map on ingest if present.
    return 'jpeg';
}

/** Best-effort Content-Type for serving raw bytes. RAW types are octet-stream
 *  (hdr.toys sniffs/recognizes by extension via Content-Disposition). */
export function mimeOf(name) {
    return MIME_BY_EXT[extOf(name)] ?? 'application/octet-stream';
}

// --- id <-> relative-path codec (URL-safe base64, opaque to the editor) ---

export function encodeId(relPath) {
    // Always use POSIX separators inside the id so Windows and Unix produce the
    // same id for the same logical asset.
    const posix = relPath.split(path.sep).join('/');
    return Buffer.from(posix, 'utf8').toString('base64url');
}

export function decodeId(id) {
    const posix = Buffer.from(id, 'base64url').toString('utf8');
    // Reject traversal: a decoded path must stay inside the root.
    if (posix.split('/').some((seg) => seg === '..')) return null;
    return posix.split('/').join(path.sep);
}

/** Resolve an asset id to an absolute on-disk path, guarding against escape. */
export function resolveAssetPath(root, id) {
    const rel = decodeId(id);
    if (rel === null) return null;
    const abs = path.resolve(root, rel);
    const rootResolved = path.resolve(root);
    // Containment check: abs must be the root or under it.
    if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) return null;
    return abs;
}

/** Recursively list supported images under root, skipping the sidecar folder
 *  and dotfiles/dot-dirs. Returns sorted relative POSIX-ish paths. */
export async function scanLibrary(root) {
    const out = [];
    async function walk(dir, rel) {
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
            return; // unreadable dir — skip rather than fail the whole scan
        }
        for (const entry of entries) {
            if (entry.name.startsWith('.')) continue; // skip dotfiles + .hdrtoys
            const childRel = rel ? path.join(rel, entry.name) : entry.name;
            if (entry.isDirectory()) {
                await walk(path.join(dir, entry.name), childRel);
            } else if (entry.isFile() && isSupportedImage(entry.name)) {
                out.push(childRel);
            }
        }
    }
    await walk(root, '');
    out.sort((a, b) => a.localeCompare(b));
    return out;
}

/** Build a protocol asset descriptor (§3.1 shape) for one relative path.
 *  `origin` is the public base URL (e.g. http://host:4317) used to form the
 *  absolute rawUrl/recipeUrl the editor will fetch. `sidecarRoot` is where
 *  recipes/renders live (may be outside `root`, e.g. for a Photos library). */
export async function describeAsset(root, relPath, origin, sidecarRoot) {
    const id = encodeId(relPath);
    const abs = path.resolve(root, relPath);
    let stat;
    try {
        stat = await fs.stat(abs);
    } catch {
        return null;
    }
    const name = path.basename(relPath, path.extname(relPath));
    const recipePath = recipeFilePath(sidecarRoot, id);
    let editedByHdrToys = false;
    try {
        await fs.access(recipePath);
        editedByHdrToys = true;
    } catch { /* no recipe yet */ }

    return {
        id,
        name,
        // No server-side thumbnailer (zero-dep): the editor falls back to the
        // full-res rawUrl for previews. A real deployment can add a thumb route.
        thumbnailUrl: `${origin}/assets/${id}/raw`,
        rawUrl: `${origin}/assets/${id}/raw`,
        recipeUrl: `${origin}/assets/${id}/recipe`,
        kind: kindOf(relPath),
        hasGainMap: false, // unknown without parsing; conservative default
        capturedAt: stat.mtime.toISOString(),
        editedByHdrToys,
        bytes: stat.size,
    };
}

// --- sidecar (recipe + render) storage ---
//
// `sidecarRoot` is the absolute folder that holds recipes/renders. For a plain
// served folder it is `<root>/.hdrtoys` (see defaultSidecarRoot); for a macOS
// Photos library it lives *outside* the package so the library is never
// mutated (see photos.js). All sidecar functions take it explicitly.

/** Default sidecar location for a plainly-served folder: `<root>/.hdrtoys`. */
export function defaultSidecarRoot(root) {
    return path.join(root, SIDECAR_DIR);
}

export function recipeFilePath(sidecarRoot, id) {
    return path.join(sidecarRoot, `${id}.recipe.json`);
}

export function renderDirPath(sidecarRoot, id) {
    return path.join(sidecarRoot, `${id}.renders`);
}

/** Persist the latest recipe for an asset, enforcing seq monotonicity (§2.4):
 *  a snapshot with seq <= the stored seq (for the same clientId) is ignored. */
export async function saveRecipe(sidecarRoot, id, envelope) {
    const file = recipeFilePath(sidecarRoot, id);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const incomingSeq = Number(envelope?.seq ?? 0);
    const incomingClient = envelope?.clientId ?? null;
    try {
        const prevRaw = await fs.readFile(file, 'utf8');
        const prev = JSON.parse(prevRaw);
        if (
            prev?.clientId === incomingClient &&
            Number(prev?.seq ?? -1) >= incomingSeq
        ) {
            return { stored: false, reason: 'stale-seq' };
        }
    } catch { /* no prior recipe, or unparseable — overwrite */ }
    await fs.writeFile(file, JSON.stringify(envelope, null, 2), 'utf8');
    return { stored: true };
}

/** Read the stored recipe envelope for an asset, or null if none. */
export async function loadRecipe(sidecarRoot, id) {
    try {
        const raw = await fs.readFile(recipeFilePath(sidecarRoot, id), 'utf8');
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

/** Save a rendered image into the sidecar (§2.2). Returns the written path. */
export async function saveRender(sidecarRoot, id, fileName, bytes) {
    const dir = renderDirPath(sidecarRoot, id);
    await fs.mkdir(dir, { recursive: true });
    // Sanitize the suggested filename to a single path segment.
    const safe = path.basename(fileName || 'render.jpg').replace(/[^\w.\-]+/g, '_');
    const out = path.join(dir, safe);
    await fs.writeFile(out, bytes);
    return out;
}
