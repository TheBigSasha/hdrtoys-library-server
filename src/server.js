// HTTP server implementing the hdr.toys host-gallery integration protocol
// over the local filesystem.
//
// Routes (all CORS-enabled, OPTIONS-preflighted; bearer token optional):
//   GET  /                              → health + capability summary
//   GET  /assets                        → §3.1 paginated list
//   GET  /assets/{id}                   → §3.2 single asset
//   GET  /assets/{id}/raw               → §3.3 original bytes (also thumbnail fallback)
//   GET  /assets/{id}/recipe            → §3.4 latest recipe ({schemaVersion,recipe}) | 404
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
    decodeId,
    defaultSidecarRoot,
} from './library.js';
import { rawThumbnail } from './thumbnail.js';
import { parseMultipart } from './multipart.js';

const SCHEMA_VERSION = 1;

function corsHeaders(allowOrigin) {
    return {
        'Access-Control-Allow-Origin': allowOrigin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers':
            'Authorization, Content-Type, X-HDRToys-Image-Id, X-HDRToys-Channel, X-HDRToys-Schema-Version',
        'Access-Control-Expose-Headers': 'Content-Disposition',
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

function checkAuth(req, token) {
    if (!token) return true; // no token configured → open (local-only default)
    const header = req.headers['authorization'] || '';
    return header === `Bearer ${token}`;
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
 *   maxSnapshotBytes / maxRenderBytes  request body caps
 */
export function createServer({ root, sidecarRoot = defaultSidecarRoot(root), kind = 'folder', token = null, allowOrigin = '*', maxSnapshotBytes = 16 * 1024 * 1024, maxRenderBytes = 256 * 1024 * 1024 }) {
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
            const origin = `http://${req.headers.host || 'localhost'}`;
            const segs = url.pathname.split('/').filter(Boolean);

            if (!checkAuth(req, token)) {
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
                        '/hdrtoys/callback/snapshot', '/hdrtoys/callback/render', '/hdrtoys/callback/capabilities'],
                }, cors);
                return;
            }

            // GET /assets — paginated list (§3.1)
            if (req.method === 'GET' && segs.length === 1 && segs[0] === 'assets') {
                await handleList(url, root, sidecarRoot, origin, res, cors);
                return;
            }

            // /assets/{id}[/raw|/recipe]
            if (segs[0] === 'assets' && segs.length >= 2) {
                const id = segs[1];
                const sub = segs[2];
                if (req.method === 'GET' && segs.length === 2) {
                    await handleSingle(root, sidecarRoot, id, origin, res, cors);
                    return;
                }
                if (req.method === 'GET' && sub === 'thumb' && segs.length === 3) {
                    await handleThumb(root, sidecarRoot, id, res, cors);
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

async function handleList(url, root, sidecarRoot, origin, res, cors) {
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
    const assets = (await Promise.all(page.map((rel) => describeAsset(root, rel, origin, sidecarRoot)))).filter(Boolean);
    const nextOffset = offset + limit;
    const nextCursor = nextOffset < rels.length
        ? Buffer.from(JSON.stringify({ offset: nextOffset }), 'utf8').toString('base64url')
        : null;

    sendJson(res, 200, { assets, nextCursor }, cors);
}

async function handleSingle(root, sidecarRoot, id, origin, res, cors) {
    const rel = decodeId(id);
    if (rel === null) { sendJson(res, 400, { error: 'bad id' }, cors); return; }
    const asset = await describeAsset(root, rel, origin, sidecarRoot);
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

// GET /assets/{id}/thumb — a browser-renderable preview, served INLINE (no
// attachment disposition, so it renders in an <img>):
//   • JPEG/PNG/WebP/GIF/AVIF → the original bytes (a browser renders them as-is).
//   • RAW                    → the embedded JPEG preview, extracted + cached.
//   • EXR / no preview       → 404 (the editor shows a placeholder).
async function handleThumb(root, sidecarRoot, id, res, cors) {
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

    if (isRawImage(name)) {
        const bytes = await rawThumbnail(abs, sidecarRoot, id);
        if (!bytes) { sendJson(res, 404, { error: 'no embedded preview' }, cors); return; }
        res.writeHead(200, {
            ...cors,
            'Content-Type': 'image/jpeg',
            'Content-Length': String(bytes.length),
            'Cache-Control': 'private, max-age=300',
        });
        res.end(bytes);
        return;
    }

    // EXR and anything else: no cheap renderable thumbnail.
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
