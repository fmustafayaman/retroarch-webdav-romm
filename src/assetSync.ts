import path from "node:path";
import {
  deleteSaves,
  deleteStates,
  downloadSave,
  downloadState,
  findRomByBaseName,
  listSaves,
  listStates,
  updateSave,
  updateState,
  uploadNewSave,
  uploadNewState,
  type RommAsset,
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

/**
 * Finds the RomM asset backing a given WebDAV filename.
 *
 * States: RomM preserves the filename exactly as uploaded, so we can match
 * on it directly (scoped to the owning rom, to be safe).
 *
 * Saves: verified against a live RomM instance that `POST /api/saves`
 * silently appends a `[<timestamp>]` suffix to the filename it stores,
 * regardless of what filename is sent — so a save can never be found again
 * by the name RetroArch gave it. Instead we tag every save the shim creates
 * with a fixed, non-null `slot` (`config.rommSaveSlot`) and match on
 * (rom_id, slot), which RomM's own sync engine treats as the stable pairing
 * key for saves. This means only one shim-managed save exists per rom at a
 * time, which is also what makes "last write wins" work as a real update
 * rather than an ever-growing pile of timestamped uploads.
 */
export async function findAssetByFileName(
  kind: AssetKind,
  fileName: string,
): Promise<RommAsset | null> {
  const baseName = path.posix.basename(fileName, path.posix.extname(fileName));
  const rom = await findRomByBaseName(baseName);
  if (!rom) return null;

  const assets = await listAssets(kind);
  if (kind === "saves") {
    return assets.find((a) => a.rom_id === rom.id && a.slot === config.rommSaveSlot) ?? null;
  }
  return assets.find((a) => a.rom_id === rom.id && a.file_name === fileName) ?? null;
}

export async function downloadAssetContent(kind: AssetKind, id: number): Promise<Buffer> {
  return kind === "saves" ? downloadSave(id) : downloadState(id);
}

/**
 * Uploads/overwrites a save or state file, matching the target ROM by
 * filename (RetroArch save filenames mirror the rom filename). Conflict
 * handling is intentionally last-write-wins for v1 — see README.
 */
export async function putAssetContent(
  kind: AssetKind,
  fileName: string,
  content: Buffer,
): Promise<void> {
  const existing = await findAssetByFileName(kind, fileName);
  if (existing) {
    logger.debug({ kind, fileName, id: existing.id }, "overwriting existing romm asset");
    if (kind === "saves") await updateSave(existing.id, fileName, content);
    else await updateState(existing.id, fileName, content);
    return;
  }

  const baseName = path.posix.basename(fileName, path.posix.extname(fileName));
  const rom = await findRomByBaseName(baseName);
  if (!rom) {
    throw new Error(`No RomM rom found matching filename base "${baseName}" for ${fileName}`);
  }

  logger.debug({ kind, fileName, romId: rom.id }, "uploading new romm asset");
  if (kind === "saves") await uploadNewSave(rom.id, fileName, content);
  else await uploadNewState(rom.id, fileName, content);
}

/** Best-effort delete — RetroArch treats cloud sync deletes as best-effort. */
export async function deleteAssetContent(kind: AssetKind, fileName: string): Promise<boolean> {
  const existing = await findAssetByFileName(kind, fileName);
  if (!existing) return false;
  if (kind === "saves") await deleteSaves([existing.id]);
  else await deleteStates([existing.id]);
  return true;
}
