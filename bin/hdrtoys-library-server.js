#!/usr/bin/env node
// CLI entry point for the hdr.toys local library server.
//
// Usage:
//   hdrtoys-library-server [--dir <path>] [--port <n>] [--host <addr>]
//                          [--token <secret>] [--origin <cors-origin>]
//
// Defaults: dir = current working directory, port = 4317, host = 0.0.0.0
// (0.0.0.0 so a Tailscale/LAN address can reach it; use --host 127.0.0.1 to
// keep it strictly local). Prints the launch URL to paste into hdr.toys.

import os from 'node:os';
import { createServer } from '../src/server.js';
import { resolveLibrary } from '../src/photos.js';

function parseArgs(argv) {
    const out = { dir: process.cwd(), port: 4317, host: '0.0.0.0', token: null, origin: '*', photos: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dir' || a === '-d') out.dir = argv[++i];
        else if (a === '--port' || a === '-p') out.port = Number(argv[++i]);
        else if (a === '--host') out.host = argv[++i];
        else if (a === '--token' || a === '-t') out.token = argv[++i];
        else if (a === '--origin' || a === '-o') out.origin = argv[++i];
        else if (a === '--photos') out.photos = true;
        else if (a === '--help' || a === '-h') { out.help = true; }
    }
    return out;
}

function printHelp() {
    process.stdout.write(`hdrtoys-library-server — serve a local photo folder to hdr.toys

  --dir,    -d  <path>    library folder to serve   (default: cwd)
                         (or a macOS *.photoslibrary package — served read-only)
  --photos               serve the default macOS Photos library (~/Pictures)
  --port,   -p  <n>       listen port               (default: 4317)
  --host        <addr>    bind address              (default: 0.0.0.0)
  --token,  -t  <secret>  require Bearer <secret>   (default: none)
  --origin, -o  <origin>  CORS Allow-Origin         (default: *)
  --help,   -h           show this help
`);
}

function firstNonInternalIPv4() {
    for (const addrs of Object.values(os.networkInterfaces())) {
        for (const a of addrs || []) {
            if (a.family === 'IPv4' && !a.internal) return a.address;
        }
    }
    return null;
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) { printHelp(); return; }

    let lib;
    try {
        lib = await resolveLibrary(opts.dir, { photos: opts.photos });
    } catch (err) {
        process.stderr.write(`error: ${err?.message || err}\n`);
        process.exit(1);
    }

    const server = createServer({
        root: lib.scanRoot,
        sidecarRoot: lib.sidecarRoot,
        kind: lib.kind,
        token: opts.token,
        allowOrigin: opts.origin,
    });
    server.listen(opts.port, opts.host, () => {
        const lan = firstNonInternalIPv4();
        const localBase = `http://127.0.0.1:${opts.port}`;
        process.stdout.write(`\nhdr.toys library server\n`);
        process.stdout.write(`  serving: ${lib.label}${lib.kind === 'macos-photos' ? '  (macOS Photos, read-only)' : ''}\n`);
        if (lib.kind === 'macos-photos') process.stdout.write(`  edits:   ${lib.sidecarRoot}\n`);
        process.stdout.write(`  listen:  ${opts.host}:${opts.port}\n`);
        if (opts.token) process.stdout.write(`  auth:    Bearer token required\n`);
        process.stdout.write(`\n  local API base:   ${localBase}\n`);
        if (lan) process.stdout.write(`  LAN API base:     http://${lan}:${opts.port}\n`);
        const t = opts.token ? `&gallery_token=${encodeURIComponent(opts.token)}` : '';
        process.stdout.write(
            `\n  open in hdr.toys (filmstrip):\n` +
            `    https://hdr.toys/?gallery_api_url=${encodeURIComponent(localBase + '/')}` +
            `&gallery_callback_url=${encodeURIComponent(localBase + '/hdrtoys/callback')}` +
            `&filmstrip=1${t}\n\n`
        );
    });

    const shutdown = () => { server.close(() => process.exit(0)); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main();
