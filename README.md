# retroarch-webdav-romm

A minimal WebDAV shim that lets RetroArch's built-in **Cloud Sync** feature
(Settings → Saving → Cloud Sync) use a self-hosted [RomM](https://github.com/rommapp/romm)
instance as its backing store for save files and save states. RomM stays the
single source of truth for saves/states — nothing is stored on a separate
WebDAV volume.

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

## How it works

- `GET /manifest.server` — synthesized on every request from RomM's current
  save/state listing (`saves/<file_name>`, `states/<file_name>` entries).
  RomM is authoritative, so this can never drift out of sync with itself.
  `PUT /manifest.server` (RetroArch writes one back after each sync) is
  accepted and discarded — see `src/manifest.ts`.
- `GET|PUT /saves/<filename>`, `GET|PUT /states/<filename>` — proxied to
  RomM's `/api/saves` / `/api/states` endpoints. The target ROM is matched
  by filename (RetroArch save filenames mirror the ROM filename), per
  `src/assetSync.ts`. Any subdirectory in the WebDAV path (e.g. if
  RetroArch is configured to sort saves per-core) is ignored — only the
  basename is used to match.
  - **Saves are matched by `(rom, slot)`, not by filename**, and this is
    load-bearing, not incidental. Verified against a live RomM instance:
    `POST /api/saves` silently appends a `[<timestamp>]` suffix to
    whatever filename you send it, so the name a save comes back under is
    never the name it was uploaded with — matching on filename would mean
    every sync "discovers" a brand new file and re-uploads forever. The
    shim tags every save it creates with a fixed `slot` (`ROMM_SAVE_SLOT`,
    default `webdav-shim`) and matches on `(rom_id, slot)` instead, which
    is also what RomM's own sync engine uses as the stable pairing key.
    When building `manifest.server`, the original filename is
    reconstructed from the owning rom's `fs_name_no_ext` + the save's own
    (untouched) extension — not from the save's stored `file_name`.
    States don't have this problem: RomM preserves state filenames
    exactly, so those are matched and reported by filename directly.
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
- Auth: RetroArch authenticates to the shim with HTTP Basic Auth
  (`WEBDAV_USERNAME`/`WEBDAV_PASSWORD`). The shim authenticates to RomM with
  HTTP Basic Auth using a single static RomM account
  (`ROMM_USERNAME`/`ROMM_PASSWORD`) — RomM accepts Basic auth directly on
  every endpoint used here, so there's no OAuth2 token/refresh flow to
  manage for this single-user setup.

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

## Configuration (env vars)

See `.env.example`. All required, no hardcoded secrets in code:

- `ROMM_BASE_URL`, `ROMM_USERNAME`, `ROMM_PASSWORD` — the RomM instance and
  account whose saves/states get synced.
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
- **Conflict handling is last-write-wins**, matching the brief — no real
  three-way merge or divergence detection. If a save is modified from two
  devices between syncs, whichever PUT lands last on RomM wins. A real fix
  would mean tracking per-device revision history, which RomM doesn't
  currently expose.
- **Filename-only ROM matching.** If RetroArch is configured to sort saves
  into per-core subdirectories, two different cores producing a
  same-named save file for two different ROMs will collide in RomM's
  per-user save list (only the basename is used for matching). Fine for a
  single-user/family library where filenames are already unique; would need
  RomM to expose core/subfolder metadata to fix properly.
- **Pre-existing saves not created by this shim won't appear in the
  manifest on first run.** Only saves tagged with the shim's own `slot`
  are included (see above) — saves from RomM's own native sync client, a
  browser play session, or a manual upload are left alone rather than
  guessed at (a rom can have many historical null-slot saves; there's no
  safe way to pick "the" canonical one). The first `PUT` RetroArch sends
  for a rom becomes the new shim-managed save going forward. States are
  unaffected by this — they're matched by filename regardless of origin.
- **`content_hash` fallback.** RomM's save/state rows may have a null
  `content_hash` (e.g. rows that predate hashing support). The shim falls
  back to a `size-updated_at` fingerprint for the manifest in that case,
  which can't detect a same-size edit inside the same second — it'll just
  cause one extra redundant verification pass on that file, not data loss.
- **Single-user only.** One static RomM account and one static WebDAV
  credential pair, by design — see the project brief's non-goals.
