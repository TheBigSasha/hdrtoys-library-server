// Tests for thumbnail extraction + the /assets/{id}/thumb route:
//   - raster files (jpg/png/webp) are served INLINE (renderable in <img>),
//   - a synthetic "RAW" file's embedded JPEG preview is extracted, served, and
//     cached in the sidecar,
//   - EXR has no thumbnail (404).
// Zero deps; run with `node test/thumb.test.js`.

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { encodeId } from '../src/library.js';
import { extractEmbeddedJpeg } from '../src/thumbnail.js';

let failures = 0;
async function t(name, fn) {
    try { await fn(); process.stdout.write(`  ok  ${name}\n`); }
    catch (e) { failures++; process.stdout.write(`  FAIL ${name}: ${e.message}\n`); }
}

// A minimal but valid-looking JPEG: SOI + APP0 + payload + EOI.
function fakeJpeg(tag) {
    return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, tag, tag, 0xde, 0xad, 0xbe, 0xef, 0xff, 0xd9]);
}

async function main() {
    await t('extractEmbeddedJpeg finds the LARGEST embedded jpeg', () => {
        const small = fakeJpeg(0x11);
        const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(500, 0x42), Buffer.from([0xff, 0xd9])]);
        // RAW-ish container: some TIFF-y header, then two embedded jpegs.
        const raw = Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00, 1, 2, 3, 4]), small, Buffer.alloc(16, 0), big, Buffer.alloc(8, 0)]);
        const out = extractEmbeddedJpeg(raw);
        assert.ok(out, 'should find a preview');
        assert.equal(out[0], 0xff); assert.equal(out[1], 0xd8);
        assert.equal(out[out.length - 2], 0xff); assert.equal(out[out.length - 1], 0xd9);
        assert.ok(out.length >= 500, `expected the big preview, got ${out.length}`);
    });

    await t('extractEmbeddedJpeg returns null when there is no jpeg', () => {
        assert.equal(extractEmbeddedJpeg(Buffer.from([0, 1, 2, 3, 4, 5])), null);
    });

    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hdrthumb-'));
    const jpeg = fakeJpeg(0x01);
    await fs.writeFile(path.join(root, 'photo.jpg'), jpeg);
    await fs.writeFile(path.join(root, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    // A synthetic RAW: junk + an embedded jpeg preview.
    const preview = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 0x7a), Buffer.from([0xff, 0xd9])]);
    await fs.writeFile(path.join(root, 'capture.arw'), Buffer.concat([Buffer.alloc(64, 0), preview, Buffer.alloc(32, 0)]));
    await fs.writeFile(path.join(root, 'scene.exr'), Buffer.from([0x76, 0x2f, 0x31, 0x01, 9, 9]));

    const server = createServer({ root });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;

    await t('asset list points thumbnailUrl at /thumb', async () => {
        const j = await (await fetch(`${base}/assets`)).json();
        assert.ok(j.assets.every((a) => /\/thumb$/.test(a.thumbnailUrl)), 'all thumbnailUrls end in /thumb');
    });

    await t('raster thumb is served INLINE (no attachment disposition)', async () => {
        const id = encodeId('photo.jpg');
        const r = await fetch(`${base}/assets/${id}/thumb`);
        assert.equal(r.status, 200);
        assert.equal(r.headers.get('content-type'), 'image/jpeg');
        assert.equal(r.headers.get('content-disposition'), null, 'thumb must not force a download');
        const buf = Buffer.from(await r.arrayBuffer());
        assert.equal(buf.length, jpeg.length);
    });

    await t('RAW thumb extracts the embedded preview and caches it', async () => {
        const id = encodeId('capture.arw');
        const r = await fetch(`${base}/assets/${id}/thumb`);
        assert.equal(r.status, 200);
        assert.equal(r.headers.get('content-type'), 'image/jpeg');
        const buf = Buffer.from(await r.arrayBuffer());
        assert.equal(buf[0], 0xff); assert.equal(buf[1], 0xd8); // valid JPEG
        // Cached in the sidecar so a second request doesn't re-scan the RAW.
        const cached = await fs.readFile(path.join(root, '.hdrtoys', `${id}.thumb.jpg`));
        assert.equal(cached.length, buf.length);
    });

    await t('EXR has no thumbnail (404)', async () => {
        const id = encodeId('scene.exr');
        const r = await fetch(`${base}/assets/${id}/thumb`);
        assert.equal(r.status, 404);
    });

    await t('kind filter returns only matching kinds', async () => {
        const j = await (await fetch(`${base}/assets?kind=raw`)).json();
        assert.equal(j.assets.length, 1);
        assert.equal(j.assets[0].kind, 'raw');
    });

    await new Promise((r) => server.close(r));
    await fs.rm(root, { recursive: true, force: true });

    if (failures) { process.stderr.write(`\n${failures} test(s) failed\n`); process.exit(1); }
    process.stdout.write('\nall thumb tests passed\n');
}

main();
