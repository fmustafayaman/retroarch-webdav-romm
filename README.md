# retroarch-webdav-romm

A minimal WebDAV shim that lets RetroArch's built-in **Cloud Sync** feature
(Settings → Saving → Cloud Sync) use a self-hosted [RomM](https://github.com/rommapp/romm)
instance as its backing store for save files and save states. RomM stays the
single source of truth for saves/states — nothing is stored on a separate
WebDAV volume.

It also exposes RomM's rom library as a real, browsable WebDAV directory
tree under `/roms/`, so it can be mounted as a network drive from iOS
Files (or any WebDAV client) to pull roms onto a device — see "Downloading
roms" below.

## Why not a full WebDAV server library

The project brief called for the `webdav-server` npm package (or `wsgidav`).
After reading RetroArch's actual cloud-sync client source
(`network/cloud_sync/webdav.c`, `tasks/task_cloudsync.c`), it turns out
RetroArch **never sends `PROPFIND`** — it doesn't do directory listings at
all. Instead it diffs a flat JSON manifest (`manifest.server`, an array of
`{path, hash}` entries with MD5 hashes) that it fetches once per sync, and
only ever issues `OPTIONS`, `GET`, `PUT`, `DELETE`, `MKCOL`, and `MOVE` for
individual files. That's a much narrower surface than general-purpose WebDAV
middleware is built for, so this shim is a small hand-rolled HTTP server
(`src/webdavServer.ts`) instead — simpler to reason about than fighting a
PROPFIND-XML-oriented library for verbs it doesn't even use.

The one place real `PROPFIND` support was added is the `/roms/` browsing
tree (`src/webdavXml.ts` builds the `DAV:multistatus` XML) — that part
exists purely for generic WebDAV clients like iOS Files, not for
RetroArch's Cloud Sync, which never touches `/roms/` at all.

## How it works

- `GET /manifest.server` — synthesized on every request from RomM's current
  save/state listing (`saves/<file_name>`, `states/<file_name>` entries).
  RomM is authoritative, so this can never drift out of sync with itself.
  `PUT /manifest.server` (RetroArch writes one back after each sync) is
  accepted and discarded — see `src/manifest.ts`.
- `GET|PUT /saves/<filename>`, `GET|PUT /states/<filename>` — proxied to
  RomM's `/api/saves` / `/api/states` endpoints. The target ROM is matched
  by filename (RetroArch save filenames mirror the ROM filename), per
  `src/assetSync.ts`.
  - **RetroArch consistently nests saves/states under a per-core
    subfolder** (verified live: `saves/Snes9x/Chrono Trigger (USA).srm`,
    same for states) — this is RetroArch's real local directory layout,
    not an edge case. The subfolder is captured on upload and stored on
    RomM's `emulator` field, then used to reconstruct the *exact same*
    subfolder path when building `manifest.server`. This round-trip
    matters more than it looks: RetroArch's sync diffs against the
    manifest by exact path string, so a manifest path missing the
    subfolder RetroArch actually uses locally is treated as a completely
    different, unrelated file — RetroArch would never recognize a match
    and would re-upload the "missing" file (as a brand-new history entry,
    given the point below) on every single sync, forever.
  - **RomM's `emulator` field and RetroArch's local directory name are
    two different strings for the same core**, not the same string in two
    casings — e.g. RomM's convention is `snes9x`, RetroArch's own local
    folder is `Snes9x`; for some cores they diverge further (RomM `mgba`
    → RetroArch `mGBA`, RomM `mupen64plus_next` → RetroArch
    `Mupen64Plus-Next`). Verified live that this is a real, not
    theoretical, problem: naively round-tripping whatever string is
    stored put a downloaded save in a `snes9x` folder RetroArch never
    looks in — the save wasn't just misplaced, it was invisible to
    RetroArch. Fixed with a translation table
    (`src/emulatorNames.ts`, `toRommEmulator`/`toRetroArchDirName`) ported
    from the community
    [romm-retroarch-sync](https://github.com/Covin90/romm-retroarch-sync)
    desktop app, which had already solved this exact problem — the
    captured RetroArch folder name is normalized to RomM's convention
    before upload, and translated back through the same table (with a
    best-effort fallback for unmapped cores) when reconstructing the
    manifest path. This works for *any* entry with the field set, not just
    ones this shim uploaded, so it's correct from the very first sync —
    no "wait for the shim's own upload to self-correct" caveat needed.
  - **RetroArch's auto-savestate filename is `<game>.state.auto` — a
    two-segment suffix, not a single extension.** Verified live: naive
    last-dot splitting (`path.extname`) turns this into
    base=`"<game>.state"`, suffix=`"auto"`, which fails rom lookup (no rom
    is titled `"<game>.state"`) and, separately, would mis-reconstruct the
    manifest path as `<game>.auto` instead of `<game>.state.auto` — RomM's
    own `file_extension` field has the exact same problem, since RomM
    derives it the same naive way. `splitAssetFileName` in
    `src/assetSync.ts` special-cases this (matching the same fix in
    romm-retroarch-sync); numbered slots (`.state1`–`.state9`) and save
    extensions are single-segment and unaffected.
  - **Every upload creates a new history entry — nothing is ever
    overwritten in place.** `GET` always serves back whichever entry for
    that rom/slot was updated most recently; a `PUT` never touches an
    existing row, it always adds a new one. This means a library's
    pre-existing saves/states (from RomM's own native sync, a browser play
    session, a manual upload — anything, not just this shim) show up in
    RetroArch automatically on first sync with no manual step, since
    "most recently updated" naturally includes them — and it means
    nothing this shim does can ever destroy an older save/state, since old
    rows are only ever read, never mutated or replaced. See
    `findAssetForDownload` / `putAssetContent` in `src/assetSync.ts`.
  - **Getting real create-a-new-row semantics out of RomM took an extra
    step.** Verified against a live instance: `POST /api/saves` and
    `/api/states` both dedupe on `(rom_id, filename)` specifically — a
    second upload with the same filename silently replaces the first
    regardless of `slot` or the `overwrite` query flag. Since RetroArch
    always sends the same filename for a given save/state slot, every
    upload would otherwise collide. The fix: the shim stamps a timestamp
    into the filename it sends to RomM (`withUniqueSuffix` in
    `src/assetSync.ts`) — RetroArch never sees this name, since
    `manifest.server` always reconstructs the plain expected filename from
    the rom + the asset's own extension, not from whatever RomM stored it
    as.
  - **Saves are still matched by `(rom, slot)` for anything write-shaped**
    (find-the-shim's-own-row-to `DELETE`), not by filename — on top of the
    dedup issue above, `POST /api/saves` separately appends its own
    `[<timestamp>]` suffix to the stored filename regardless of what's
    sent, so a save could never be found again by name either way. The
    shim tags every save it creates with a fixed `slot`
    (`ROMM_SAVE_SLOT`, default `autosave` — not arbitrary: it's the same
    slot name RomM's own reference clients report a game's primary save
    under, per romm-retroarch-sync, so saves from this shim pair with
    rather than fragment away from anything else in the setup using that
    convention) and matches deletes on `(rom_id, slot)` instead. States
    have no slot field in this RomM version, so a shim-owned state for
    `DELETE` purposes is instead recognized by the `withUniqueSuffix`
    naming pattern itself.
  - **RomM's rom search (`search_term`) doesn't handle fully tagged
    filenames.** Searching for `"Silent Hill (Europe) (En,Fr,De,Es,It)"`
    verbatim returns zero results on a live instance, even though the rom
    exists — it's a relevance search over the bare title, not a substring
    match. The shim strips `(...)`/`[...]` tag groups before searching
    (`stripTags` in `src/rommClient.ts`) and only relies on the exact
    tagged filename for the final match against `fs_name_no_ext`/`fs_name`.
- `DELETE` — best-effort. Failures are logged and still answered with `204`,
  since RetroArch treats cloud sync deletes as fire-and-forget.
- `MOVE` — RetroArch only issues this to back a file up under `deleted/...`
  before a non-destructive delete. Treated as a delete of the source file.
- Anything outside `saves/` and `states/` (i.e. `config/`, `thumbnails/`,
  `system/`) — RomM has no generic blob store for these, so `PUT` is
  accepted and silently discarded (logged as a warning) and `GET` 404s.
  **Disable "Configuration", "Thumbnails", and "System Files" sync in
  RetroArch's Cloud Sync settings** and leave only "Save Files & States" on
  — see Known limitations below.
- Auth: RetroArch (and Files/other WebDAV clients) authenticate to the shim
  with HTTP Basic Auth (`WEBDAV_USERNAME`/`WEBDAV_PASSWORD`). The shim
  authenticates to RomM with a single static RomM account, either a client
  token (`ROMM_API_TOKEN`, sent as `Authorization: Bearer`) or
  `ROMM_USERNAME`/`ROMM_PASSWORD` (sent as HTTP Basic) — RomM accepts both
  directly on every endpoint used here, so there's no OAuth2 token/refresh
  flow to manage for this single-user setup.

## Configuring RetroArch

Settings → Saving → Cloud Sync:

| Setting | Value |
|---|---|
| Cloud Sync Driver | WebDAV |
| Cloud Sync URL | `https://<your-shim-host>/` (must end in `/`) |
| Cloud Sync Username | value of `WEBDAV_USERNAME` |
| Cloud Sync Password | value of `WEBDAV_PASSWORD` |
| Sync Saves | On |
| Sync Configuration | **Off** (see Known limitations) |
| Sync Thumbnails | **Off** |
| Sync System Files | **Off** |

Then trigger a manual "Sync Now" and check the shim's logs
(`LOG_LEVEL=debug`) if anything looks wrong — RetroArch's own error message
is just "Cloud Sync failed" with no detail.

## Downloading roms

RetroArch itself has no way to browse or pull content from an arbitrary
custom server — its "Online Updater" / buildbot settings are for cores and
UI assets (thumbnails, overlays, shaders, database files), not games, and
there's no general "connect to a content server" feature. So getting roms
onto a device is always a manual step of some kind — there's no automatic
"RetroArch downloads what it's missing" flow to build on given RetroArch's
actual capabilities.

**On iOS, the simplest path is RomM's own web UI, not this shim.** RomM is
a full web app — open `https://<your-romm-host>/` in Safari, log in with
your RomM account, browse, and download. Safari's download manager handles
large files (background downloads, resumable) without needing any extra
app. Verified: **iOS's built-in Files app does not reliably support
"Connect to Server" for arbitrary WebDAV servers** — it failed for a real
deployment of the `/roms/` tree below even though the server side checked
out correctly on every count (curl confirmed proper `207` PROPFIND
responses, correct `text/xml` content type, working fake LOCK/UNLOCK
handshake, and Cloudflare passing PROPFIND through untouched). Multiple
unrelated projects' iOS users report the same "This URL is not supported"
failure against their own WebDAV servers — it's an iOS Files limitation,
not something fixable from the server side. A third-party WebDAV client
app (e.g. "WebDAV Manager", or FileBrowser's Files-app integration) is the
documented workaround if you want to use `/roms/` from iOS instead.

The `/roms/` tree (below) is still there and works — it's just a better
fit for platforms with solid native WebDAV support (Windows, macOS,
Android) than for iOS specifically:

1. Connect to `https://<your-shim-host>/` with a WebDAV client, using
   `WEBDAV_USERNAME`/`WEBDAV_PASSWORD` (same credentials as Cloud Sync
   above).
2. Browse into `roms/<platform>/`, find the game, download it.
3. Move/copy the file into RetroArch's content directory so its own
   content browser picks it up.

See `src/romBrowser.ts` and the PROPFIND handling in `src/webdavServer.ts`.

A few things verified against a live instance that shaped how `/roms/` is
built:

- **RomM zips multi-disc/multi-track roms on download** (with an `.m3u`
  included) but serves single-file roms raw. The listing reflects this —
  multi-file roms show up as `<name>.zip`, everything else keeps its real
  extension. Getting the "is it really one file" signal right took two
  tries: `has_simple_single_file: false` looked like the right check but
  isn't — a rom stored as one file inside its own subfolder reports that
  as `false` too (`has_nested_single_file: true`) while still downloading
  raw, not zipped. Only `has_multiple_files: true` actually triggers
  zipping. Get this wrong and the shim advertises a `.zip` that's actually
  a raw `.chd` (or vice versa), which breaks the download in Files.
- **The real filename for a single-nested-file rom isn't `fs_name`.**
  `fs_name` for those turned out to be the *folder* name with no
  extension (e.g. `"Alundra (USA) (v1.1)"`, not `"....chd"`) — the actual
  filename is on `files[0].file_name`, which the roms list endpoint only
  populates when the request includes `with_files=true` (confirmed by
  testing with and without it; omitting it silently returns `files: []`
  rather than an error, which is an easy way to end up serving
  extensionless files without noticing).
- **`search_term` doesn't handle fully tagged filenames** — same fix as
  the saves matching above, since finding a rom by filename for saves
  reuses this.
- **Range requests only work for single-file roms.** RomM properly
  supports `Range`/`206 Partial Content` on raw single-file downloads
  (confirmed live), which the shim forwards through so Files can resume an
  interrupted download. For zipped multi-file roms, RomM ignores the
  `Range` header and streams the full file with `200 OK` regardless —
  confirmed live on a ~793MB, 3-file rom. A dropped connection on a
  multi-GB multi-disc game means starting over from zero; there's no fix
  on this end since the zip is generated on the fly server-side.
- **Rom sizes shown while browsing a multi-file rom's folder are
  approximate.** RomM reports `fs_size_bytes` as the sum of the underlying
  files, not the size of the zip it actually produces (compression +
  `.m3u` overhead). Only affects what Files displays before downloading —
  the actual transfer always uses the real `Content-Length` from RomM's
  response, so nothing is truncated or misreported once the download
  starts.

## Configuration (env vars)

See `.env.example`. All required, no hardcoded secrets in code:

- `ROMM_BASE_URL` — the RomM instance. Plus either `ROMM_API_TOKEN` or
  `ROMM_USERNAME`/`ROMM_PASSWORD` — the RomM account whose saves/states/roms
  are exposed.
- `ROMM_SAVE_SLOT` — fixed slot tag the shim uses for saves it creates
  (default `autosave`, matching RomM's own reference clients — see above).
  Only change this if running more than one instance of this shim against
  the same RomM account.
- `WEBDAV_USERNAME`, `WEBDAV_PASSWORD` — credentials RetroArch authenticates
  with against this shim.
- `PORT`, `BIND_ADDRESS` — shim's own listen socket (defaults `8080` /
  `0.0.0.0`).
- `LOG_LEVEL` — `trace|debug|info|warn|error`. `debug` logs every WebDAV
  request (verb + path) and the RomM API call it triggered.

## Running

```bash
npm install
cp .env.example .env   # fill in values
npm run dev             # or: npm run build && npm start
```

```bash
docker build -t retroarch-webdav-romm .
docker run --env-file .env -p 8080:8080 retroarch-webdav-romm
```

`docker-compose.yml` is set up to deploy on Dokploy or Coolify alongside an
existing RomM instance/stack — set the env vars in the platform UI (or a
mounted `.env`), and optionally join RomM's Compose network instead of
publishing the port directly if the platform's reverse proxy will route to
it internally.

## Known limitations

- **Config/thumbnails/system sync is out of scope.** RomM has no generic
  file store for these, so leave those RetroArch cloud-sync categories off.
  Turning them on won't break anything (writes are silently discarded,
  reads 404 which RetroArch treats as "not present yet"), it'll just do
  pointless work every sync.
- **Save states are core/version-specific.** If you sync a save state made
  with core version A and load it with core version B, RetroArch/the core
  may reject it. That's a RetroArch/libretro-core limitation, not something
  this shim can fix.
- **No real conflict detection** — the newest `updated_at` always wins on
  read, full stop. If a save is modified from two devices between syncs,
  whichever one uploaded most recently is what every device sees next; the
  other device's change isn't lost (its row is kept, per the history
  behavior above) but it's also not surfaced as a conflict anywhere. A
  real fix would mean actual divergence detection, which is out of scope
  for v1 — see the brief's "don't try to be clever" guidance.
- **History grows forever, there's no pruning.** Every save/state upload
  is a new row (see above) and nothing here ever deletes old ones
  automatically — `DELETE` only removes the single most recent
  shim-created entry, on RetroArch's own request. Over months of regular
  play this can accumulate a lot of rows per rom. RomM's own UI/API
  (`autocleanup`/`autocleanup_limit` on saves, or manual deletion) is the
  place to prune, not something this shim does on your behalf.
- **Filename-only ROM matching.** The rom to sync against is still resolved
  from the filename alone (the core subfolder round-trips into RomM's
  `emulator` field for path reconstruction, but isn't used to disambiguate
  *which rom*) — two different cores producing a same-named save file for
  two different ROMs will collide in RomM's per-user save list. Fine for a
  single-user/family library where filenames are already unique.
- **The `emulator`→directory-name table (`src/emulatorNames.ts`) is a
  fixed list of known libretro cores**, ported from romm-retroarch-sync.
  An entry with `emulator` set to something not in the table falls back
  to a best-effort transform (title-case, `beetle_`/`mednafen_` →
  `"Beetle "`, underscores → spaces) rather than a guaranteed-correct
  name — fine for common cores, may need a table entry added for an
  obscure one. An entry with no `emulator` at all still falls back to a
  flat path with no subfolder, same as before.
- **`content_hash` fallback.** RomM's save/state rows may have a null
  `content_hash` (e.g. rows that predate hashing support). The shim falls
  back to a `size-updated_at` fingerprint for the manifest in that case,
  which can't detect a same-size edit inside the same second — it'll just
  cause one extra redundant verification pass on that file, not data loss.
- **Single-user only.** One static RomM account and one static WebDAV
  credential pair, by design — see the project brief's non-goals.
