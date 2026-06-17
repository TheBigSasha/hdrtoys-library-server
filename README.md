# hdr.toys local library server

A tiny, zero-dependency Node server that exposes a folder of photos on your own
machine to **[hdr.toys](https://hdr.toys)** using its host-gallery integration
protocol (the same contract hdr.toys uses to talk to a host photo gallery).

With it running you can:

- Browse your library inside the hdr.toys editor (the Lightroom-style filmstrip).
- Open any photo, edit it in real HDR, and **save the edit back** as a JSON
  recipe — reopen later and the sliders are exactly where you left them.
- Save rendered UltraHDR/SDR exports next to the original.

hdr.toys stays 100% client-side. Your photos never go to hdr.toys' servers — the
browser talks **directly** to this server on your machine (or over your private
Tailscale network). This tool is the only place your images go.

It is intentionally minimal: **no dependencies, one `node` process, plain
files.** Originals are never modified; edits live in a `.hdrtoys/` sidecar folder
inside your library.

---

## What it implements

The protocol's minimum self-hostable subset
(open → edit → save-back → reopen) **plus** the streaming filmstrip list API:

| Endpoint | Protocol § | Status |
| --- | --- | --- |
| `GET /assets` (paginated list) | §3.1 | ✅ |
| `GET /assets/{id}` | §3.2 | ✅ |
| `GET /assets/{id}/raw` (original bytes) | §3.3 / §1.1 | ✅ |
| `GET /assets/{id}/thumb` (renderable preview) | §3.1 `thumbnailUrl` | ✅ |
| `GET /assets?kind=raw` (filter by kind) | §3.1 | ✅ |
| `GET /assets/{id}/recipe` (restore edit) | §3.4 | ✅ |
| `POST /hdrtoys/callback/snapshot` (save edit) | §2.1 | ✅ (seq-monotonic) |
| `POST /hdrtoys/callback/render` (save export) | §2.2 | ✅ |
| `GET /hdrtoys/callback/capabilities` | §2.5 | ✅ |
| CORS + `OPTIONS` preflight, optional bearer token | §1.3 / §2.3 | ✅ |

**Thumbnails.** `thumbnailUrl` points at `GET /assets/{id}/thumb`, which returns
a browser-renderable preview **inline** (no forced download):

- **JPEG / PNG / WebP / GIF / AVIF** → the original bytes (a browser renders
  them directly). Still zero-dependency: there's no decoder to downscale, so the
  preview is full resolution. Fine for local use; add a thumbnailer (e.g.
  `sharp`) if you want smaller transfers for huge libraries.
- **RAW** (`.arw/.cr2/.cr3/.nef/.dng/…`) → the JPEG preview **embedded** in the
  RAW is extracted with a zero-dep marker scan and cached at
  `<sidecar>/<id>.thumb.jpg`, so it's only extracted once. (A browser can't
  decode raw sensor data, so without this RAW files would show as blank
  placeholders.)
- **EXR** → no thumbnail (needs tone mapping a browser won't do); the route
  returns 404 and the editor shows a placeholder.

**Deferred / not yet implemented** (documented so you know what's missing):

- **`hasGainMap` detection** is always `false` (no JPEG/MPF parsing). hdr.toys
  still extracts an embedded gain map on ingest regardless.
- **Variants / history** (§3.5), **rating/flag** filtering and writes
  (§3.1 stretch / §3.6), and **stripped snapshots** (§2.5 `omit`). Latest-only
  recipe storage is used.
- **macOS Photos library** reading **is** supported (read-only) via `--photos`
  or by pointing `--dir` at a `*.photoslibrary` package — see
  [macOS Photos](#macos-photos) below. HEIC originals are skipped (the editor
  can't ingest HEIC yet); reading the Photos SQLite for album/keyword filtering
  is not done.

---

## Install & run

You need **Node.js ≥ 18** (built-in `fetch`/`FormData` are used). Check with
`node --version`.

There's nothing to `npm install` — the server has no dependencies. Clone the
repo (or copy the `tools/hdrtoys-library-server` folder) and run it directly.

### macOS / Linux

```bash
cd tools/hdrtoys-library-server
node bin/hdrtoys-library-server.js --dir ~/Pictures/MyLibrary --port 4317
```

To run it from anywhere, link it onto your PATH:

```bash
npm link            # from tools/hdrtoys-library-server
hdrtoys-library-server --dir ~/Pictures/MyLibrary
```

### Windows (PowerShell)

```powershell
cd tools\hdrtoys-library-server
node bin\hdrtoys-library-server.js --dir "C:\Users\you\Pictures\MyLibrary" --port 4317
```

### Options

```
--dir,    -d  <path>    library folder to serve   (default: current directory)
                       (or a macOS *.photoslibrary package — served read-only)
--photos               serve the default macOS Photos library (~/Pictures)
--port,   -p  <n>       listen port               (default: 4317)
--host        <addr>    bind address              (default: 0.0.0.0)
--token,  -t  <secret>  require Bearer <secret>   (default: none, open locally)
--origin, -o  <origin>  CORS Allow-Origin         (default: *)
--help,   -h            show help
```

On start it prints a ready-to-paste **hdr.toys launch URL** including your
`gallery_api_url` and `gallery_callback_url`. Open that URL and hdr.toys will
ask once for permission to talk to your server (per-host consent), then show
your filmstrip.

> **Security note.** With no `--token`, anyone who can reach the port can read
> and write your library. On a trusted single-user machine bind to localhost
> (`--host 127.0.0.1`). When exposing over a network, **set a `--token`** and
> restrict `--origin` to `https://hdr.toys`.

---

## Connecting hdr.toys

1. Start the server. Copy the launch URL it prints, or build your own:

   ```
   https://hdr.toys/?gallery_api_url=http://127.0.0.1:4317/
                    &gallery_callback_url=http://127.0.0.1:4317/hdrtoys/callback
                    &filmstrip=1
   ```
   (URL-encode and put it on one line.)

2. hdr.toys tries a **direct browser fetch** to your server first. Because your
   browser is on the same machine/VPN, this works without any proxy. Grant the
   one-time consent prompt naming your host.

3. Pick a photo from the filmstrip, edit, and press **Ctrl/Cmd+S** to push the
   recipe (and, on export, the rendered image) back to disk. Reopen the same
   photo later — your edit is restored.

---

## Edit from your phone with Tailscale

[Tailscale](https://tailscale.com) puts your devices on one private network so
your phone can reach the library server running on your desktop — no port
forwarding, no public exposure.

1. **Install Tailscale** on both the machine running this server and your phone,
   and log into the same tailnet. Each device gets a stable `100.x.y.z` address
   and a name like `desktop.your-tailnet.ts.net`.

2. **Run the server bound to all interfaces** (the default `--host 0.0.0.0`) so
   the tailnet address can reach it, and **set a token** since it's now network-
   reachable:

   ```bash
   hdrtoys-library-server --dir ~/Pictures/MyLibrary --token "$(openssl rand -hex 16)" \
     --origin https://hdr.toys
   ```

3. **Find your tailnet address.** The server prints a `LAN API base:` line on
   start; on a tailnet that's usually your `100.x` Tailscale IP. You can also
   run `tailscale ip -4` or use the MagicDNS name
   `http://desktop.your-tailnet.ts.net:4317`.

4. **On your phone**, open hdr.toys with that address:

   ```
   https://hdr.toys/?gallery_api_url=http://desktop.your-tailnet.ts.net:4317/
                    &gallery_callback_url=http://desktop.your-tailnet.ts.net:4317/hdrtoys/callback
                    &gallery_token=YOUR_TOKEN
                    &filmstrip=1
   ```

   hdr.toys fetches directly from your phone's browser over the tailnet; the
   public hdr.toys server never sees your photos.

> **HTTPS / mixed content.** hdr.toys is served over `https`, and browsers block
> `https` pages from fetching plain `http`. Two ways around it:
> - Use Tailscale's **HTTPS certificates** (`tailscale cert` + `tailscale serve`)
>   to expose the server as `https://desktop.your-tailnet.ts.net`, then use that
>   in `gallery_api_url`. Recommended.
> - Or run hdr.toys locally over http for testing.
>
> `localhost`/`127.0.0.1` is exempt from the mixed-content block, which is why
> the desktop flow works over plain http but the phone flow needs HTTPS.

---

## macOS Photos

Serve your system **Photos** library directly:

```bash
# the default library at ~/Pictures/Photos Library.photoslibrary
hdrtoys-library-server --photos

# or a specific library package
hdrtoys-library-server --dir "/Volumes/Ext/Family.photoslibrary"
```

How it works and what it guarantees:

- The library reads originals from the package's **`originals/`** subtree. The
  `.photoslibrary` package is **served strictly read-only — it is never written
  to**, so the Photos database can't be corrupted by editing.
- Recipes and rendered exports go to a sidecar folder placed **next to** the
  package, named `<library-name>.photoslibrary.hdrtoys/` — not inside it. The
  startup banner prints exactly where edits land.
- **HEIC originals are skipped** (the common iPhone format). hdr.toys currently
  ingests only JPEG/EXR/RAW, so listing HEIC would just surface assets it can't
  open. JPEG, RAW, and EXR originals show up in the filmstrip.
- With iCloud **"Optimize Mac Storage"**, some originals live only in the cloud
  and aren't on disk; the server serves whatever has actually been downloaded.
  Turn on *Download Originals to this Mac* (Photos → Settings → iCloud), or use
  the export path below, to see everything.

Asset **names** are the on-disk UUID filenames Photos uses; album/keyword/date
filtering (which lives in `database/Photos.sqlite`) is not read yet.

**Alternative — export to a folder.** If you'd rather not point at the package,
use **File → Export → Export Unmodified Originals** to a plain folder and serve
that with `--dir`. Edits then land in that folder's own `.hdrtoys/` sidecar.

---

## How storage works

- **Asset id** = URL-safe base64 of the file's path relative to the library
  root. Stable across restarts; never leaks absolute paths; path-traversal is
  rejected.
- **Recipes** → `<sidecar>/<id>.recipe.json` (latest only; older `seq`s for the
  same client are dropped per protocol §2.4).
- **Renders** → `<sidecar>/<id>.renders/<filename>`.
- **RAW thumbnail cache** → `<sidecar>/<id>.thumb.jpg` (the extracted embedded
  preview; safe to delete, it's regenerated on demand).
- **Sidecar location.** For a plain folder it's `<root>/.hdrtoys/`. For a macOS
  Photos library it's `<library-name>.photoslibrary.hdrtoys/` *beside* the
  package, so the library itself stays untouched.
- **Originals are never written.** Delete the sidecar to forget all edits.

---

## Testing

```bash
node test/smoke.test.js
```

Spins the server on a temp library and exercises the full roundtrip (list → raw
→ snapshot save → seq-monotonic drop → recipe restore → multipart render upload
→ traversal rejection) in-process, with no dependencies.
