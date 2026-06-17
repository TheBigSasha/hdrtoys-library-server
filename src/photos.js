// macOS Photos library integration.
//
// A modern Photos library is a package directory named `*.photoslibrary` that
// keeps every original you've imported under an `originals/` subtree (sharded
// into hex subfolders, filenames are UUIDs). We serve that subtree read-only:
// the package is NEVER written to. Recipes and rendered exports instead go to a
// sidecar folder placed *next to* the package (`<name>.photoslibrary.hdrtoys/`),
// so editing in hdr.toys can't corrupt the Photos database.
//
// hdr.toys only ingests JPEG/EXR/RAW, so HEIC originals (the common iPhone
// format) are simply skipped by the library scanner — which is the honest,
// correct behavior until the editor gains HEIC support.
//
// Caveat (documented in the README): with iCloud "Optimize Mac Storage", some
// originals live only in the cloud and won't be present on disk; we serve
// whatever is actually downloaded.

import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';

import { defaultSidecarRoot } from './library.js';

const PHOTOS_PKG_SUFFIX = '.photoslibrary';

/** The system default Photos library location on macOS. */
export function defaultPhotosLibraryPath() {
    return path.join(os.homedir(), 'Pictures', 'Photos Library.photoslibrary');
}

/** True if `dir` looks like a Photos library package (by name). */
export function isPhotosLibraryPath(dir) {
    return path.basename(dir).toLowerCase().endsWith(PHOTOS_PKG_SUFFIX);
}

/**
 * Resolve a user-supplied directory (and the `--photos` flag) into a concrete
 * library descriptor the server can serve:
 *   { scanRoot, sidecarRoot, kind, label }
 *
 * - kind 'macos-photos' → scanRoot is `<pkg>/originals`, sidecar is external.
 * - kind 'folder'       → a plainly-served folder, sidecar is `<root>/.hdrtoys`.
 *
 * Throws if a Photos library is requested but its `originals/` can't be read.
 */
export async function resolveLibrary(dir, { photos = false } = {}) {
    let target = dir;
    // `--photos` with no explicit `.photoslibrary` path → use the default one.
    if (photos && !isPhotosLibraryPath(target)) {
        target = defaultPhotosLibraryPath();
    }

    if (isPhotosLibraryPath(target)) {
        const pkg = path.resolve(target);
        const originals = path.join(pkg, 'originals');
        try {
            const stat = await fs.stat(originals);
            if (!stat.isDirectory()) throw new Error('not a directory');
        } catch {
            throw new Error(
                `not a readable Photos library (missing originals/): ${pkg}\n` +
                `  On macOS the default is "${defaultPhotosLibraryPath()}".\n` +
                `  If you use iCloud "Optimize Mac Storage", download originals first,\n` +
                `  or export the photos to a folder and serve that instead.`,
            );
        }
        // Sidecar sits beside the package so the library is never mutated.
        const sidecarRoot = path.join(
            path.dirname(pkg),
            `${path.basename(pkg)}.hdrtoys`,
        );
        return { scanRoot: originals, sidecarRoot, kind: 'macos-photos', label: pkg };
    }

    const root = path.resolve(target);
    try {
        const stat = await fs.stat(root);
        if (!stat.isDirectory()) throw new Error('not a directory');
    } catch {
        throw new Error(`library folder does not exist: ${root}`);
    }
    return {
        scanRoot: root,
        sidecarRoot: defaultSidecarRoot(root),
        kind: 'folder',
        label: root,
    };
}
