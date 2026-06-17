// OS-generated ("system") thumbnails — the same small previews Explorer, Finder,
// and Nautilus show. Used so the editor's library grid loads fast, small images
// instead of full-resolution originals, and so types with no in-browser decoder
// (RAW without an embedded preview, EXR, etc.) still get a picture.
//
//   • macOS   → `qlmanage -t` (QuickLook). Handles photos, RAW, HEIC, PDF, …
//   • Windows → IShellItemImageFactory::GetImage via PowerShell P/Invoke (the
//               real shell thumbnail, incl. RAW/HEIC when a codec is installed).
//   • Linux   → `gdk-pixbuf-thumbnailer` (GNOME) when present.
//
// Everything here is BEST-EFFORT: any failure (tool missing, unsupported type,
// timeout) resolves to null so the caller falls back to the embedded RAW preview
// or the original bytes. We shell out to OS tools only — still no npm deps.
//
// Spawning a process per file is expensive, so results are cached by the caller
// and we cap concurrency to avoid a spawn storm when a whole grid loads at once.

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const THUMB_PX = 512;     // long-edge size we ask the OS for
const SPAWN_TIMEOUT = 15000;
const MAX_CONCURRENT = 3;

// --- tiny concurrency gate so a 60-image grid doesn't spawn 60 processes ---
let active = 0;
const waiting = [];
function acquire() {
    if (active < MAX_CONCURRENT) { active++; return Promise.resolve(); }
    return new Promise((resolve) => waiting.push(resolve)).then(() => { active++; });
}
function release() {
    active--;
    const next = waiting.shift();
    if (next) next();
}

/** Run a child process, resolving true on exit 0, false on error/timeout/non-zero. */
function runOk(cmd, args) {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (ok) => { if (!settled) { settled = true; clearTimeout(timer); resolve(ok); } };
        let child;
        try {
            child = spawn(cmd, args, { windowsHide: true, stdio: 'ignore' });
        } catch {
            resolve(false);
            return;
        }
        const timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } finish(false); }, SPAWN_TIMEOUT);
        child.on('error', () => finish(false));
        child.on('close', (code) => finish(code === 0));
    });
}

async function withTempDir(fn) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hdrtoys-thumb-'));
    try {
        return await fn(dir);
    } finally {
        fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
}

// --- macOS: QuickLook ---
async function macThumbnail(absPath) {
    return withTempDir(async (dir) => {
        const ok = await runOk('qlmanage', ['-t', '-s', String(THUMB_PX), '-o', dir, absPath]);
        if (!ok) return null;
        // qlmanage writes "<basename>.png" into the output dir.
        const entries = await fs.readdir(dir).catch(() => []);
        const png = entries.find((e) => e.toLowerCase().endsWith('.png'));
        if (!png) return null;
        const bytes = await fs.readFile(path.join(dir, png)).catch(() => null);
        return bytes ? { bytes, contentType: 'image/png' } : null;
    });
}

// --- Linux: gdk-pixbuf-thumbnailer (GNOME); silently absent elsewhere ---
async function linuxThumbnail(absPath) {
    return withTempDir(async (dir) => {
        const out = path.join(dir, 'thumb.png');
        const ok = await runOk('gdk-pixbuf-thumbnailer', ['-s', String(THUMB_PX), absPath, out]);
        if (!ok) return null;
        const bytes = await fs.readFile(out).catch(() => null);
        return bytes ? { bytes, contentType: 'image/png' } : null;
    });
}

// --- Windows: IShellItemImageFactory via PowerShell P/Invoke ---
// The script is written to a temp file once per process (reused across calls).
const WIN_PS1 = `param([Parameter(Mandatory=$true)][string]$Path,[Parameter(Mandatory=$true)][string]$Out,[int]$Size=512)
$ErrorActionPreference='Stop'
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class HdrToysShellThumb {
  [ComImport, Guid("BCC18B79-BA16-442F-80C4-8A59C30C463B"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItemImageFactory {
    [PreserveSig] int GetImage(SIZE size, int flags, out IntPtr phbm);
  }
  [StructLayout(LayoutKind.Sequential)] struct SIZE { public int cx; public int cy; public SIZE(int x,int y){cx=x;cy=y;} }
  [DllImport("shell32.dll", CharSet=CharSet.Unicode, PreserveSig=false)]
  static extern void SHCreateItemFromParsingName(string pszPath, IntPtr pbc, ref Guid riid, out IShellItemImageFactory ppv);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr hObject);
  public static void Save(string src, string dst, int size) {
    Guid iid = new Guid("BCC18B79-BA16-442F-80C4-8A59C30C463B");
    IShellItemImageFactory f;
    SHCreateItemFromParsingName(src, IntPtr.Zero, ref iid, out f);
    IntPtr hbmp;
    // SIIGBF_THUMBNAILONLY (0x8): a real thumbnail, never a generic file icon.
    int hr = f.GetImage(new SIZE(size, size), 0x8, out hbmp);
    if (hr != 0) throw new Exception("GetImage 0x" + hr.ToString("X"));
    using (Bitmap bmp = Image.FromHbitmap(hbmp)) { DeleteObject(hbmp); bmp.Save(dst, ImageFormat.Png); }
  }
}
"@
[HdrToysShellThumb]::Save($Path,$Out,$Size)`;

let winScriptPath = null;
async function winScript() {
    if (winScriptPath) return winScriptPath;
    const p = path.join(os.tmpdir(), 'hdrtoys-shell-thumb.ps1');
    await fs.writeFile(p, WIN_PS1, 'utf8');
    winScriptPath = p;
    return p;
}

async function windowsThumbnail(absPath) {
    const script = await winScript();
    return withTempDir(async (dir) => {
        const out = path.join(dir, 'thumb.png');
        const ok = await runOk('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-File', script, '-Path', absPath, '-Out', out, '-Size', String(THUMB_PX),
        ]);
        if (!ok) return null;
        const bytes = await fs.readFile(out).catch(() => null);
        return bytes ? { bytes, contentType: 'image/png' } : null;
    });
}

/**
 * Generate an OS thumbnail for a file. Returns `{ bytes, contentType }` (PNG) or
 * null when unavailable/unsupported. Concurrency-limited and best-effort.
 */
export async function systemThumbnail(absPath) {
    await acquire();
    try {
        switch (process.platform) {
            case 'darwin': return await macThumbnail(absPath);
            case 'win32': return await windowsThumbnail(absPath);
            case 'linux': return await linuxThumbnail(absPath);
            default: return null;
        }
    } catch {
        return null;
    } finally {
        release();
    }
}
