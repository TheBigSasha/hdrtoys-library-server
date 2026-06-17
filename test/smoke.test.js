// Smoke test: spins the server on a temp library, exercises the protocol's
// core roundtrip (list → raw → snapshot save → recipe restore → render upload)
// entirely in-process. Zero deps; run with `node test/smoke.test.js`.

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { encodeId } from '../src/library.js';

let failures = 0;
async function t(name, fn) {
    try { await fn(); process.stdout.write(`  ok  ${name}\n`); }
    catch (e) { failures++; process.stdout.write(`  FAIL ${name}: ${e.message}\n`); }
}

async function main() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hdrlib-'));
    // A tiny fake JPEG (magic bytes + payload) and a nested one.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
    await fs.writeFile(path.join(root, 'photo1.jpg'), jpeg);
    await fs.mkdir(path.join(root, 'sub'), { recursive: true });
    await fs.writeFile(path.join(root, 'sub', 'photo2.JPG'), jpeg);
    await fs.writeFile(path.join(root, 'notes.txt'), 'ignore me'); // non-image

    const server = createServer({ root });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;

    await t('GET / health', async () => {
        const r = await fetch(`${base}/`);
        assert.equal(r.status, 200);
        const j = await r.json();
        assert.equal(j.app, 'hdrtoys-library-server');
    });

    let firstId;
    await t('GET /assets lists images, skips .txt', async () => {
        const r = await fetch(`${base}/assets`);
        assert.equal(r.status, 200);
        const j = await r.json();
        assert.equal(j.assets.length, 2, `expected 2 assets, got ${j.assets.length}`);
        assert.ok(j.assets.every((a) => a.kind === 'jpeg'));
        firstId = j.assets[0].id;
    });

    await t('OPTIONS preflight returns CORS 204', async () => {
        const r = await fetch(`${base}/hdrtoys/callback/snapshot`, { method: 'OPTIONS' });
        assert.equal(r.status, 204);
        assert.equal(r.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
    });

    await t('GET /assets/{id}/raw returns bytes + disposition', async () => {
        const r = await fetch(`${base}/assets/${firstId}/raw`);
        assert.equal(r.status, 200);
        assert.match(r.headers.get('content-disposition') || '', /attachment/);
        const buf = Buffer.from(await r.arrayBuffer());
        assert.equal(buf.length, jpeg.length);
    });

    await t('GET recipe 404 when none', async () => {
        const r = await fetch(`${base}/assets/${firstId}/recipe`);
        assert.equal(r.status, 404);
    });

    await t('POST snapshot stores recipe', async () => {
        const env = { type: 'edit-snapshot', schemaVersion: 1, imageId: firstId, clientId: 'c1', seq: 3, recipe: { version: 3, exposure: 1.5 } };
        const r = await fetch(`${base}/hdrtoys/callback/snapshot`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(env),
        });
        assert.equal(r.status, 204);
        assert.equal(r.headers.get('x-hdrtoys-stored'), '1');
    });

    await t('stale seq is dropped (monotonic)', async () => {
        const env = { imageId: firstId, clientId: 'c1', seq: 2, recipe: { version: 3, exposure: 9 } };
        const r = await fetch(`${base}/hdrtoys/callback/snapshot`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(env),
        });
        assert.equal(r.headers.get('x-hdrtoys-stored'), '0');
    });

    await t('GET recipe restores stored recipe', async () => {
        const r = await fetch(`${base}/assets/${firstId}/recipe`);
        assert.equal(r.status, 200);
        const j = await r.json();
        assert.equal(j.recipe.exposure, 1.5, 'stale write should not have overwritten');
    });

    await t('POST render saves multipart image', async () => {
        const fd = new FormData();
        fd.append('metadata', new Blob([JSON.stringify({ imageId: firstId, fileName: 'out.jpg' })], { type: 'application/json' }));
        fd.append('image', new Blob([jpeg], { type: 'image/jpeg' }), 'out.jpg');
        const r = await fetch(`${base}/hdrtoys/callback/render`, { method: 'POST', body: fd });
        assert.equal(r.status, 201);
        const j = await r.json();
        assert.equal(j.saved, 'out.jpg');
    });

    await t('traversal id is rejected', async () => {
        const evil = encodeId('../../etc/passwd');
        const r = await fetch(`${base}/assets/${evil}/raw`);
        assert.equal(r.status, 400);
    });

    await new Promise((r) => server.close(r));
    await fs.rm(root, { recursive: true, force: true });

    if (failures) { process.stderr.write(`\n${failures} test(s) failed\n`); process.exit(1); }
    process.stdout.write('\nall smoke tests passed\n');
}

main();
