// Tests for the macOS Photos library integration (src/photos.js): detection,
// scan-root = originals/, external sidecar, and a full edit roundtrip against a
// fake `.photoslibrary` package — proving the package is NEVER written to.
// Zero deps; run with `node test/photos.test.js`.

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { resolveLibrary, isPhotosLibraryPath, defaultPhotosLibraryPath } from '../src/photos.js';

let failures = 0;
async function t(name, fn) {
    try { await fn(); process.stdout.write(`  ok  ${name}\n`); }
    catch (e) { failures++; process.stdout.write(`  FAIL ${name}: ${e.message}\n`); }
}

async function main() {
    await t('isPhotosLibraryPath recognizes the package suffix', () => {
        assert.equal(isPhotosLibraryPath('/Users/x/Pictures/Photos Library.photoslibrary'), true);
        assert.equal(isPhotosLibraryPath('/Users/x/Pictures/My Trip.PhotosLibrary'), true);
        assert.equal(isPhotosLibraryPath('/Users/x/Pictures/regular-folder'), false);
    });

    await t('defaultPhotosLibraryPath points at ~/Pictures', () => {
        assert.ok(defaultPhotosLibraryPath().endsWith(path.join('Pictures', 'Photos Library.photoslibrary')));
    });

    // Build a fake Photos package: <tmp>/Faux.photoslibrary/originals/0/UUID.jpg
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hdrphotos-'));
    const pkg = path.join(tmp, 'Faux.photoslibrary');
    const originals = path.join(pkg, 'originals', '0');
    await fs.mkdir(originals, { recursive: true });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 0xff, 0xd9]);
    await fs.writeFile(path.join(originals, 'AAA-111.jpg'), jpeg);
    await fs.writeFile(path.join(originals, 'AAA-222.heic'), jpeg); // skipped: editor can't ingest HEIC
    // A stray database file the scanner must ignore (it's not a supported image).
    await fs.mkdir(path.join(pkg, 'database'), { recursive: true });
    await fs.writeFile(path.join(pkg, 'database', 'Photos.sqlite'), 'not an image');

    let lib;
    await t('resolveLibrary maps a .photoslibrary to originals + external sidecar', async () => {
        lib = await resolveLibrary(pkg, {});
        assert.equal(lib.kind, 'macos-photos');
        assert.equal(lib.scanRoot, path.join(pkg, 'originals'));
        // Sidecar must be OUTSIDE the package so the library is never mutated.
        assert.equal(lib.sidecarRoot, path.join(tmp, 'Faux.photoslibrary.hdrtoys'));
        assert.ok(!lib.sidecarRoot.startsWith(pkg + path.sep), 'sidecar must not be inside the package');
    });

    await t('resolveLibrary throws on a package with no originals/', async () => {
        const empty = path.join(tmp, 'Empty.photoslibrary');
        await fs.mkdir(empty, { recursive: true });
        await assert.rejects(() => resolveLibrary(empty, {}), /originals/);
    });

    const server = createServer({ root: lib.scanRoot, sidecarRoot: lib.sidecarRoot, kind: lib.kind });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;

    let id;
    await t('GET /assets lists JPEG originals, skips HEIC + sqlite', async () => {
        const r = await fetch(`${base}/assets`);
        const j = await r.json();
        assert.equal(j.assets.length, 1, `expected only the JPEG, got ${j.assets.length}`);
        id = j.assets[0].id;
    });

    await t('health reports kind=macos-photos', async () => {
        const j = await (await fetch(`${base}/`)).json();
        assert.equal(j.kind, 'macos-photos');
    });

    await t('snapshot + render land in the EXTERNAL sidecar, package untouched', async () => {
        const env = { imageId: id, clientId: 'c1', seq: 1, recipe: { exposure: 0.5 } };
        await fetch(`${base}/hdrtoys/callback/snapshot`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(env),
        });
        const fd = new FormData();
        fd.append('metadata', new Blob([JSON.stringify({ imageId: id, fileName: 'out.jpg' })], { type: 'application/json' }));
        fd.append('image', new Blob([jpeg], { type: 'image/jpeg' }), 'out.jpg');
        await fetch(`${base}/hdrtoys/callback/render`, { method: 'POST', body: fd });

        // Recipe restored from the external sidecar.
        const got = await (await fetch(`${base}/assets/${id}/recipe`)).json();
        assert.equal(got.recipe.exposure, 0.5);
        // Sidecar files exist outside the package...
        const sidecarEntries = await fs.readdir(lib.sidecarRoot);
        assert.ok(sidecarEntries.some((e) => e.endsWith('.recipe.json')), 'recipe written to sidecar');
        // ...and the package's originals folder still holds exactly the 2 source files.
        const origEntries = await fs.readdir(originals);
        assert.deepEqual(origEntries.sort(), ['AAA-111.jpg', 'AAA-222.heic']);
        assert.ok(!origEntries.some((e) => e.includes('.hdrtoys')), 'package must not gain a sidecar');
    });

    await new Promise((r) => server.close(r));
    await fs.rm(tmp, { recursive: true, force: true });

    if (failures) { process.stderr.write(`\n${failures} test(s) failed\n`); process.exit(1); }
    process.stdout.write('\nall photos tests passed\n');
}

main();
