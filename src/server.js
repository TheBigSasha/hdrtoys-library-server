// HTTP server implementing the hdr.toys host-gallery integration protocol
// over the local filesystem.
//
// Routes (all CORS-enabled, OPTIONS-preflighted; bearer token optional):
//   GET  /                              → health + capability summary
//   GET  /assets                        → §3.1 paginated list
//   GET  /assets/{id}                   → §3.2 single asset
//   GET  /assets/{id}/raw               → §3.3 original bytes (also thumbnail fallback)
//   GET  /assets/{id}/recipe            → §3.4 latest recipe ({schemaVersion,recipe}) | 404
//   POST /assets/{id}/edit_thumbnail    → persist `<file>.edit_thumbnail.jpg` beside the original (#783/#798)
//   POST /hdrtoys/callback/snapshot     → §2.1 store latest recipe (seq-monotonic)
//   POST /hdrtoys/callback/render       → §2.2 save rendered image (multipart)
//   GET  /hdrtoys/callback/capabilities → §2.5 capability handshake
//
// Zero runtime dependencies — only Node built-ins.

import http from 'node:http';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';

import {
    scanLibrary,
    describeAsset,
    resolveAssetPath,
    mimeOf,
    kindOf,
    isRawImage,
    isRenderableRaster,
    saveRecipe,
    loadRecipe,
    saveRender,
    editThumbnailPath,
    saveEditThumbnail,
    decodeId,
    defaultSidecarRoot,
} from './library.js';
import { rawThumbnail, readCachedThumb, cacheSysThumb } from './thumbnail.js';
import { systemThumbnail } from './systemThumbnail.js';
import { parseMultipart } from './multipart.js';

const SCHEMA_VERSION = 1;

function corsHeaders(allowOrigin) {
    return {
        'Access-Control-Allow-Origin': allowOrigin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers':
            'Authorization, Content-Type, X-HDRToys-Image-Id, X-HDRToys-Channel, X-HDRToys-Schema-Version',
        // X-HDRT-Tier-Source lets a fetch caller read which thumbnail tier served
        // the bytes (e.g. 'edit-thumbnail' for a persisted edit preview).
        'Access-Control-Expose-Headers': 'Content-Disposition, X-HDRT-Tier-Source',
        'Access-Control-Max-Age': '86400',
        // hdr.toys sets COEP: require-corp (for SharedArrayBuffer/WASM). Under
        // that policy a cross-origin <img> (a no-cors subresource load) is
        // BLOCKED unless the response opts in with CORP. Without this header the
        // editor's library thumbnails silently fail to load even though the JSON
        // asset list (a CORS fetch) succeeds. 'cross-origin' lets any embedder
        // use our bytes — fine for a self-hosted, user-launched local server.
        'Cross-Origin-Resource-Policy': 'cross-origin',
    };
}

function sendJson(res, status, body, baseHeaders) {
    const payload = JSON.stringify(body);
    res.writeHead(status, { ...baseHeaders, 'Content-Type': 'application/json; charset=utf-8' });
    res.end(payload);
}

function checkAuth(req, url, token) {
    if (!token) return true; // no token configured → open (local-only default)
    const header = req.headers['authorization'] || '';
    if (header === `Bearer ${token}`) return true;
    // Also accept the token as a query param: resources loaded WITHOUT custom headers
    // — <img src> thumbnails, <a download> — can't send Authorization, so they carry
    // ?gallery_token=… instead (the editor bakes it into the URLs we hand back).
    return url.searchParams.get('gallery_token') === token;
}

async function readBody(req, limitBytes) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
        total += chunk.length;
        if (total > limitBytes) throw new Error('payload too large');
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

/**
 * Create the server. Options:
 *   root         absolute path to the library folder (originals are read from here)
 *   sidecarRoot  where recipes/renders are written (default `<root>/.hdrtoys`);
 *                set separately so a read-only macOS Photos package is never mutated
 *   kind         library kind label for the health route ('folder' | 'macos-photos')
 *   token        optional bearer token; when set, every request must carry it
 *   allowOrigin  CORS Allow-Origin value (default '*')
 *   systemThumbnails  use OS thumbnails (QuickLook/Shell/gdk) for previews (default true)
 *   maxSnapshotBytes / maxRenderBytes / maxEditThumbnailBytes  request body caps
 */
export function createServer({ root, sidecarRoot = defaultSidecarRoot(root), kind = 'folder', token = null, allowOrigin = '*', systemThumbnails = true, maxSnapshotBytes = 16 * 1024 * 1024, maxRenderBytes = 256 * 1024 * 1024, maxEditThumbnailBytes = 2 * 1024 * 1024 }) {
    const cors = corsHeaders(allowOrigin);

    return http.createServer(async (req, res) => {
        try {
            // Preflight: answer every OPTIONS with CORS + 204 (§1.3).
            if (req.method === 'OPTIONS') {
                res.writeHead(204, cors);
                res.end();
                return;
            }

            const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
            // Honor reverse-proxy forwarding (e.g. `tailscale serve`) so the asset URLs
            // we hand back use the scheme/host the client actually reached us on. Without
            // this an https:// editor (a phone on hdr.toys over a tailnet) receives http://
            // URLs and the browser blocks them as mixed content.
            const fwdProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
            const fwdHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
            const origin = `${fwdProto || 'http'}://${fwdHost || req.headers.host || 'localhost'}`;
            const segs = url.pathname.split('/').filter(Boolean);

            if (!checkAuth(req, url, token)) {
                sendJson(res, 401, { error: 'unauthorized' }, cors);
                return;
            }

            // GET / — health + capabilities
            if (req.method === 'GET' && segs.length === 0) {
                sendJson(res, 200, {
                    app: 'hdrtoys-library-server',
                    schemaVersion: SCHEMA_VERSION,
                    root,
                    kind,
                    endpoints: ['/assets', '/assets/{id}', '/assets/{id}/raw', '/assets/{id}/thumb', '/assets/{id}/recipe',
                        'POST /assets/{id}/edit_thumbnail',
                        '/hdrtoys/callback/snapshot', '/hdrtoys/callback/render', '/hdrtoys/callback/capabilities'],
                }, cors);
                return;
            }

            // GET /assets — paginated list (§3.1)
            if (req.method === 'GET' && segs.length === 1 && segs[0] === 'assets') {
                await handleList(url, root, sidecarRoot, origin, token, res, cors);
                return;
            }

            // /assets/{id}[/raw|/recipe]
            if (segs[0] === 'assets' && segs.length >= 2) {
                const id = segs[1];
                const sub = segs[2];
                if (req.method === 'GET' && segs.length === 2) {
                    await handleSingle(root, sidecarRoot, id, origin, token, res, cors);
                    return;
                }
                if (req.method === 'GET' && sub === 'thumb' && segs.length === 3) {
                    await handleThumb(root, sidecarRoot, id, res, cors, systemThumbnails);
                    return;
                }
                if (req.method === 'GET' && sub === 'raw' && segs.length === 3) {
                    await handleRaw(root, id, res, cors);
                    return;
                }
                if (req.method === 'GET' && sub === 'recipe' && segs.length === 3) {
                    await handleRecipeGet(sidecarRoot, id, res, cors);
                    return;
                }
                // POST /assets/{id}/edit_thumbnail — persist the freshest edit
                // preview beside the original (ultrahdrutil #783 / #798). Auth is the
                // same bearer check every route already passed above (checkAuth).
                if (req.method === 'POST' && sub === 'edit_thumbnail' && segs.length === 3) {
                    await handleEditThumbnail(req, root, id, kind, res, cors, maxEditThumbnailBytes);
                    return;
                }
            }

            // /hdrtoys/callback/*
            if (segs[0] === 'hdrtoys' && segs[1] === 'callback') {
                const action = segs[2];
                if (req.method === 'GET' && action === 'capabilities') {
                    sendJson(res, 200, {
                        snapshotSourceBytes: 'include',
                        acceptsRenders: true,
                        history: false,
                        maxSnapshotBytes,
                    }, cors);
                    return;
                }
                if (req.method === 'POST' && action === 'snapshot') {
                    await handleSnapshot(req, sidecarRoot, res, cors, maxSnapshotBytes);
                    return;
                }
                if (req.method === 'POST' && action === 'render') {
                    await handleRender(req, sidecarRoot, res, cors, maxRenderBytes);
                    return;
                }
            }

            sendJson(res, 404, { error: 'not found', path: url.pathname }, cors);
        } catch (err) {
            sendJson(res, 500, { error: 'internal', detail: String(err?.message || err) }, cors);
        }
    });
}

async function handleList(url, root, sidecarRoot, origin, token, res, cors) {
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 200, 1), 200);
    const cursor = url.searchParams.get('cursor');
    let offset = 0;
    if (cursor) {
        try {
            offset = Number(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')).offset) || 0;
        } catch { offset = 0; }
    }

    // Optional `kind` filter (§3.1): comma-separated list e.g. "raw" or "raw,exr".
    // Applied before pagination so the cursor stays consistent across the filtered set.
    const kindParam = url.searchParams.get('kind');
    const kinds = kindParam
        ? new Set(kindParam.split(',').map((k) => k.trim().toLowerCase()).filter(Boolean))
        : null;

    let rels = await scanLibrary(root);
    if (kinds && kinds.size) rels = rels.filter((rel) => kinds.has(kindOf(rel)));
    const page = rels.slice(offset, offset + limit);
    const assets = (await Promise.all(page.map((rel) => describeAsset(root, rel, origin, sidecarRoot, token)))).filter(Boolean);
    const nextOffset = offset + limit;
    const nextCursor = nextOffset < rels.length
        ? Buffer.from(JSON.stringify({ offset: nextOffset }), 'utf8').toString('base64url')
        : null;

    sendJson(res, 200, { assets, nextCursor }, cors);
}

async function handleSingle(root, sidecarRoot, id, origin, token, res, cors) {
    const rel = decodeId(id);
    if (rel === null) { sendJson(res, 400, { error: 'bad id' }, cors); return; }
    const asset = await describeAsset(root, rel, origin, sidecarRoot, token);
    if (!asset) { sendJson(res, 404, { error: 'no such asset' }, cors); return; }
    sendJson(res, 200, asset, cors);
}

async function handleRaw(root, id, res, cors) {
    const abs = resolveAssetPath(root, id);
    if (!abs) { sendJson(res, 400, { error: 'bad id' }, cors); return; }
    let stat;
    try {
        stat = await fs.stat(abs);
    } catch {
        sendJson(res, 404, { error: 'no such asset' }, cors);
        return;
    }
    const name = path.basename(abs);
    res.writeHead(200, {
        ...cors,
        'Content-Type': mimeOf(name),
        'Content-Length': String(stat.size),
        'Content-Disposition': `attachment; filename="${name.replace(/"/g, '')}"`,
        'Cache-Control': 'private, max-age=60',
    });
    createReadStream(abs).pipe(res);
}

// GET /assets/{id}/thumb — a small, browser-renderable preview, served INLINE
// (no attachment disposition, so it renders in an <img>). Priority:
//   0. edit thumbnail → the persisted `<file>.edit_thumbnail.jpg` beside the
//                       original (freshest edit preview; wins over caches),
//   1. cached thumbnail (generated once, reused),
//   2. RAW           → the JPEG preview embedded in the file,
//   3. system        → the OS thumbnail (QuickLook / Shell / gdk-pixbuf),
//   4. raster        → the original bytes as a last resort (full-res),
//   5. otherwise     → 404 (the editor shows a placeholder).
function serveThumb(res, cors, contentType, bytes) {
    res.writeHead(200, {
        ...cors,
        'Content-Type': contentType,
        'Content-Length': String(bytes.length),
        'Cache-Control': 'private, max-age=300',
    });
    res.end(bytes);
}

async function handleThumb(root, sidecarRoot, id, res, cors, systemThumbnails) {
    const abs = resolveAssetPath(root, id);
    if (!abs) { sendJson(res, 400, { error: 'bad id' }, cors); return; }
    let stat;
    try {
        stat = await fs.stat(abs);
    } catch {
        sendJson(res, 404, { error: 'no such asset' }, cors);
        return;
    }
    const name = path.basename(abs);

    // 0. Persisted edit thumbnail beside the original — the FRESHEST preview,
    //    baked from the latest edit, so it wins over any older cached RAW/system
    //    thumbnail (ultrahdrutil #783 / #798). Orphans never reach here: `abs`
    //    (the source) is stat'd above, so a sidecar with no source 404s first.
    try {
        const bytes = await fs.readFile(editThumbnailPath(abs));
        res.writeHead(200, {
            ...cors,
            'Content-Type': 'image/jpeg',
            'Content-Length': String(bytes.length),
            // Freshest preview: don't let a stale copy survive the next re-edit.
            'Cache-Control': 'private, max-age=0, must-revalidate',
            'X-HDRT-Tier-Source': 'edit-thumbnail',
        });
        res.end(bytes);
        return;
    } catch { /* no edit thumbnail — fall through to the normal thumbnail tiers */ }

    // 1. Already generated? Serve the cached thumbnail.
    const cached = await readCachedThumb(sidecarRoot, id);
    if (cached) { serveThumb(res, cors, cached.contentType, cached.bytes); return; }

    // 2. RAW → embedded JPEG preview (fast, dependency-free; rawThumbnail caches it).
    if (isRawImage(name)) {
        const bytes = await rawThumbnail(abs, sidecarRoot, id);
        if (bytes) { serveThumb(res, cors, 'image/jpeg', bytes); return; }
    }

    // 3. OS-generated thumbnail (small; covers raster, EXR, RAW-without-preview).
    if (systemThumbnails) {
        const sys = await systemThumbnail(abs);
        if (sys) {
            await cacheSysThumb(sidecarRoot, id, sys.bytes);
            serveThumb(res, cors, sys.contentType, sys.bytes);
            return;
        }
    }

    // 4. Raster fallback → the original bytes inline (always works, just larger).
    if (isRenderableRaster(name)) {
        res.writeHead(200, {
            ...cors,
            'Content-Type': mimeOf(name),
            'Content-Length': String(stat.size),
            'Cache-Control': 'private, max-age=300',
        });
        createReadStream(abs).pipe(res);
        return;
    }

    // 5. EXR/etc with no system thumbnail: nothing renderable.
    sendJson(res, 404, { error: 'no thumbnail for this type' }, cors);
}

async function handleRecipeGet(sidecarRoot, id, res, cors) {
    if (decodeId(id) === null) { sendJson(res, 400, { error: 'bad id' }, cors); return; }
    const envelope = await loadRecipe(sidecarRoot, id);
    if (!envelope) { sendJson(res, 404, { error: 'no recipe' }, cors); return; }
    // Stored envelope is the §2.1 snapshot; expose {schemaVersion, recipe} (§3.4).
    sendJson(res, 200, {
        schemaVersion: envelope.schemaVersion ?? SCHEMA_VERSION,
        recipe: envelope.recipe ?? envelope,
    }, cors);
}

// POST /assets/{id}/edit_thumbnail — persist a small JPEG preview (the freshest
// edit thumbnail) BESIDE the original as `<sourceFilename>.edit_thumbnail.jpg`
// (full-filename law: the suffix appends to the WHOLE filename incl. its
// extension, so a RAW+JPEG stem pair never shares one sidecar — ultrahdrutil
// #783 / #798). Body is raw JPEG bytes. Auth is the shared bearer check every
// route already passed (checkAuth): a missing/invalid token 401'd before routing
// here, matching the render/snapshot write posture.
async function handleEditThumbnail(req, root, id, kind, res, cors, maxBytes) {
    const abs = resolveAssetPath(root, id);
    if (!abs) { sendJson(res, 400, { error: 'bad id' }, cors); return; }

    // The source must exist — an edit thumbnail is meaningless (and never served)
    // without it. Unknown id → 404.
    try {
        await fs.stat(abs);
    } catch {
        sendJson(res, 404, { error: 'no such asset' }, cors);
        return;
    }

    // A read-only macOS Photos package is NEVER written to (photos.js invariant).
    // Beside-original is impossible there, so refuse honestly rather than mutate
    // the library — recipes/renders use the external sidecar, but an edit
    // thumbnail must live beside its source (naming law) to be found on scan.
    if (kind === 'macos-photos') {
        sendJson(res, 507, { error: 'read-only library', detail: 'edit thumbnails cannot be written into a read-only macOS Photos library' }, cors);
        return;
    }

    let body;
    try {
        body = await readBody(req, maxBytes);
    } catch {
        sendJson(res, 413, { error: 'edit thumbnail too large' }, cors);
        return;
    }
    // Must be a JPEG (SOI marker FF D8 FF). Guards against an empty/garbled POST
    // silently persisting a broken preview that would then win on /thumb.
    if (body.length < 3 || body[0] !== 0xff || body[1] !== 0xd8 || body[2] !== 0xff) {
        sendJson(res, 400, { error: 'not a jpeg' }, cors);
        return;
    }

    let written;
    try {
        written = await saveEditThumbnail(abs, body);
    } catch (err) {
        // Read-only filesystem / no space / permission denied → honest 507; any
        // other write failure → 500. The original is never touched either way.
        const code = err?.code;
        if (code === 'EROFS' || code === 'EACCES' || code === 'EPERM' || code === 'ENOSPC') {
            sendJson(res, 507, { error: 'cannot write edit thumbnail', detail: String(err.message || err) }, cors);
        } else {
            sendJson(res, 500, { error: 'internal', detail: String(err?.message || err) }, cors);
        }
        return;
    }
    // 200 (not 201): a re-edit overwrites in place, so this is "stored", not
    // strictly "created". `saved` is the sidecar's basename for logging/asserts.
    sendJson(res, 200, { ok: true, saved: path.basename(written) }, cors);
}

async function handleSnapshot(req, sidecarRoot, res, cors, maxBytes) {
    let body;
    try {
        body = await readBody(req, maxBytes);
    } catch {
        sendJson(res, 413, { error: 'snapshot too large' }, cors);
        return;
    }
    let envelope;
    try {
        envelope = JSON.parse(body.toString('utf8'));
    } catch {
        sendJson(res, 400, { error: 'invalid json' }, cors);
        return;
    }
    const id = envelope?.imageId;
    if (!id || decodeId(String(id)) === null) {
        sendJson(res, 400, { error: 'missing/invalid imageId' }, cors);
        return;
    }
    const result = await saveRecipe(sidecarRoot, String(id), envelope);
    // 204 either way — a dropped stale snapshot is still "accepted" per §2.4
    // (the higher seq already won); the editor never blocks on this.
    res.writeHead(204, { ...cors, 'X-HDRToys-Stored': result.stored ? '1' : '0' });
    res.end();
}

async function handleRender(req, sidecarRoot, res, cors, maxBytes) {
    const contentType = req.headers['content-type'] || '';
    let body;
    try {
        body = await readBody(req, maxBytes);
    } catch {
        sendJson(res, 413, { error: 'render too large' }, cors);
        return;
    }
    let parts;
    try {
        parts = parseMultipart(body, contentType);
    } catch {
        sendJson(res, 400, { error: 'invalid multipart' }, cors);
        return;
    }
    const meta = parts.find((p) => p.name === 'metadata');
    const image = parts.find((p) => p.name === 'image');
    if (!image) { sendJson(res, 400, { error: 'missing image part' }, cors); return; }

    let metadata = {};
    if (meta) {
        try { metadata = JSON.parse(meta.data.toString('utf8')); } catch { /* tolerate */ }
    }
    // Prefer header id (servers that route before parsing); fall back to metadata.
    const id = String(req.headers['x-hdrtoys-image-id'] || metadata.imageId || '');
    if (!id || decodeId(id) === null) {
        sendJson(res, 400, { error: 'missing/invalid imageId' }, cors);
        return;
    }
    const fileName = metadata.fileName || image.filename || 'render.jpg';
    const written = await saveRender(sidecarRoot, id, fileName, image.data);
    sendJson(res, 201, { saved: path.basename(written) }, cors);
}
