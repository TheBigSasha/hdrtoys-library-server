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

/**
 * Find the largest embedded JPEG inside a buffer (e.g. a RAW file's preview).
 *
 * Scan for every SOI marker (FF D8 FF). For each, the candidate JPEG spans from
 * that SOI up to the *last* EOI (FF D9) before the next SOI — bounding by the
 * next SOI avoids truncating at an inner EXIF-thumbnail's EOI. The biggest such
 * span is the main preview. Returns a Buffer (a view into `buf`) or null.
 */
export function extractEmbeddedJpeg(buf) {
    const sois = [];
    for (let i = 0; i < buf.length - 2; i++) {
        if (buf[i] === 0xff && buf[i + 1] === 0xd8 && buf[i + 2] === 0xff) sois.push(i);
    }
    let best = null;
    for (let k = 0; k < sois.length; k++) {
        const start = sois[k];
        const limit = k + 1 < sois.length ? sois[k + 1] : buf.length;
        let lastEoi = -1;
        for (let j = start + 2; j < limit - 1; j++) {
            if (buf[j] === 0xff && buf[j + 1] === 0xd9) lastEoi = j + 2;
        }
        if (lastEoi > 0) {
            const len = lastEoi - start;
            if (!best || len > best.len) best = { start, end: lastEoi, len };
        }
    }
    if (!best) return null;
    return buf.subarray(best.start, best.end);
}

/** Where a RAW file's extracted preview is cached (one JPEG per asset id). */
export function thumbCachePath(sidecarRoot, id) {
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
    const jpg = thumbCachePath(sidecarRoot, id);
    try { return { bytes: await fs.readFile(jpg), contentType: 'image/jpeg' }; } catch { /* none */ }
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
export async function rawThumbnail(absRawPath, sidecarRoot, id) {
    const cache = thumbCachePath(sidecarRoot, id);
    try {
        return await fs.readFile(cache);
    } catch { /* not cached yet — extract below */ }

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
