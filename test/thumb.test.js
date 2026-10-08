// Tests for structural JPEG extraction + the /assets/{id}/thumb route:
//   - marker payloads, entropy stuffing, progressive scans, and MPF images stay intact,
//   - RAW trailer bytes and malformed JPEGs are excluded,
//   - stale unversioned cache bytes are preserved but never served,
//   - cold and warm route responses return the same complete preview.
// Zero deps; run with `node test/thumb.test.js`.

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { encodeId } from '../src/library.js';
import {
    extractEmbeddedJpeg,
    legacyThumbCachePath,
    thumbCachePath,
} from '../src/thumbnail.js';
import { isCompleteJpegContainer } from '../src/jpegContainer.js';

let failures = 0;
async function t(name, fn) {
    try { await fn(); process.stdout.write(`  ok  ${name}\n`); }
    catch (e) { failures++; process.stdout.write(`  FAIL ${name}: ${e.message}\n`); }
}

function segment(marker, payload) {
    const length = payload.length + 2;
    assert.ok(length <= 0xffff, 'test segment must fit JPEG length field');
    const header = Buffer.from([0xff, marker, (length >> 8) & 0xff, length & 0xff]);
    return Buffer.concat([header, payload]);
}

const sof0 = segment(0xc0, Buffer.from([8, 0, 1, 0, 1, 1, 1, 0x11, 0]));
const sof2 = segment(0xc2, Buffer.from([8, 0, 1, 0, 1, 1, 1, 0x11, 0]));
const sos = segment(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0]));

// A marker-structured JPEG suitable for boundary tests (the server never decodes pixels).
function fakeJpeg(tag = 0x11, appSegments = []) {
    return Buffer.concat([
        Buffer.from([0xff, 0xd8]),
        ...appSegments,
        sof0,
        sos,
        Buffer.from([tag, 0xff, 0xd9]),
    ]);
}

function progressiveJpeg() {
    const exifWithEndMarker = segment(0xe1, Buffer.from([
        0x45, 0x78, 0x69, 0x66, 0, 0, 0xff, 0xd9, 0x31,
    ]));
    const firstScan = Buffer.from([0x12, 0xff, 0x00, 0xd9, 0x34, 0xff, 0xd3, 0x56]);
    const betweenScans = segment(0xfe, Buffer.from([0x61, 0xff, 0xd9, 0x62]));
    const secondScan = Buffer.from([0x78, 0xff, 0xd7, 0x9a]);
    return Buffer.concat([
        Buffer.from([0xff, 0xd8]),
        exifWithEndMarker,
        sof2,
        sos,
        firstScan,
        betweenScans,
        sos,
        secondScan,
        Buffer.from([0xff, 0xd9]),
    ]);
}

function mpfSegment(primarySize, secondarySize, secondaryOffset, { littleEndian = true } = {}) {
    // TIFF MP Index: three tags (MPFVersion, NumberOfImages, MPEntry)
    // followed by two 16-byte MP Entries. MP Entry offsets are relative to the TIFF header.
    const tiff = Buffer.alloc(82);
    const writeU16 = littleEndian ? 'writeUInt16LE' : 'writeUInt16BE';
    const writeU32 = littleEndian ? 'writeUInt32LE' : 'writeUInt32BE';
    tiff.write(littleEndian ? 'II' : 'MM', 0, 'ascii');
    tiff[writeU16](42, 2);
    tiff[writeU32](8, 4);
    tiff[writeU16](3, 8);

    let entry = 10;
    tiff[writeU16](0xb000, entry);
    tiff[writeU16](7, entry + 2);
    tiff[writeU32](4, entry + 4);
    tiff.set(Buffer.from('0100', 'ascii'), entry + 8);

    entry += 12;
    tiff[writeU16](0xb001, entry);
    tiff[writeU16](4, entry + 2);
    tiff[writeU32](1, entry + 4);
    tiff[writeU32](2, entry + 8);

    entry += 12;
    tiff[writeU16](0xb002, entry);
    tiff[writeU16](7, entry + 2);
    tiff[writeU32](32, entry + 4);
    tiff[writeU32](50, entry + 8);

    tiff[writeU32](0, 50); // primary attributes
    tiff[writeU32](primarySize, 54);
    tiff[writeU32](0, 58); // primary data offset is zero
    tiff[writeU32](secondarySize, 70);
    tiff[writeU32](secondaryOffset, 74);

    return segment(0xe2, Buffer.concat([Buffer.from('MPF\0', 'binary'), tiff]));
}

function mpfJpegContainer({ littleEndian = true } = {}) {
    const xmp = segment(0xe1, Buffer.from(
        'http://ns.adobe.com/xap/1.0/\0<x:xmpmeta hdrgm:Version="1.0"/>',
        'binary',
    ));
    const exif = segment(0xe1, Buffer.from([
        0x45, 0x78, 0x69, 0x66, 0, 0, 1, 2, 3, 0xff, 0xd8, 0x37, 0xff, 0xd9,
    ]));
    const beforeMpf = Buffer.concat([xmp, exif]);
    const imageHeader = Buffer.concat([sof0, sos]);
    const imageScan = Buffer.from([0x29, 0xff, 0x00, 0xd9, 0x51, 0xff, 0xd9]);
    const primaryTail = Buffer.concat([imageHeader, imageScan]);
    const secondary = fakeJpeg(0x33, [segment(0xe2, Buffer.from('gain-map metadata'))]);
    const mpfOffset = 2 + beforeMpf.length;
    const placeholder = mpfSegment(0, secondary.length, 0, { littleEndian });
    const primaryPlaceholder = Buffer.concat([
        Buffer.from([0xff, 0xd8]), beforeMpf, placeholder, primaryTail,
    ]);
    const primarySize = primaryPlaceholder.length;
    const tiffStart = mpfOffset + 8;
    const secondImageOffset = primarySize - tiffStart;
    const directory = mpfSegment(primarySize, secondary.length, secondImageOffset, { littleEndian });
    const primary = Buffer.concat([
        Buffer.from([0xff, 0xd8]), beforeMpf, directory, primaryTail,
    ]);
    assert.equal(primary.length, primarySize);
    return Buffer.concat([primary, secondary]);
}

async function startServer(root, sidecarRoot) {
    const server = createServer({ root, sidecarRoot, systemThumbnails: false });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function main() {
    await t('extractEmbeddedJpeg chooses the largest complete preview and stops before RAW trailer', () => {
        const small = fakeJpeg(0x11);
        const big = fakeJpeg(0x22, [segment(0xe0, Buffer.alloc(500, 0x42))]);
        const trailer = Buffer.concat([Buffer.alloc(2048, 0), Buffer.from([0xff, 0xd9])]);
        const raw = Buffer.concat([
            Buffer.from([0x49, 0x49, 0x2a, 0, 1, 2, 3, 4]), small,
            Buffer.alloc(16, 0), big, trailer,
        ]);
        assert.deepEqual(extractEmbeddedJpeg(raw), big);
    });

    await t('extractEmbeddedJpeg returns null when there is no complete JPEG', () => {
        assert.equal(extractEmbeddedJpeg(Buffer.from([0, 1, 2, 3, 4, 5])), null);
        assert.equal(extractEmbeddedJpeg(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x40, 1, 2])), null);
    });

    await t('APP/Exif payload markers and nested JPEG bytes do not truncate the outer preview', () => {
        const nested = fakeJpeg(0x44);
        const app1Payload = Buffer.concat([
            Buffer.from('Exif\0\0MakerNote:', 'binary'), nested,
            Buffer.from('tail bytes', 'ascii'),
        ]);
        const outer = fakeJpeg(0x55, [segment(0xe1, app1Payload)]);
        const raw = Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0]), outer, Buffer.alloc(512, 0x88)]);
        assert.deepEqual(extractEmbeddedJpeg(raw), outer);
    });

    await t('progressive multi-scan JPEG handles stuffed FF, restart markers, and marker payloads', () => {
        const preview = progressiveJpeg();
        const trailer = Buffer.concat([Buffer.alloc(2048, 0x66), Buffer.from([0xff, 0xd9])]);
        const raw = Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0]), preview, trailer]);
        assert.deepEqual(extractEmbeddedJpeg(raw), preview);
        assert.equal(isCompleteJpegContainer(preview), true);
        assert.equal(isCompleteJpegContainer(Buffer.concat([preview, trailer])), false);
    });

    await t('valid MPF JPEG-R image and metadata bytes remain byte-identical', () => {
        const container = mpfJpegContainer();
        const trailer = Buffer.concat([Buffer.alloc(4096, 0x7c), Buffer.from([0xff, 0xd9])]);
        const raw = Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0]), container, trailer]);
        const got = extractEmbeddedJpeg(raw);
        assert.deepEqual(got, container);
        assert.ok(got.includes(Buffer.from('MPF\0', 'binary')));
        assert.ok(got.includes(Buffer.from('hdrgm:Version="1.0"')));
        assert.equal(isCompleteJpegContainer(container), true);
    });

    await t('big-endian MPF index extends the cache through its referenced image', () => {
        const container = mpfJpegContainer({ littleEndian: false });
        const trailer = Buffer.alloc(1024, 0x73);
        const raw = Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0]), container, trailer]);
        assert.deepEqual(extractEmbeddedJpeg(raw), container);
        assert.equal(isCompleteJpegContainer(container), true);
    });

    await t('malformed MPF image ranges fail closed instead of returning only the primary JPEG', () => {
        const valid = mpfJpegContainer();
        const broken = Buffer.from(valid);
        const mpfAt = broken.indexOf(Buffer.from('MPF\0', 'binary'));
        // The TIFF header begins just after the MPF signature; the second MP Entry's offset is
        // the fourth word in that entry. Point it beyond the file and truncate before the secondary
        // image so no standalone secondary can be mistaken for a complete replacement.
        const tiffStart = mpfAt + 4;
        const secondEntryOffset = tiffStart + 50 + 16 + 8;
        broken.writeUInt32LE(0xfffffff0, secondEntryOffset);
        const secondaryAt = valid.indexOf(Buffer.from([0xff, 0xd8]), valid.indexOf(Buffer.from('MPF\0', 'binary')) + 4);
        assert.ok(secondaryAt > 0);
        assert.equal(extractEmbeddedJpeg(broken.subarray(0, secondaryAt)), null);
    });

    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hdrthumb-'));
    const sidecarRoot = path.join(root, '.hdrtoys');
    const jpeg = fakeJpeg(0x01);
    await fs.writeFile(path.join(root, 'photo.jpg'), jpeg);
    await fs.writeFile(path.join(root, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    const preview = fakeJpeg(0x02, [segment(0xe0, Buffer.alloc(300, 0x7a))]);
    const trailer = Buffer.concat([Buffer.alloc(128 * 1024, 0x4a), Buffer.from([0xff, 0xd9])]);
    const raw = Buffer.concat([Buffer.alloc(64, 0), preview, trailer]);
    await fs.writeFile(path.join(root, 'capture.arw'), raw);
    await fs.writeFile(path.join(root, 'scene.exr'), Buffer.from([0x76, 0x2f, 0x31, 0x01, 9, 9]));

    const { server, base } = await startServer(root, sidecarRoot);
    try {
        await t('asset list points thumbnailUrl at /thumb', async () => {
            const j = await (await fetch(`${base}/assets`)).json();
            assert.ok(j.assets.every((a) => /\/thumb$/.test(a.thumbnailUrl)), 'all thumbnailUrls end in /thumb');
        });

        await t('raster thumb is served inline with its exact source bytes', async () => {
            const id = encodeId('photo.jpg');
            const r = await fetch(`${base}/assets/${id}/thumb`);
            assert.equal(r.status, 200);
            assert.equal(r.headers.get('content-type'), 'image/jpeg');
            assert.equal(r.headers.get('content-disposition'), null);
            assert.deepEqual(Buffer.from(await r.arrayBuffer()), jpeg);
        });

        await t('thumb sends CORP so a COEP embedder can load the image', async () => {
            const id = encodeId('photo.jpg');
            const r = await fetch(`${base}/assets/${id}/thumb`);
            assert.equal(r.headers.get('cross-origin-resource-policy'), 'cross-origin');
        });

        await t('RAW thumb cold request writes exact preview to versioned cache', async () => {
            const id = encodeId('capture.arw');
            const r = await fetch(`${base}/assets/${id}/thumb`);
            assert.equal(r.status, 200);
            assert.equal(r.headers.get('content-type'), 'image/jpeg');
            const bytes = Buffer.from(await r.arrayBuffer());
            assert.deepEqual(bytes, preview);
            assert.deepEqual(await fs.readFile(thumbCachePath(sidecarRoot, id)), preview);
        });

        await t('RAW thumb warm request returns identical cached bytes', async () => {
            const id = encodeId('capture.arw');
            const r = await fetch(`${base}/assets/${id}/thumb`);
            assert.equal(r.status, 200);
            assert.deepEqual(Buffer.from(await r.arrayBuffer()), preview);
        });

        await t('bad legacy cache is skipped, preserved, and repaired through the cold route', async () => {
            const id = encodeId('legacy.arw');
            const legacyPreview = fakeJpeg(0x03);
            const legacyTrailer = Buffer.concat([Buffer.alloc(128 * 1024, 0), Buffer.from([0xff, 0xd9])]);
            const badLegacyCache = Buffer.concat([legacyPreview, legacyTrailer]);
            const goodPreview = fakeJpeg(0x7b, [segment(0xe0, Buffer.alloc(256, 0x6a))]);
            await fs.writeFile(path.join(root, 'legacy.arw'), Buffer.concat([Buffer.alloc(24, 0), goodPreview, trailer]));
            await fs.writeFile(legacyThumbCachePath(sidecarRoot, id), badLegacyCache);

            const r = await fetch(`${base}/assets/${id}/thumb`);
            assert.equal(r.status, 200);
            assert.deepEqual(Buffer.from(await r.arrayBuffer()), goodPreview);
            assert.deepEqual(await fs.readFile(thumbCachePath(sidecarRoot, id)), goodPreview);
            assert.deepEqual(await fs.readFile(legacyThumbCachePath(sidecarRoot, id)), badLegacyCache,
                'the old bytes remain available as migration evidence');

            const warm = await fetch(`${base}/assets/${id}/thumb`);
            assert.equal(warm.status, 200);
            assert.deepEqual(Buffer.from(await warm.arrayBuffer()), goodPreview);
        });

        await t('valid legacy JPEG cache remains readable without destructive migration', async () => {
            const id = encodeId('valid-legacy.arw');
            const source = fakeJpeg(0x17);
            const legacy = fakeJpeg(0x38, [segment(0xe1, Buffer.from('Exif\0\0legacy'))]);
            await fs.writeFile(path.join(root, 'valid-legacy.arw'), source);
            await fs.writeFile(legacyThumbCachePath(sidecarRoot, id), legacy);
            const r = await fetch(`${base}/assets/${id}/thumb`);
            assert.equal(r.status, 200);
            assert.deepEqual(Buffer.from(await r.arrayBuffer()), legacy);
            assert.deepEqual(await fs.readFile(legacyThumbCachePath(sidecarRoot, id)), legacy);
            await assert.rejects(fs.stat(thumbCachePath(sidecarRoot, id)), { code: 'ENOENT' });
        });

        await t('versioned cache takes precedence over a valid legacy cache', async () => {
            const id = encodeId('both-caches.arw');
            const source = fakeJpeg(0x19);
            const current = fakeJpeg(0x2a, [segment(0xe1, Buffer.from('Exif\0\0v2'))]);
            const legacy = fakeJpeg(0x3b, [segment(0xe1, Buffer.from('Exif\0\0legacy'))]);
            await fs.writeFile(path.join(root, 'both-caches.arw'), source);
            await fs.writeFile(thumbCachePath(sidecarRoot, id), current);
            await fs.writeFile(legacyThumbCachePath(sidecarRoot, id), legacy);
            const r = await fetch(`${base}/assets/${id}/thumb`);
            assert.equal(r.status, 200);
            assert.deepEqual(Buffer.from(await r.arrayBuffer()), current);
            assert.deepEqual(await fs.readFile(legacyThumbCachePath(sidecarRoot, id)), legacy);
        });

        await t('EXR without system thumbnails returns 404', async () => {
            const id = encodeId('scene.exr');
            const r = await fetch(`${base}/assets/${id}/thumb`);
            assert.equal(r.status, 404);
        });

        await t('kind filter returns only matching kinds', async () => {
            const j = await (await fetch(`${base}/assets?kind=raw`)).json();
            assert.equal(j.assets.length, 4);
            assert.ok(j.assets.every((asset) => asset.kind === 'raw'));
        });
    } finally {
        await new Promise((resolve) => server.close(resolve));
        await fs.rm(root, { recursive: true, force: true });
    }

    if (failures) { process.stderr.write(`\n${failures} test(s) failed\n`); process.exit(1); }
    process.stdout.write('\nall thumb tests passed\n');
}

main();
