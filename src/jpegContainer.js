// Structural JPEG extent parsing for the library server's RAW-preview path.
// This follows the entropy-aware scan already used by hdr.toys' JPEG container
// inspection: APP payloads are skipped by their declared lengths, stuffed FF
// bytes and restart markers stay in the scan, and progressive scans resume at
// the next structural marker. No pixels are decoded or rewritten.

const MARKER = 0xff;
const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const APP2 = 0xe2;
const MPF_SIGNATURE = [0x4d, 0x50, 0x46, 0x00]; // "MPF\0"
const HEADER_SCAN_BYTES = 4 * 1024 * 1024;
const MAX_MARKERS_PER_IMAGE = 4096;
const MAX_MPF_IMAGES = 256;

function hasBytes(bytes, start, expected) {
    if (start < 0 || start + expected.length > bytes.length) return false;
    for (let i = 0; i < expected.length; i++) {
        if (bytes[start + i] !== expected[i]) return false;
    }
    return true;
}

function readU16(bytes, offset, littleEndian) {
    if (offset < 0 || offset + 2 > bytes.length) return null;
    return littleEndian
        ? bytes[offset] | (bytes[offset + 1] << 8)
        : (bytes[offset] << 8) | bytes[offset + 1];
}

function readU32(bytes, offset, littleEndian) {
    if (offset < 0 || offset + 4 > bytes.length) return null;
    if (littleEndian) {
        return (bytes[offset] | (bytes[offset + 1] << 8)
            | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
    }
    return ((bytes[offset] << 24) | (bytes[offset + 1] << 16)
        | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

/** Parse the MP Index embedded in an APP2 MPF segment, without trusting its offsets. */
function parseMpfIndex(bytes, markerOffset, segmentEnd) {
    const payloadStart = markerOffset + 4;
    if (!hasBytes(bytes, payloadStart, MPF_SIGNATURE)) return { present: false };

    const tiffStart = payloadStart + MPF_SIGNATURE.length;
    if (tiffStart + 8 > segmentEnd) return { present: true, valid: false };
    const littleEndian = bytes[tiffStart] === 0x49 && bytes[tiffStart + 1] === 0x49;
    const bigEndian = bytes[tiffStart] === 0x4d && bytes[tiffStart + 1] === 0x4d;
    if (!littleEndian && !bigEndian) return { present: true, valid: false };
    if (readU16(bytes, tiffStart + 2, littleEndian) !== 42) return { present: true, valid: false };

    const ifdOffset = readU32(bytes, tiffStart + 4, littleEndian);
    if (ifdOffset == null) return { present: true, valid: false };
    const ifdStart = tiffStart + ifdOffset;
    const entryCount = readU16(bytes, ifdStart, littleEndian);
    if (entryCount == null || entryCount > 512) return { present: true, valid: false };
    const ifdEnd = ifdStart + 2 + entryCount * 12 + 4;
    if (ifdEnd > segmentEnd) return { present: true, valid: false };

    let numberOfImages = null;
    let mpEntryCount = null;
    let mpEntryOffset = null;
    for (let i = 0; i < entryCount; i++) {
        const entry = ifdStart + 2 + i * 12;
        const tag = readU16(bytes, entry, littleEndian);
        const type = readU16(bytes, entry + 2, littleEndian);
        const count = readU32(bytes, entry + 4, littleEndian);
        if (tag == null || type == null || count == null) return { present: true, valid: false };
        if (tag === 0xb001) {
            if (numberOfImages !== null || type !== 4 || count !== 1) return { present: true, valid: false };
            numberOfImages = readU32(bytes, entry + 8, littleEndian);
        } else if (tag === 0xb002) {
            if (mpEntryCount !== null || type !== 7) return { present: true, valid: false };
            mpEntryCount = count;
            mpEntryOffset = readU32(bytes, entry + 8, littleEndian);
        }
    }

    if (!Number.isInteger(numberOfImages) || numberOfImages < 1 || numberOfImages > MAX_MPF_IMAGES
        || mpEntryCount !== numberOfImages * 16 || mpEntryOffset == null) {
        return { present: true, valid: false };
    }
    const entriesStart = tiffStart + mpEntryOffset;
    const entriesEnd = entriesStart + mpEntryCount;
    if (entriesStart < tiffStart || entriesEnd > segmentEnd) return { present: true, valid: false };

    const images = [];
    for (let i = 0; i < numberOfImages; i++) {
        const entry = entriesStart + i * 16;
        const size = readU32(bytes, entry + 4, littleEndian);
        const offset = readU32(bytes, entry + 8, littleEndian);
        if (size == null || offset == null || size < 4) return { present: true, valid: false };
        images.push({ size, offset });
    }
    return { present: true, valid: true, tiffStart, images };
}

/** Walk one JPEG's marker/scan structure and return its first true EOI boundary. */
function scanJpeg(bytes, start) {
    if (start < 0 || start + 1 >= bytes.length || bytes[start] !== MARKER || bytes[start + 1] !== SOI) return null;

    let cursor = start + 2;
    let sawScan = false;
    let markers = 0;
    let mpf = null;
    while (cursor < bytes.length) {
        if (bytes[cursor] !== MARKER || ++markers > MAX_MARKERS_PER_IMAGE) return null;
        cursor += 1;
        while (cursor < bytes.length && bytes[cursor] === MARKER) cursor += 1;
        if (cursor >= bytes.length) return null;
        const marker = bytes[cursor++];
        if (marker === 0x00 || marker === SOI || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) return null;

        if (marker === EOI) return sawScan ? { end: cursor, mpf } : null;
        const markerOffset = cursor - 2;
        if (markerOffset + 3 >= bytes.length) return null;
        const segmentLength = (bytes[markerOffset + 2] << 8) | bytes[markerOffset + 3];
        if (segmentLength < 2) return null;
        const segmentEnd = markerOffset + 2 + segmentLength;
        if (segmentEnd > bytes.length) return null;

        if (marker === APP2) {
            const parsed = parseMpfIndex(bytes, markerOffset, segmentEnd);
            if (parsed.present) {
                if (mpf !== null || !parsed.valid) mpf = { present: true, valid: false };
                else mpf = parsed;
            }
        }

        if (marker !== SOS) {
            cursor = segmentEnd;
            continue;
        }

        sawScan = true;
        cursor = segmentEnd;
        while (cursor < bytes.length) {
            if (bytes[cursor] !== MARKER) {
                cursor += 1;
                continue;
            }
            const entropyMarkerOffset = cursor;
            cursor += 1;
            while (cursor < bytes.length && bytes[cursor] === MARKER) cursor += 1;
            if (cursor >= bytes.length) return null;
            const entropyMarker = bytes[cursor++];
            if (entropyMarker === 0x00 || (entropyMarker >= 0xd0 && entropyMarker <= 0xd7)) continue;
            if (entropyMarker === EOI) return { end: cursor, mpf };
            // A marker other than EOI, stuffed FF, or restart begins syntax after this scan.
            // Rewind so the outer loop can parse its segment length or the next progressive SOS.
            cursor = entropyMarkerOffset;
            break;
        }
        if (cursor >= bytes.length) return null;
    }
    return null;
}

/** Extend a primary JPEG through every MPF-indexed image, validating each exact byte range. */
function completeJpegExtent(bytes, start) {
    const primary = scanJpeg(bytes, start);
    if (!primary) return null;
    if (!primary.mpf) return { start, end: primary.end };
    if (!primary.mpf.valid) return null;

    const ranges = [{ start, end: primary.end }];
    const [primaryEntry, ...secondaryEntries] = primary.mpf.images;
    if (primaryEntry.offset !== 0 || primaryEntry.size !== primary.end - start) return null;

    for (const entry of secondaryEntries) {
        const imageStart = primary.mpf.tiffStart + entry.offset;
        const imageEnd = imageStart + entry.size;
        if (!Number.isSafeInteger(imageStart) || !Number.isSafeInteger(imageEnd)
            || imageStart < primary.end || imageEnd > bytes.length) return null;
        const image = scanJpeg(bytes, imageStart);
        if (!image || image.end !== imageEnd) return null;
        ranges.push({ start: imageStart, end: imageEnd });
    }

    const ordered = [...ranges].sort((a, b) => a.start - b.start);
    for (let i = 1; i < ordered.length; i++) {
        if (ordered[i].start < ordered[i - 1].end) return null;
    }
    return { start, end: Math.max(...ranges.map((range) => range.end)) };
}

/** Return the complete JPEG-container extent at `start`, or null for malformed/truncated data. */
export function jpegContainerExtent(bytes, start = 0) {
    return completeJpegExtent(bytes, start);
}

/** True only when a JPEG (including all MPF images) consumes the complete buffer. */
export function isCompleteJpegContainer(bytes) {
    const extent = completeJpegExtent(bytes, 0);
    return extent != null && extent.end === bytes.length;
}

/** Select the largest structurally complete embedded JPEG container in RAW bytes. */
export function extractEmbeddedJpegContainer(bytes) {
    const length = bytes.length;
    const fastLimit = Math.min(length - 1, HEADER_SCAN_BYTES);
    let best = null;
    const scan = (limit) => {
        for (let i = 0; i < limit; i++) {
            if (bytes[i] !== MARKER || bytes[i + 1] !== SOI) continue;
            const extent = completeJpegExtent(bytes, i);
            if (!extent) continue;
            const candidateLength = extent.end - extent.start;
            if (!best || candidateLength > best.end - best.start) best = extent;
            // A valid outer JPEG or MPF container owns any nested SOIs in its APP payloads/images.
            i = extent.end - 1;
        }
    };

    scan(fastLimit);
    // Some cameras place previews beyond the usual TIFF/RAW header window. Preserve the existing
    // full-buffer fallback when the fast window had no structurally complete candidate.
    if (!best && fastLimit < length - 1) scan(length - 1);
    return best ? bytes.subarray(best.start, best.end) : null;
}
