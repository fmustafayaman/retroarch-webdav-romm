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
 * `withUniqueSuffix` naming pattern (`<base>-<timestamp>Z<ext>`) instead —
 * old, differently-named archival entries never match that pattern.
 */
export function isShimOwned(kind: AssetKind, asset: RommAsset, base: string): boolean {
  if (kind === "saves") return asset.slot === config.rommSaveSlot;
  const pattern = ownUploadPattern(base, `.${asset.file_extension}`);
  return pattern.test(asset.file_name);
}

async function findManagedAssets(kind: AssetKind, fileName: string): Promise<RommAsset[]> {
  const rom = await resolveRomForFileName(fileName);
  if (!rom) return [];

  const base = path.posix.basename(fileName, path.posix.extname(fileName));
  const assets = await listAssets(kind);
  return assets.filter((a) => a.rom_id === rom.id && isShimOwned(kind, a, base));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ownUploadPattern(base: string, ext: string): RegExp {
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
  emulator: string | null,
): Promise<void> {
  const rom = await resolveRomForFileName(fileName);
  if (!rom) {
    const baseName = path.posix.basename(fileName, path.posix.extname(fileName));
    throw new Error(`No RomM rom found matching filename base "${baseName}" for ${fileName}`);
  }

  // Normalize RetroArch's own directory name ("Snes9x") to RomM's
  // lowercase/underscore convention ("snes9x") before storing it — see
  // emulatorNames.ts. Matching RomM's own convention (rather than storing
  // RetroArch's raw casing) is what lets manifest.ts translate it back to
  // the *correct* RetroArch folder name for ANY entry with this field
  // set, not just ones this shim uploaded.
  const rommEmulator = emulator ? toRommEmulator(emulator) : null;

  const uniqueFileName = withUniqueSuffix(fileName);
  logger.debug(
    { kind, fileName, uniqueFileName, romId: rom.id, emulator: rommEmulator },
    "uploading new romm asset",
  );
  if (kind === "saves") await uploadNewSave(rom.id, uniqueFileName, content, rommEmulator);
  else await uploadNewState(rom.id, uniqueFileName, content, rommEmulator);
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
