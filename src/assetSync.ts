import path from "node:path";
import {
  deleteSaves,
  deleteStates,
  downloadSave,
  downloadState,
  findRomByBaseName,
  listSaves,
  listStates,
  uploadNewSave,
  uploadNewState,
  type RommAsset,
  type RommRomMatch,
} from "./rommClient.js";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { toRommEmulator } from "./emulatorNames.js";

export type AssetKind = "saves" | "states";

export interface ResolvedAssetPath {
  kind: AssetKind;
  /** Filename only (last path segment) — RetroArch save filenames mirror the rom filename. */
  fileName: string;
  /**
   * The per-core subfolder RetroArch nests saves/states under (e.g.
   * "saves/Snes9x/Chrono Trigger.srm" → "Snes9x"), if any. Verified
   * against a live instance that this is RetroArch's actual, consistently
   * used local directory structure for both saves and states — not an
   * edge case. It has to round-trip into RomM's `emulator` field and back
   * out into the manifest path (see manifest.ts): the manifest's path is
   * the key RetroArch diffs its local files against, and a mismatched key
   * means RetroArch can never recognize a match, so it re-uploads the
   * "missing" file on every single sync.
   */
  emulator: string | null;
}

/** Maps a WebDAV request path to a RomM asset kind + filename + per-core subfolder. */
export function resolveAssetPath(webdavPath: string): ResolvedAssetPath | null {
  const clean = webdavPath.replace(/^\/+/, "");
  const [top, ...rest] = clean.split("/");
  if (rest.length === 0) return null;
  if (top !== "saves" && top !== "states") return null;
  const emulator = rest.length > 1 ? rest.slice(0, -1).join("/") : null;
  return { kind: top, fileName: path.posix.basename(clean), emulator };
}

/**
 * Splits a save/state filename into its game-title base and its
 * "suffix" (extension, in the loose RetroArch sense).
 *
 * Verified live that RetroArch's auto-savestate filename is literally
 * "<content>.state.auto" — a two-segment suffix, not a single extension.
 * Naive last-dot splitting (`path.extname`) turns this into
 * base="<content>.state", suffix="auto", which then fails rom lookup (no
 * rom is titled "<content>.state") and would mis-reconstruct the manifest
 * path as "<content>.auto" instead of "<content>.state.auto". Numbered
 * slots ("<content>.state1"..".state9") and save extensions
 * ("<content>.srm" etc.) are single-segment and unaffected — only
 * ".state.auto" needs this special case.
 */
export function splitAssetFileName(fileName: string): { base: string; suffix: string } {
  if (/\.state\.auto$/i.test(fileName)) {
    return { base: fileName.slice(0, -".state.auto".length), suffix: "state.auto" };
  }
  const ext = path.posix.extname(fileName);
  return { base: path.posix.basename(fileName, ext), suffix: ext.replace(/^\./, "") };
}

async function listAssets(kind: AssetKind): Promise<RommAsset[]> {
  return kind === "saves" ? listSaves() : listStates();
}

function resolveRomForFileName(fileName: string): Promise<RommRomMatch | null> {
  return findRomByBaseName(splitAssetFileName(fileName).base);
}

/**
 * Finds whatever RomM currently considers "the" save/state for a rom, for
 * download — the most recently updated entry, regardless of who created it
 * or what it's named.
 *
 * This is what lets a library's pre-existing saves/states (created by
 * RomM's own native sync, a browser play session, manual uploads — not
 * this shim) show up in RetroArch automatically on first sync, with no
 * per-game manual step: it's a read-only lookup, so nothing about the old
 * entry is touched. Once RetroArch later uploads a change, `putAsset`
 * below always creates a fresh shim-managed row rather than overwriting
 * whatever this found — old entries are only ever read, never mutated or
 * deleted by this path.
 */
export async function findAssetForDownload(
  kind: AssetKind,
  fileName: string,
): Promise<RommAsset | null> {
  const rom = await resolveRomForFileName(fileName);
  if (!rom) return null;

  const assets = (await listAssets(kind)).filter((a) => a.rom_id === rom.id);
  if (assets.length === 0) return null;
  return pickLatest(assets);
}

/**
 * Newest first, breaking ties on `id`. Verified against a live instance
 * that a batch of older rows can share the exact same `updated_at` (a bulk
 * migration timestamp, not real edit times) — without a deterministic
 * tiebreaker, "the newest" isn't well-defined and could disagree between
 * two separate requests (confirmed: the manifest build and a subsequent
 * download picked different "winners" among tied entries before this
 * fix). `id` is immutable and monotonically increasing, so it's a safe,
 * stable tiebreaker.
 */
export function sortByRecency(assets: RommAsset[]): RommAsset[] {
  return [...assets].sort((a, b) => {
    if (a.updated_at !== b.updated_at) return a.updated_at > b.updated_at ? -1 : 1;
    return b.id - a.id;
  });
}

export function pickLatest(assets: RommAsset[]): RommAsset {
  return sortByRecency(assets)[0]!;
}

/**
 * Groups a save/state into the same "slot" bucket manifest.ts's history
 * listing uses — one save per rom (saves have no per-slot filename
 * variation once RomM's own auto-appended bracket is stripped, since
 * RetroArch always writes the same base name for a game's save), one
 * bucket per rom+suffix for states (RetroArch numbers state slots by
 * filename suffix: `.state`, `.state1`, ..., `.state.auto`).
 */
export function assetHistoryKey(kind: AssetKind, asset: RommAsset): string {
  if (kind === "saves") return String(asset.rom_id);
  return `${asset.rom_id}:${splitAssetFileName(stripShimStamp(asset.file_name)).suffix}`;
}

/**
 * Recovers the exact WebDAV filename a shim-created upload was made
 * under, by stripping the `withUniqueSuffix` timestamp stamp — or returns
 * `asset.file_name` unchanged if it doesn't match that pattern (a
 * foreign/pre-existing entry).
 */
function stripShimStamp(fileName: string): string {
  return fileName.replace(/\.\d{8}T\d{6}Z$/, "");
}

/**
 * Whether the shim itself created `asset` — never true for a
 * foreign/pre-existing entry. Used by `deleteAssetContent` below (so a
 * delete can never remove history it didn't create) and by
 * `manifest.ts` (so a save/state's per-core subfolder is only ever
 * reconstructed from a source we know came from a real RetroArch upload —
 * see the note on `ResolvedAssetPath.emulator` above. RomM's own `emulator`
 * field on foreign entries has been observed lowercased ("snes9x") where
 * RetroArch itself sends it capitalized ("Snes9x") verified live: trusting
 * a foreign entry's casing for the manifest path put a save in a `snes9x`
 * folder RetroArch never looks in, silently discarding it — so don't).
 *
 * Saves: tagged with a fixed, non-null `slot` (`config.rommSaveSlot`) on
 * creation — matched on that plus rom_id.
 *
 * States: have no slot field, so a shim-owned state is recognized by its
 * `withUniqueSuffix` naming pattern (the exact WebDAV filename, followed
 * by our timestamp stamp) instead — old, differently-named archival
 * entries never match that pattern.
 */
export function isShimOwned(kind: AssetKind, asset: RommAsset, fileName: string): boolean {
  if (kind === "saves") return asset.slot === config.rommSaveSlot;
  return ownUploadPattern(fileName).test(asset.file_name);
}

async function findManagedAssets(kind: AssetKind, fileName: string): Promise<RommAsset[]> {
  const rom = await resolveRomForFileName(fileName);
  if (!rom) return [];

  const assets = await listAssets(kind);
  return assets.filter((a) => a.rom_id === rom.id && isShimOwned(kind, a, fileName));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ownUploadPattern(fileName: string): RegExp {
  return new RegExp(`^${escapeRegExp(fileName)}\\.\\d{8}T\\d{6}Z$`);
}

export async function downloadAssetContent(kind: AssetKind, id: number): Promise<Buffer> {
  return kind === "saves" ? downloadSave(id) : downloadState(id);
}

/**
 * Uploads a save/state as a brand-new entry every time, matching the
 * target ROM by filename (RetroArch save filenames mirror the rom
 * filename). Deliberately never overwrites an existing row in place — the
 * user wants every save/state kept as its own history entry rather than
 * clobbered. `findAssetForDownload` always resolves to the newest one, so
 * this doesn't cost anything on the read side; it just means RomM's
 * save/state list for a rom grows over time instead of holding one row
 * per rom. Conflict handling is otherwise last-write-wins for v1 — see
 * README.
 *
 * Verified against a live instance that RomM dedupes `POST /api/saves` and
 * `/api/states` on (rom_id, filename) specifically — neither a non-null
 * `slot` nor `overwrite=false` stops a same-named upload from silently
 * replacing the previous row. Since RetroArch always sends the exact same
 * filename for a given save/state slot, every upload would otherwise
 * collide and overwrite regardless of this function's intent. The fix:
 * give RomM a filename it's never seen before by stamping a timestamp
 * into it — RetroArch never sees this name (only WebDAV path segments
 * round-trip back to it, and the manifest/download path already
 * reconstructs the correct local filename from the rom + asset suffix,
 * not from whatever RomM stored it as).
 */
export async function putAssetContent(
  kind: AssetKind,
  fileName: string,
  content: Buffer,
  emulator: string | null,
): Promise<void> {
  const rom = await resolveRomForFileName(fileName);
  if (!rom) {
    const { base } = splitAssetFileName(fileName);
    throw new Error(`No RomM rom found matching filename base "${base}" for ${fileName}`);
  }

  // Normalize RetroArch's own directory name ("Snes9x") to RomM's
  // lowercase/underscore convention ("snes9x") before storing it — see
  // emulatorNames.ts. Matching RomM's own convention (rather than storing
  // RetroArch's raw casing) is what lets manifest.ts translate it back to
  // the *correct* RetroArch folder name for ANY entry with this field
  // set, not just ones this shim uploaded.
  const rommEmulator = emulator ? toRommEmulator(emulator) : null;

  const uniqueFileName = withUniqueSuffix(kind, fileName);
  logger.debug(
    { kind, fileName, uniqueFileName, romId: rom.id, emulator: rommEmulator },
    "uploading new romm asset",
  );
  if (kind === "saves") await uploadNewSave(rom.id, uniqueFileName, content, rommEmulator);
  else await uploadNewState(rom.id, uniqueFileName, content, rommEmulator);

  await pruneHistory(kind, rom.id, fileName).catch((err) =>
    logger.warn({ err, kind, romId: rom.id, fileName }, "history prune failed, leaving extra rows in place"),
  );
}

/**
 * Deletes the oldest rows in a (rom, slot) history bucket once it exceeds
 * `HISTORY_KEEP_COUNT` (config.ts) — every upload is a new row (see above),
 * so without this the history browsable via WebDAV (and RomM's own save
 * list) grows without bound. Runs right after the upload that pushed a
 * bucket over the limit, keyed the same way manifest.ts's history listing
 * groups entries, so what gets pruned lines up with what you'd actually
 * see extra of when browsing.
 */
async function pruneHistory(kind: AssetKind, romId: number, fileName: string): Promise<void> {
  const keep = config.historyKeepCount;
  if (keep <= 0) return;

  const suffix = kind === "states" ? splitAssetFileName(fileName).suffix : null;
  const key = suffix === null ? String(romId) : `${romId}:${suffix}`;

  const bucket = (await listAssets(kind)).filter(
    (a) => a.rom_id === romId && assetHistoryKey(kind, a) === key,
  );
  if (bucket.length <= keep) return;

  const excess = sortByRecency(bucket).slice(keep);
  const ids = excess.map((a) => a.id);
  if (kind === "saves") await deleteSaves(ids);
  else await deleteStates(ids);
  logger.info({ kind, romId, key, deletedCount: ids.length, keep }, "pruned old save/state history");
}

/**
 * Stamps a timestamp onto the filename to guarantee RomM sees one it's
 * never seen before — see `putAssetContent` above for why that's needed.
 *
 * States: appended after the whole original filename, rather than
 * splitting out an "extension" first, which sidesteps ever needing to
 * understand a filename's structure here (in particular RetroArch's
 * compound ".state.auto" suffix — see `splitAssetFileName`).
 * `stripShimStamp` recovers the exact original filename by just cutting
 * this stamp back off.
 *
 * Saves: inserted *before* the extension instead (`Game-STAMP.srm`, not
 * `Game.srm.STAMP`) — verified live that `POST /api/saves` additionally
 * inserts its own `[<timestamp>]` bracket right before the final
 * extension segment regardless of what's sent, and manifest.ts's save
 * path (unlike its state path) still relies on RomM's own reported
 * `file_extension` to reconstruct the suffix. Appending our stamp after
 * the extension pushed RomM's own bracket-plus-our-stamp into that final
 * segment, corrupting `file_extension` into the stamp itself and
 * reconstructing the manifest path as e.g. "Game.20260723T104825Z"
 * instead of "Game.srm". Saves never have a compound suffix like states'
 * ".state.auto", so splitting out a plain extension here is safe.
 */
function withUniqueSuffix(kind: AssetKind, fileName: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  if (kind === "states") return `${fileName}.${stamp}`;
  const ext = path.posix.extname(fileName);
  const base = path.posix.basename(fileName, ext);
  return `${base}-${stamp}${ext}`;
}

/** Best-effort delete — RetroArch treats cloud sync deletes as best-effort. Only ever removes the shim's own most recent managed asset, never a pre-existing foreign one or older history. */
export async function deleteAssetContent(kind: AssetKind, fileName: string): Promise<boolean> {
  const managed = await findManagedAssets(kind, fileName);
  if (managed.length === 0) return false;
  const target = pickLatest(managed);
  if (kind === "saves") await deleteSaves([target.id]);
  else await deleteStates([target.id]);
  return true;
}

export { stripShimStamp };
