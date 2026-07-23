import crypto from "node:crypto";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { toRommEmulator, toRetroArchDirName } from "./emulatorNames.js";
import { parseSfo } from "./pspSfo.js";
import { createZip, readZip, type ZipEntry } from "./simpleZip.js";
import {
  listSaves,
  downloadSave,
  uploadNewSave,
  deleteSaves,
  findRomByBaseName,
  type RommAsset,
} from "./rommClient.js";

/**
 * PPSSPP (PSP core) doesn't save a single file per game like every other
 * core — it mirrors a real PSP's memory stick layout under RetroArch's own
 * saves directory: `saves/<core>/PSP/SAVEDATA/<slot>/` holds several small
 * files (PARAM.SFO, the actual save data, ICON0.PNG, PIC1.PNG, ...) that
 * only make sense as a set, plus `saves/<core>/PSP/SYSTEM/CACHE/` holds
 * pure engine caches (shader caches etc.) with no save data at all.
 * Verified live against real PPSSPP sync traffic.
 *
 * This module bundles a save folder's files into a single zip (see
 * simpleZip.ts) stored as one RomM save, and unbundles it again for
 * GET/manifest purposes — everywhere else in this shim, "one WebDAV path
 * = one RomM asset" holds, but it doesn't for PSP.
 */

const IGNORED_CATEGORY = "SYSTEM";
const SAVEDATA_CATEGORY = "SAVEDATA";

export interface PspFilePath {
  /** Raw RetroArch core folder name, e.g. "PPSSPP". */
  emulator: string;
  /** PSP save slot folder, e.g. "ULUS10336DATA0". */
  saveFolder: string;
  /** File within that folder, e.g. "PARAM.SFO". */
  fileName: string;
}

/**
 * Classifies a `saves/...` WebDAV path as a PSP save-folder file, PSP
 * engine-cache noise to ignore, or neither (a normal single-file save —
 * null, let the generic path in assetSync.ts handle it).
 */
export function resolvePspPath(webdavPath: string): PspFilePath | "ignore" | null {
  const clean = webdavPath.replace(/^\/+/, "");
  const segments = clean.split("/");
  // saves/<emulator>/PSP/<category>/...
  if (segments.length < 4 || segments[0] !== "saves") return null;
  if (segments[2]?.toUpperCase() !== "PSP") return null;

  const category = segments[3]?.toUpperCase();
  if (category === IGNORED_CATEGORY) return "ignore";
  if (category !== SAVEDATA_CATEGORY) return null;
  if (segments.length < 6) return null;

  return {
    emulator: segments[1]!,
    saveFolder: segments[4]!,
    fileName: segments.slice(5).join("/"),
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function bundleBaseName(saveFolder: string): string {
  return `PSP-${saveFolder}.zip`;
}

/** Whether a stored save's file_name is a PSP bundle — used by manifest.ts to exclude these from normal single-file save reconstruction. */
export function isPspBundleFileName(fileName: string): boolean {
  return /^PSP-.+\.zip$/.test(fileName);
}

/**
 * Matches a stored bundle filename by prefix/suffix only, tolerating
 * whatever RomM does to the middle. Verified live: `POST /api/saves`
 * inserts its own `[<timestamp>]` before the extension unpredictably
 * (real upload time, not something we can precompute or rely on being
 * absent) — this shim doesn't stamp a uniqueness suffix onto PSP bundle
 * names itself (unlike normal saves/states) since bundles are explicitly
 * update-in-place, not history-preserving, so there's nothing of ours to
 * match past the base name anyway.
 */
function bundlePattern(saveFolder: string): RegExp {
  return new RegExp(`^PSP-${escapeRegExp(saveFolder)}\\b.*\\.zip$`);
}

/**
 * Finds the current bundle for a save folder by its name alone, with no
 * rom_id needed up front — the folder name (e.g. "ULUS10336DATA0") is
 * already a globally unique identifier for a given game+slot. This is
 * what lets GET and manifest-building work without ever needing
 * PSP_SERIAL_MAP or PARAM.SFO (only the very first upload of a new folder
 * needs those, to create the bundle in the first place).
 */
async function findBundleByFolder(saveFolder: string): Promise<RommAsset | null> {
  const pattern = bundlePattern(saveFolder);
  const saves = await listSaves();
  const candidates = saves.filter((a) => pattern.test(a.file_name));
  if (candidates.length === 0) return null;
  return candidates.reduce((latest, a) => (a.updated_at > latest.updated_at ? a : latest));
}

function deriveSerial(saveFolder: string): string {
  return saveFolder.replace(/DATA\d+$/i, "");
}

async function resolveRomId(saveFolder: string, sfoTitle: string | null): Promise<number | null> {
  const serial = deriveSerial(saveFolder);
  const mappedTitle = config.pspSerialMap[serial];
  if (mappedTitle) {
    const rom = await findRomByBaseName(mappedTitle);
    if (rom) return rom.id;
    logger.warn(
      { serial, mappedTitle },
      "PSP_SERIAL_MAP entry didn't match any RomM rom — check the title",
    );
  }

  if (sfoTitle) {
    const rom = await findRomByBaseName(sfoTitle);
    if (rom) {
      logger.info(
        { serial, sfoTitle, matchedRom: rom.fs_name },
        `resolved PSP save via PARAM.SFO title — for reliability, add "${serial}": "${rom.fs_name_no_ext}" to PSP_SERIAL_MAP`,
      );
      return rom.id;
    }
  }

  return null;
}

async function loadBundleEntries(asset: RommAsset): Promise<ZipEntry[]> {
  const zip = await downloadSave(asset.id);
  return readZip(zip);
}

/**
 * Merges one uploaded file into its save folder's bundle and re-uploads
 * it. Deliberately does NOT preserve per-file history the way normal
 * saves/states do (assetSync.ts's putAssetContent): PPSSPP writes a save
 * folder as a burst of several individual file PUTs a fraction of a
 * second apart (verified live), so keeping every intermediate
 * partially-merged bundle as its own history entry would just be noise —
 * only the final, fully-merged state after a save event is a meaningful
 * checkpoint. The previous bundle row is deleted once the merged one is
 * up, so RomM holds exactly one row per (rom, save folder) at a time.
 */
export async function putPspFile(info: PspFilePath, content: Buffer): Promise<void> {
  const existing = await findBundleByFolder(info.saveFolder);

  let romId: number;
  let priorEntries: ZipEntry[] = [];

  if (existing) {
    romId = existing.rom_id;
    priorEntries = await loadBundleEntries(existing);
  } else {
    let sfoTitle: string | null = null;
    if (info.fileName.toUpperCase() === "PARAM.SFO") {
      try {
        const parsed = parseSfo(content);
        if (typeof parsed.TITLE === "string") sfoTitle = parsed.TITLE;
      } catch (err) {
        logger.warn({ err }, "failed to parse PARAM.SFO");
      }
    }
    const resolved = await resolveRomId(info.saveFolder, sfoTitle);
    if (resolved === null) {
      const serial = deriveSerial(info.saveFolder);
      throw new Error(
        `No RomM rom found for PSP save folder "${info.saveFolder}" (serial "${serial}"). ` +
          `Add it to PSP_SERIAL_MAP, e.g. {"${serial}": "<rom title as it appears in RomM>"}.`,
      );
    }
    romId = resolved;
  }

  const merged = new Map(priorEntries.map((e) => [e.name, e.data]));
  merged.set(info.fileName, content);
  const zip = createZip([...merged.entries()].map(([name, data]) => ({ name, data })));

  const rommEmulator = toRommEmulator(info.emulator);
  logger.debug(
    { saveFolder: info.saveFolder, fileName: info.fileName, romId, files: merged.size },
    "updating PSP save bundle",
  );
  await uploadNewSave(romId, bundleBaseName(info.saveFolder), zip, rommEmulator);

  if (existing) {
    await deleteSaves([existing.id]).catch((err) =>
      logger.warn({ err, id: existing.id }, "failed to clean up previous PSP bundle row"),
    );
  }
}

export async function getPspFile(info: PspFilePath): Promise<Buffer | null> {
  const bundle = await findBundleByFolder(info.saveFolder);
  if (!bundle) return null;
  const entries = await loadBundleEntries(bundle);
  return entries.find((e) => e.name === info.fileName)?.data ?? null;
}

export interface PspManifestEntry {
  path: string;
  hash: string;
}

/**
 * Lists every member of every PSP bundle as its own manifest entry —
 * RetroArch diffs per-file, so each PARAM.SFO/ICON0.PNG/save-data file
 * within a folder needs its own {path, hash}, not one entry for the
 * whole bundle. Hashes are computed per-member (RomM's content_hash is
 * only for the zip as a whole) — cheap, these files are a few KB-MB.
 */
export async function buildPspManifestEntries(): Promise<PspManifestEntry[]> {
  const saves = await listSaves();
  // Extracts the save-folder name back out of a stored bundle filename —
  // see bundlePattern above for why this can't assume an exact suffix.
  const bundlePattern = /^PSP-(.+?)(?: \[.*])?\.zip$/;

  const latestByFolder = new Map<string, RommAsset>();
  for (const asset of saves) {
    const match = bundlePattern.exec(asset.file_name);
    if (!match) continue;
    const saveFolder = match[1]!;
    const current = latestByFolder.get(saveFolder);
    if (!current || asset.updated_at > current.updated_at) latestByFolder.set(saveFolder, asset);
  }

  const entries: PspManifestEntry[] = [];
  for (const [saveFolder, asset] of latestByFolder) {
    let members: ZipEntry[];
    try {
      members = await loadBundleEntries(asset);
    } catch (err) {
      logger.warn({ err, saveFolder }, "failed to read PSP bundle for manifest, skipping");
      continue;
    }
    const dir = asset.emulator ? toRetroArchDirName(asset.emulator) : "PPSSPP";
    for (const member of members) {
      entries.push({
        path: `saves/${dir}/PSP/SAVEDATA/${saveFolder}/${member.name}`,
        hash: crypto.createHash("md5").update(member.data).digest("hex"),
      });
    }
  }
  return entries;
}
