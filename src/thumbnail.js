// Thumbnail extraction for the library server.
//
// A browser <img> can render JPEG/PNG/WebP/GIF/AVIF directly, so for those the
// "thumbnail" is just the original file served inline. RAW camera files can't be
// decoded by a browser, but virtually every RAW format embeds a full JPEG
// preview — we extract the largest one with a zero-dependency marker scan and
// cache it in the sidecar so it's only done once per file.
//
// EXR has no cheap browser-renderable preview, so it has no thumbnail (callers
// return 404 and the editor shows a placeholder).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { extractEmbeddedJpegContainer, isCompleteJpegContainer } from './jpegContainer.js';

/**
 * Find the largest structurally complete embedded JPEG container in a RAW
 * buffer. APP payloads, progressive scans, entropy stuffing, and MPF-indexed
 * images are kept byte-for-byte; data after the actual image extent is excluded.
 * Returns a Buffer view into `buf`, or null when no complete candidate exists.
 */
export function extractEmbeddedJpeg(buf) {
    return extractEmbeddedJpegContainer(buf);
}

/** Current versioned cache path; older cache bytes remain available as evidence. */
export function thumbCachePath(sidecarRoot, id) {
    return path.join(sidecarRoot, `${id}.thumb-v2.jpg`);
}

/** Original unversioned cache path, retained for read-only compatibility checks. */
export function legacyThumbCachePath(sidecarRoot, id) {
    return path.join(sidecarRoot, `${id}.thumb.jpg`);
}

/** Where an OS-generated ("system") thumbnail is cached (PNG per asset id). */
export function sysThumbCachePath(sidecarRoot, id) {
    return path.join(sidecarRoot, `${id}.systhumb.png`);
}

/**
 * Return an already-cached thumbnail for an asset, or null. Checks both the RAW
 * embedded-preview cache (JPEG) and the system-thumbnail cache (PNG) so a thumb
 * is generated at most once per file.
 */
export async function readCachedThumb(sidecarRoot, id) {
    for (const jpg of [thumbCachePath(sidecarRoot, id), legacyThumbCachePath(sidecarRoot, id)]) {
        try {
            const bytes = await fs.readFile(jpg);
            if (isCompleteJpegContainer(bytes)) return { bytes, contentType: 'image/jpeg' };
            // Keep malformed/old bytes untouched. A RAW request can regenerate a versioned cache.
        } catch { /* none */ }
    }
    const png = sysThumbCachePath(sidecarRoot, id);
    try { return { bytes: await fs.readFile(png), contentType: 'image/png' }; } catch { /* none */ }
    return null;
}

/** Persist an OS-generated thumbnail (PNG) for an asset. Best-effort. */
export async function cacheSysThumb(sidecarRoot, id, bytes) {
    try {
        await fs.mkdir(sidecarRoot, { recursive: true });
        await fs.writeFile(sysThumbCachePath(sidecarRoot, id), bytes);
    } catch { /* caching is best-effort */ }
}

/**
 * Resolve a thumbnail for a RAW file: serve the cached preview if present,
 * otherwise extract it from the RAW, cache it, and return the bytes. Returns a
 * Buffer (image/jpeg) or null if no embedded preview could be found.
 */
export async function rawThumbnail(absRawPath, sidecarRoot, id, { skipCacheRead = false } = {}) {
    const cache = thumbCachePath(sidecarRoot, id);
    if (!skipCacheRead) {
        for (const cachedPath of [cache, legacyThumbCachePath(sidecarRoot, id)]) {
            try {
                const cached = await fs.readFile(cachedPath);
                if (isCompleteJpegContainer(cached)) return cached;
                // Never serve or overwrite an invalid legacy cache during migration.
            } catch { /* not cached yet — extract below */ }
        }
    }

    let raw;
    try {
        raw = await fs.readFile(absRawPath);
    } catch {
        return null;
    }
    const jpeg = extractEmbeddedJpeg(raw);
    if (!jpeg) return null;
    const bytes = Buffer.from(jpeg); // copy out of the large RAW buffer before caching
    try {
        await fs.mkdir(sidecarRoot, { recursive: true });
        await fs.writeFile(cache, bytes);
    } catch { /* caching is best-effort; still return the bytes */ }
    return bytes;
}
