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

export type AssetKind = "saves" | "states";

export interface ResolvedAssetPath {
  kind: AssetKind;
  /** Filename only (last path segment) — RetroArch save filenames mirror the rom filename. */
  fileName: string;
}

/**
 * Maps a WebDAV request path to a RomM asset kind + filename.
 *
 * RetroArch may nest saves/states under a per-core subdirectory
 * (e.g. "saves/snes9x/Chrono Trigger.srm") if the user has "sort saves by
 * core" enabled locally. RomM has no notion of that subdirectory, so we
 * match purely on the basename. TODO: if two different cores produce a
 * save with the identical filename for different roms, they'll collide in
 * RomM's per-user save list — acceptable for a single-user setup, but a
 * real fix would need RomM to track the core/subfolder too.
 */
export function resolveAssetPath(webdavPath: string): ResolvedAssetPath | null {
  const clean = webdavPath.replace(/^\/+/, "");
  const [top, ...rest] = clean.split("/");
  if (rest.length === 0) return null;
  if (top !== "saves" && top !== "states") return null;
  return { kind: top, fileName: path.posix.basename(clean) };
}

async function listAssets(kind: AssetKind): Promise<RommAsset[]> {
  return kind === "saves" ? listSaves() : listStates();
}

function resolveRomForFileName(fileName: string): Promise<RommRomMatch | null> {
  const baseName = path.posix.basename(fileName, path.posix.extname(fileName));
  return findRomByBaseName(baseName);
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
 * Picks the most recently updated asset, breaking ties on `id`. Verified
 * against a live instance that a batch of older rows can share the exact
 * same `updated_at` (a bulk migration timestamp, not real edit times) —
 * without a deterministic tiebreaker, this would pick whichever entry
 * happened to come first in `/api/saves`'s response order, which isn't
 * guaranteed stable across separate requests (confirmed: the manifest
 * build and a subsequent download picked different "winners" among tied
 * entries before this fix). `id` is immutable and monotonically
 * increasing, so it's a safe, stable tiebreaker.
 */
export function pickLatest(assets: RommAsset[]): RommAsset {
  return assets.reduce((latest, a) => {
    if (a.updated_at > latest.updated_at) return a;
    if (a.updated_at === latest.updated_at && a.id > latest.id) return a;
    return latest;
  });
}

/**
 * Finds every asset the shim itself created for a filename — never a
 * foreign/pre-existing entry. Only used by `deleteAssetContent` below, to
 * make sure a delete can never remove history it didn't create.
 *
 * Saves: tagged with a fixed, non-null `slot` (`config.rommSaveSlot`) on
 * creation — matched on that plus rom_id.
 *
 * States: have no slot field, so a shim-owned state is recognized by its
 * `withUniqueSuffix` naming pattern (`<base>-<timestamp>Z<ext>`) instead —
 * old, differently-named archival entries never match that pattern.
 */
async function findManagedAssets(kind: AssetKind, fileName: string): Promise<RommAsset[]> {
  const rom = await resolveRomForFileName(fileName);
  if (!rom) return [];

  const assets = await listAssets(kind);
  if (kind === "saves") {
    return assets.filter((a) => a.rom_id === rom.id && a.slot === config.rommSaveSlot);
  }
  const pattern = ownUploadPattern(fileName);
  return assets.filter((a) => a.rom_id === rom.id && pattern.test(a.file_name));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ownUploadPattern(fileName: string): RegExp {
  const ext = path.posix.extname(fileName);
  const base = path.posix.basename(fileName, ext);
  return new RegExp(`^${escapeRegExp(base)}-\\d{8}T\\d{6}Z${escapeRegExp(ext)}$`);
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
 * reconstructs the correct local filename from the rom + asset extension,
 * not from whatever RomM stored it as).
 */
export async function putAssetContent(
  kind: AssetKind,
  fileName: string,
  content: Buffer,
): Promise<void> {
  const rom = await resolveRomForFileName(fileName);
  if (!rom) {
    const baseName = path.posix.basename(fileName, path.posix.extname(fileName));
    throw new Error(`No RomM rom found matching filename base "${baseName}" for ${fileName}`);
  }

  const uniqueFileName = withUniqueSuffix(fileName);
  logger.debug({ kind, fileName, uniqueFileName, romId: rom.id }, "uploading new romm asset");
  if (kind === "saves") await uploadNewSave(rom.id, uniqueFileName, content);
  else await uploadNewState(rom.id, uniqueFileName, content);
}

function withUniqueSuffix(fileName: string): string {
  const ext = path.posix.extname(fileName);
  const base = path.posix.basename(fileName, ext);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
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
