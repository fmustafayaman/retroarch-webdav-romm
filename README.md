# retroarch-webdav-romm

A small server that lets RetroArch's built-in **Cloud Sync** feature
(Settings → Saving → Cloud Sync) use a self-hosted [RomM](https://github.com/rommapp/romm)
instance to store your save files and save states. RomM is the only place
data actually lives — this project doesn't store anything itself, it just
translates between "what RetroArch expects from a WebDAV server" and "what
RomM's API actually offers."

It also lets you **browse and download roms, saves, and states** from any
WebDAV client (like the Files app on iOS, or Finder on macOS), read-only.

## Quick start

1. Deploy this alongside your RomM instance (see "Running" below).
2. Fill in `.env` — you need your RomM URL + credentials, and you pick a
   username/password for RetroArch to use.
3. In RetroArch: Settings → Saving → Cloud Sync → point it at this server
   (see "Setting up RetroArch" below).
4. Hit "Sync Now" and check the logs if something looks off.

## How it works, in short

RetroArch's Cloud Sync doesn't understand RomM at all — it only speaks
WebDAV. This project sits in between:

```
RetroArch  <-- WebDAV -->  this shim  <-- RomM's REST API -->  RomM
```

When RetroArch uploads a save, the shim figures out which RomM game it
belongs to (by filename) and stores it there. When RetroArch asks what's
changed, the shim builds the answer by asking RomM what it currently has —
RomM's data is always the source of truth, nothing is cached to disk here.

A good chunk of this behavior only exists because RetroArch and RomM don't
naturally agree with each other on file names, folder structure, or upload
semantics — see **"Details worth knowing"** near the bottom if you're
curious why, or if something isn't syncing the way you'd expect.

## Setting up RetroArch

Settings → Saving → Cloud Sync:

| Setting | Value |
|---|---|
| Cloud Sync Driver | WebDAV |
| Cloud Sync URL | `https://<your-server>/` (must end in `/`) |
| Cloud Sync Username | your `WEBDAV_USERNAME` |
| Cloud Sync Password | your `WEBDAV_PASSWORD` |
| Sync Saves | On |
| Sync Configuration | **Off** |
| Sync Thumbnails | **Off** |
| Sync System Files | **Off** |

Only "Sync Saves" is supported — RomM has nowhere to put config files,
thumbnails, or system files, so leave those off. (If you leave them on
anyway, nothing breaks — they're just silently ignored.)

Trigger a manual **Sync Now** the first time and check the server logs
(`LOG_LEVEL=debug`) if anything looks wrong. RetroArch's own error message
is just "Cloud Sync failed," no detail.

## PSP (PPSSPP) saves

PPSSPP is the one core that doesn't save a single file per game — it
writes several files per save slot (metadata, the actual save, icons),
mimicking a real PSP memory stick. This is handled automatically: the
first time a save shows up for a new game, its `PARAM.SFO` title is
matched against your RomM library to figure out which game it belongs to.
No manual setup needed for the normal case.

If a specific game's title is too stylized for the automatic match to
find it (logged clearly when that happens), you can add an explicit
override in `.env`:

```
PSP_SERIAL_MAP={"ULUS10336":"Crisis Core - Final Fantasy VII (USA)"}
```

The key is the save's serial (the folder name minus its trailing
`DATA<N>`), the value is the game's title exactly as it appears in RomM.

## Downloading roms

RetroArch has no built-in way to browse or download from a custom server —
this isn't something the shim can add, since RetroArch's own file browser
only looks at the local filesystem. So getting a rom onto your device is
always a manual step, using one of:

- **RomM's own web UI** (open `https://<your-romm-host>/` in a browser,
  log in, download) — simplest option, especially on iOS, where Safari's
  download manager handles large files well.
- **A WebDAV client** connected to this server, browsing into
  `roms/<platform>/<game>`. Works well on macOS/Windows/Android. On iOS,
  the built-in Files app's WebDAV support is unreliable for this — a
  third-party client (Cyberduck, Transmit, FileBrowser, ...) works better.

Either way, once downloaded, move the file into RetroArch's own content
folder so its game browser picks it up.

## Browsing saves and states

`roms/`, `saves/`, and `states/` are all browsable directory trees over
WebDAV — connect with any WebDAV client and look around. This is purely
for humans; RetroArch's own sync never lists directories, so nothing here
affects how syncing works.

What you see always matches what RetroArch would sync, because it's built
from the same data. For PPSSPP saves, you'll see each individual file
inside a save bundle rather than one opaque zip.

**A note on speed:** browsing can feel slow on iOS specifically, because
Apple's Files app quietly checks for a hidden companion file for every
single item it lists, one at a time. This is harmless (nothing is created
or touched) but adds up over a large library. It's a Files app quirk, not
something the server does — a non-Apple WebDAV client skips this and
browses noticeably faster.

## Configuration

See `.env.example` for the full list with comments. The essentials:

| Variable | Meaning |
|---|---|
| `ROMM_BASE_URL` | Your RomM instance's URL |
| `ROMM_API_TOKEN` **or** `ROMM_USERNAME`/`ROMM_PASSWORD` | RomM account this shim acts as |
| `WEBDAV_USERNAME` / `WEBDAV_PASSWORD` | Credentials RetroArch (and any WebDAV client) authenticates with |
| `ROMM_SAVE_SLOT` | Save slot tag, default `autosave` — leave as-is unless running multiple instances against the same RomM account |
| `PSP_SERIAL_MAP` | Optional PSP title overrides — see above |
| `PORT`, `BIND_ADDRESS` | Where the server listens (default `8080`, `0.0.0.0`) |
| `LOG_LEVEL` | `trace\|debug\|info\|warn\|error` |
| `CACHE_TTL_SECONDS` | How long RomM listing results are cached in memory (default `30`, `0` disables) — keeps browsing fast without hammering RomM |

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
existing RomM stack — set the env vars in the platform's UI (or a mounted
`.env`), and optionally join RomM's Compose network instead of publishing
the port directly if the platform's reverse proxy will route to it
internally.

## Known limitations

- **One RomM account, one WebDAV login.** This is a single-user tool by
  design, not a multi-tenant server.
- **No real conflict resolution.** If you save from two devices between
  syncs, whichever upload happened most recently is what every device
  sees next. The other save isn't deleted, just not surfaced as a
  conflict — RomM keeps every upload as history.
- **History isn't pruned automatically.** Every save/state upload adds a
  new row in RomM rather than replacing the old one. Over months of play
  this adds up — use RomM's own cleanup tools (or manual deletion) to
  prune old saves, this shim won't do it for you.
- **Games are matched by filename.** Two different games that happen to
  produce a save with the same filename would collide. Not an issue for a
  normal personal library where filenames are already unique.
- **Save states are core/version-specific**, same as vanilla RetroArch —
  loading a state made with a different core version can fail. Nothing to
  do with this shim.

## Details worth knowing

<details>
<summary>Why not a real WebDAV server library</summary>

The obvious choice would've been an existing `webdav-server` package. But
after reading RetroArch's actual sync code
(`network/cloud_sync/webdav.c`), it turns out RetroArch **never sends
`PROPFIND`** for syncing — it just diffs a flat JSON file list
(`manifest.server`) and issues plain `GET`/`PUT`/`DELETE`/`MOVE` per file.
That's a narrow enough surface that a small hand-rolled server
(`src/webdavServer.ts`) was simpler than fighting a general-purpose
library built for a much bigger protocol. `PROPFIND` (directory listing)
*was* added, but only for the human-browsing feature — RetroArch's own
sync never touches it.

</details>

<details>
<summary>How saves/states actually map onto RomM's API</summary>

- **RetroArch nests saves/states in a per-core subfolder**
  (`saves/Snes9x/Chrono Trigger.srm`), and this has to round-trip through
  RomM's `emulator` field correctly, or RetroArch treats every synced file
  as "still missing" and re-uploads it forever. RomM's own naming
  convention for that field (`snes9x`) isn't the same string as
  RetroArch's folder name (`Snes9x`) — sometimes wildly different
  (`mupen64plus_next` vs `Mupen64Plus-Next`) — so there's a translation
  table (`src/emulatorNames.ts`, ported from the community
  [romm-retroarch-sync](https://github.com/Covin90/romm-retroarch-sync)
  project).
- **RetroArch's auto-savestate file is named `<game>.state.auto`** — a
  two-part suffix that naive extension-splitting mishandles (splits into
  `.state` + `auto`, which then fails to match anything). Handled as a
  special case.
- **Every upload becomes a new row in RomM, never overwriting the last
  one.** This means older saves are never lost, and it's also *why* a
  library's pre-existing saves/states (from RomM's browser player, manual
  uploads, whatever) automatically show up in RetroArch the first time you
  sync — reads just look for whatever's newest, regardless of who created
  it.
- **RomM silently overwrites an upload with the same filename**, which
  would otherwise break the "keep every upload as history" behavior above
  — RetroArch always uploads the same filename for a given save slot. The
  fix is a timestamp stamped into the filename actually sent to RomM;
  RetroArch never sees this, since the shim always reconstructs the plain
  filename it expects.
- **RomM's rom search doesn't handle fully tagged filenames** like
  `Silent Hill (Europe) (En,Fr,De,Es,It)` — it's relevance search over the
  bare title, not substring matching. Tags are stripped before searching,
  then the exact tagged filename is used for the final match.

</details>

<details>
<summary>Why PUT failures always return 204, never an error</summary>

RetroArch's own WebDAV client has a real bug: any non-2xx response runs
through a code path with a one-byte heap buffer overflow (RetroArch's own
source comment describes it), which can corrupt the heap and crash the app
— worse under a burst of failing requests in a row. This was reproduced
live: a run of genuinely-failing uploads crashed RetroArch at the same
point, twice. Since that can't be fixed from this end, failures are logged
here but the response sent back to RetroArch is always `204`, so it never
sees an error status that could trigger the bug.

</details>

<details>
<summary>PSP save bundling details</summary>

PPSSPP writes several files per save slot (metadata, save data, icons) as
separate WebDAV uploads a fraction of a second apart. These get bundled
into a single zip stored as one RomM save, and unbundled again on
download/browsing. A few things that had to be handled carefully:

- Files can arrive in any order, and only `PARAM.SFO`'s title lets a new
  save folder be matched to a game — so anything that arrives first is
  buffered in memory rather than dropped, and merged in once the match is
  found.
- Unlike normal saves/states, each save event replaces the previous PSP
  bundle rather than keeping every intermediate state as history — the
  in-between states (mid-merge) aren't meaningful checkpoints on their
  own.
- RomM has no PSP serial field, so games are matched by comparing
  `PARAM.SFO`'s title against RomM's titles after normalizing away
  punctuation/casing differences.

</details>

<details>
<summary>Why RomM listing calls are cached</summary>

Browsing with a WebDAV client fires far more requests than it looks like —
Files/Finder send an invisible extra request per item (checking for a
metadata companion file), on top of the real listing requests. Verified
live: before caching, this meant RomM's platform/rom/save/state lists were
being re-fetched from scratch dozens of times during a single browse,
including literal duplicate requests fired milliseconds apart. Listing
calls are now cached in memory for `CACHE_TTL_SECONDS` (default 30s), and
invalidated immediately whenever this shim uploads or deletes something
itself, so its own writes are always visible right away.

</details>
