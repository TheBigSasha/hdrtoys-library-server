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

// Persisted edit-thumbnail suffix (full-filename form). After a library image is
// opened/edited, the freshest small preview is written BESIDE the original as
// `<sourceFilename>.edit_thumbnail.jpg` — the whole suffix appends to the WHOLE
// filename INCLUDING its extension, so a RAW+JPEG stem pair (IMG.ARW / IMG.JPG)
// can never collide on one sidecar (naming law, ultrahdrutil #783 / PR #608 F8).
// e.g. IMG_5501.ARW → IMG_5501.ARW.edit_thumbnail.jpg.
//
// Exclusion law (ultrahdrutil #798): a persisted edit thumbnail is a Layer-6
// disposable T1 artifact, NEVER an ingestable asset — the folder scan must skip
// it (see scanLibrary) so it can't show up in the filmstrip as its own photo.
export const EDIT_THUMBNAIL_SUFFIX = '.edit_thumbnail.jpg';

/** True if `name` is a persisted edit-thumbnail sidecar (case-insensitive suffix
 *  match; a bare `.edit_thumbnail.jpg` with an empty base name matches too). */
export function isEditThumbnailSidecar(name) {
    return name.toLowerCase().endsWith(EDIT_THUMBNAIL_SUFFIX);
}

function extOf(name) {
    const dot = name.lastIndexOf('.');
    return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** True if this filename is a source type hdr.toys can ingest (§4.4). */
export function isSupportedImage(name) {
    const ext = extOf(name);
    return RASTER_EXT.has(ext) || EXR_EXT.has(ext) || RAW_EXT.has(ext);
}

/** True if this is a RAW camera file (needs embedded-preview extraction to show
 *  a thumbnail, since a browser <img> can't decode the raw sensor data). */
export function isRawImage(name) {
    return RAW_EXT.has(extOf(name));
}

/** True if a browser <img> can render the original bytes directly (so the
 *  thumbnail can just be the file itself). EXR is excluded — it needs tone
 *  mapping the browser won't do. */
export function isRenderableRaster(name) {
    return RASTER_EXT.has(extOf(name));
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
            } else if (entry.isFile() && isSupportedImage(entry.name) && !isEditThumbnailSidecar(entry.name)) {
                // Skip persisted edit-thumbnail sidecars — they're .jpg (a supported
                // type) but they are previews OF an asset, not assets (ultrahdrutil
                // #798 exclusion law). Orphans (no matching source) are dropped here
                // too: unlisted → never served, so they're ignored entirely.
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
export async function describeAsset(root, relPath, origin, sidecarRoot, token) {
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

    // When a token is configured, bake it into the asset URLs as a query param.
    // The editor loads thumbnails via <img src> and downloads via plain GETs that
    // can't carry an Authorization header, so the token has to travel in the URL
    // (checkAuth accepts ?gallery_token=). Safe for a local, user-launched server.
    const q = token ? `?gallery_token=${encodeURIComponent(token)}` : '';
    return {
        id,
        name,
        // /thumb serves a browser-renderable preview: the original bytes inline
        // for JPEG/PNG/WebP/etc, or the embedded JPEG extracted from a RAW file.
        thumbnailUrl: `${origin}/assets/${id}/thumb${q}`,
        rawUrl: `${origin}/assets/${id}/raw${q}`,
        recipeUrl: `${origin}/assets/${id}/recipe${q}`,
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

// --- persisted edit thumbnail (beside-original preview) ---
//
// Unlike recipes/renders (which live in the sidecar folder), the edit thumbnail
// lives BESIDE its source using the full-filename law, so a folder scan finds it
// by the source path and the /thumb route can serve it as the freshest preview
// (ultrahdrutil #783 / #798). It is written for a plainly-served folder only —
// a read-only macOS Photos package is refused by the route (never mutated).

/** Absolute path of the edit-thumbnail sidecar written beside a source file:
 *  `/lib/IMG.ARW` → `/lib/IMG.ARW.edit_thumbnail.jpg` (whole suffix on the whole
 *  filename, extension included — see EDIT_THUMBNAIL_SUFFIX). */
export function editThumbnailPath(absSourcePath) {
    return absSourcePath + EDIT_THUMBNAIL_SUFFIX;
}

/** Atomically persist the edit thumbnail beside `absSourcePath` (temp file in the
 *  same directory + rename, so a reader never sees a half-written preview and a
 *  crash mid-write can't corrupt a prior good one). Returns the written path;
 *  throws on write failure (EROFS/EACCES/ENOSPC/… — the caller maps to 507). */
export async function saveEditThumbnail(absSourcePath, bytes) {
    const dest = editThumbnailPath(absSourcePath);
    const dir = path.dirname(dest);
    // Hidden temp name in the SAME dir (same filesystem → rename is atomic). The
    // leading dot keeps it out of the scan even if a write dies before the rename.
    const tmp = path.join(dir, `.${path.basename(dest)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
        await fs.writeFile(tmp, bytes);
        await fs.rename(tmp, dest);
    } catch (err) {
        try { await fs.unlink(tmp); } catch { /* best-effort cleanup */ }
        throw err;
    }
    return dest;
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
