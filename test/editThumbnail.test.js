// Tests for persisted edit thumbnails (ultrahdrutil #783 / #798):
//   - POST /assets/{id}/edit_thumbnail writes `<file>.edit_thumbnail.jpg` BESIDE
//     the original (full-filename law incl. RAW double extension), overwrites,
//     validates JPEG magic + size cap, 404s unknown ids, 400s traversal, 401s
//     without the configured token, and 507s a read-only macOS Photos package;
//   - scanLibrary / GET /assets exclude `*.edit_thumbnail.jpg` (sidecars AND
//     orphans with no matching source);
//   - GET /assets/{id}/thumb prefers the persisted edit thumbnail bytes (freshest
//     preview, wins over the RAW embedded preview) and tags X-HDRT-Tier-Source.
// Zero deps; run with `node test/editThumbnail.test.js`.

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { encodeId, scanLibrary, isEditThumbnailSidecar, EDIT_THUMBNAIL_SUFFIX } from '../src/library.js';

let failures = 0;
async function t(name, fn) {
    try { await fn(); process.stdout.write(`  ok  ${name}\n`); }
    catch (e) { failures++; process.stdout.write(`  FAIL ${name}: ${e.message}\n`); }
}

// A minimal but valid-looking JPEG (SOI FF D8 FF E0 … EOI), payload tagged so
// different thumbnails are byte-distinguishable.
function fakeJpeg(tag) {
    return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, tag, tag, 0xde, 0xad, 0xbe, 0xef, 0xff, 0xd9]);
}

async function listen(server) {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${server.address().port}`;
}

async function main() {
    await t('isEditThumbnailSidecar matches the suffix (case-insensitive, empty-name)', () => {
        assert.equal(EDIT_THUMBNAIL_SUFFIX, '.edit_thumbnail.jpg');
        assert.equal(isEditThumbnailSidecar('IMG_5501.ARW.edit_thumbnail.jpg'), true);
        assert.equal(isEditThumbnailSidecar('photo.JPG.EDIT_THUMBNAIL.JPG'), true); // case-insensitive
        assert.equal(isEditThumbnailSidecar('.edit_thumbnail.jpg'), true);          // bare / empty-name
        assert.equal(isEditThumbnailSidecar('photo.jpg'), false);
        assert.equal(isEditThumbnailSidecar('edit_thumbnail.jpg'), false);          // no leading dot → not the sidecar form
    });

    // --- main library: raster + RAW + an orphan sidecar + a bare sidecar ---
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hdredit-'));
    const rasterJpeg = fakeJpeg(0x01);
    await fs.writeFile(path.join(root, 'photo.jpg'), rasterJpeg);
    // Synthetic RAW: junk + a distinct embedded JPEG preview + junk.
    const rawPreview = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 0x7a), Buffer.from([0xff, 0xd9])]);
    await fs.writeFile(path.join(root, 'IMG_5501.ARW'), Buffer.concat([Buffer.alloc(64, 0), rawPreview, Buffer.alloc(32, 0)]));
    // An ORPHAN edit-thumbnail sidecar whose source (ghost.jpg) does not exist.
    await fs.writeFile(path.join(root, 'ghost.jpg.edit_thumbnail.jpg'), fakeJpeg(0x99));
    // A bare, empty-name sidecar (also a dotfile → doubly excluded).
    await fs.writeFile(path.join(root, '.edit_thumbnail.jpg'), fakeJpeg(0x98));

    await t('scanLibrary lists only real assets (excludes sidecars + orphans)', async () => {
        const rels = await scanLibrary(root);
        assert.deepEqual(rels, ['IMG_5501.ARW', 'photo.jpg'], `got ${JSON.stringify(rels)}`);
    });

    // systemThumbnails off → deterministic tier order (no qlmanage/gdk spawns).
    const server = createServer({ root, systemThumbnails: false });
    const base = await listen(server);

    await t('GET /assets excludes sidecars + orphans (exactly 2 assets)', async () => {
        const j = await (await fetch(`${base}/assets`)).json();
        assert.equal(j.assets.length, 2, `expected 2 assets, got ${j.assets.length}`);
        assert.ok(j.assets.every((a) => !a.name.includes('edit_thumbnail')));
    });

    const rawId = encodeId('IMG_5501.ARW');
    const rasterId = encodeId('photo.jpg');
    const editRawBytes = fakeJpeg(0x55);

    await t('POST edit_thumbnail writes beside original (RAW double-extension naming law)', async () => {
        const r = await fetch(`${base}/assets/${rawId}/edit_thumbnail`, { method: 'POST', body: editRawBytes });
        assert.equal(r.status, 200, `status ${r.status}`);
        const j = await r.json();
        assert.equal(j.ok, true);
        assert.equal(j.saved, 'IMG_5501.ARW.edit_thumbnail.jpg', 'whole suffix on the WHOLE filename incl. .ARW');
        // Landed beside the original with exactly the posted bytes.
        const onDisk = await fs.readFile(path.join(root, 'IMG_5501.ARW.edit_thumbnail.jpg'));
        assert.ok(onDisk.equals(editRawBytes), 'sidecar bytes match the POSTed body');
        // The original RAW is untouched.
        const orig = await fs.readFile(path.join(root, 'IMG_5501.ARW'));
        assert.equal(orig.length, 64 + rawPreview.length + 32, 'original RAW unchanged');
    });

    await t('POST edit_thumbnail overwrites an existing sidecar', async () => {
        const next = fakeJpeg(0x66);
        const r = await fetch(`${base}/assets/${rawId}/edit_thumbnail`, { method: 'POST', body: next });
        assert.equal(r.status, 200);
        const onDisk = await fs.readFile(path.join(root, 'IMG_5501.ARW.edit_thumbnail.jpg'));
        assert.ok(onDisk.equals(next), 'sidecar reflects the second write');
        // Restore the first payload so the thumb-preference test below is deterministic.
        await fetch(`${base}/assets/${rawId}/edit_thumbnail`, { method: 'POST', body: editRawBytes });
    });

    await t('GET /thumb serves the edit thumbnail (wins over RAW embedded preview)', async () => {
        const r = await fetch(`${base}/assets/${rawId}/thumb`);
        assert.equal(r.status, 200);
        assert.equal(r.headers.get('content-type'), 'image/jpeg');
        assert.equal(r.headers.get('x-hdrt-tier-source'), 'edit-thumbnail');
        const buf = Buffer.from(await r.arrayBuffer());
        assert.ok(buf.equals(editRawBytes), 'thumb returns the edit thumbnail, not the RAW embedded preview');
        assert.ok(!buf.equals(rawPreview), 'and definitely not the embedded RAW preview');
    });

    await t('GET /thumb prefers the edit thumbnail for a raster asset too', async () => {
        const editRaster = fakeJpeg(0x33);
        await fetch(`${base}/assets/${rasterId}/edit_thumbnail`, { method: 'POST', body: editRaster });
        const r = await fetch(`${base}/assets/${rasterId}/thumb`);
        assert.equal(r.status, 200);
        assert.equal(r.headers.get('x-hdrt-tier-source'), 'edit-thumbnail');
        const buf = Buffer.from(await r.arrayBuffer());
        assert.ok(buf.equals(editRaster), 'raster thumb served from the edit thumbnail, not the original');
        assert.ok(!buf.equals(rasterJpeg), 'and not the original raster bytes');
    });

    await t('sidecars written by the route are still NOT listed as assets', async () => {
        const j = await (await fetch(`${base}/assets`)).json();
        assert.equal(j.assets.length, 2, `still exactly 2 assets, got ${j.assets.length}`);
    });

    await t('POST edit_thumbnail 404s an unknown (well-formed) id', async () => {
        const r = await fetch(`${base}/assets/${encodeId('does-not-exist.jpg')}/edit_thumbnail`, { method: 'POST', body: fakeJpeg(0x01) });
        assert.equal(r.status, 404);
    });

    await t('POST edit_thumbnail 400s a traversal id', async () => {
        const r = await fetch(`${base}/assets/${encodeId('../escape.jpg')}/edit_thumbnail`, { method: 'POST', body: fakeJpeg(0x01) });
        assert.equal(r.status, 400);
    });

    await t('POST edit_thumbnail 400s a non-JPEG body', async () => {
        const r = await fetch(`${base}/assets/${rasterId}/edit_thumbnail`, { method: 'POST', body: Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
        assert.equal(r.status, 400);
        assert.equal((await r.json()).error, 'not a jpeg');
    });

    await new Promise((r) => server.close(r));
    await fs.rm(root, { recursive: true, force: true });

    // --- size cap ---
    await t('POST edit_thumbnail 413s a body over the cap', async () => {
        const capRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hdreditcap-'));
        await fs.writeFile(path.join(capRoot, 'photo.jpg'), fakeJpeg(0x01));
        const srv = createServer({ root: capRoot, systemThumbnails: false, maxEditThumbnailBytes: 8 });
        const b = await listen(srv);
        const r = await fetch(`${b}/assets/${encodeId('photo.jpg')}/edit_thumbnail`, { method: 'POST', body: fakeJpeg(0x01) /* 14 bytes > 8 */ });
        assert.equal(r.status, 413);
        await new Promise((res) => srv.close(res));
        await fs.rm(capRoot, { recursive: true, force: true });
    });

    // --- auth ---
    await t('POST edit_thumbnail 401s without the token, 200s with it', async () => {
        const tokRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hdredittok-'));
        await fs.writeFile(path.join(tokRoot, 'photo.jpg'), fakeJpeg(0x01));
        const srv = createServer({ root: tokRoot, systemThumbnails: false, token: 'sekret' });
        const b = await listen(srv);
        const id = encodeId('photo.jpg');
        const noAuth = await fetch(`${b}/assets/${id}/edit_thumbnail`, { method: 'POST', body: fakeJpeg(0x22) });
        assert.equal(noAuth.status, 401);
        assert.equal((await noAuth.json()).error, 'unauthorized');
        const withAuth = await fetch(`${b}/assets/${id}/edit_thumbnail`, {
            method: 'POST', headers: { authorization: 'Bearer sekret' }, body: fakeJpeg(0x22),
        });
        assert.equal(withAuth.status, 200);
        await new Promise((res) => srv.close(res));
        await fs.rm(tokRoot, { recursive: true, force: true });
    });

    // --- read-only macOS Photos package is refused, never written ---
    await t('POST edit_thumbnail 507s a read-only macOS Photos library (package untouched)', async () => {
        const photoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hdreditphotos-'));
        await fs.writeFile(path.join(photoRoot, 'AAA-111.jpg'), fakeJpeg(0x01));
        const srv = createServer({ root: photoRoot, systemThumbnails: false, kind: 'macos-photos' });
        const b = await listen(srv);
        const r = await fetch(`${b}/assets/${encodeId('AAA-111.jpg')}/edit_thumbnail`, { method: 'POST', body: fakeJpeg(0x01) });
        assert.equal(r.status, 507);
        // The package must NOT have gained a sidecar.
        const entries = await fs.readdir(photoRoot);
        assert.ok(!entries.some((e) => e.endsWith('.edit_thumbnail.jpg')), 'read-only package must not be written');
        await new Promise((res) => srv.close(res));
        await fs.rm(photoRoot, { recursive: true, force: true });
    });

    if (failures) { process.stderr.write(`\n${failures} test(s) failed\n`); process.exit(1); }
    process.stdout.write('\nall edit-thumbnail tests passed\n');
}

main();
