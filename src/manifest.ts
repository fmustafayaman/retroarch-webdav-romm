import { getRomById, listSaves, listStates, type RommAsset } from "./rommClient.js";
import { assetHistoryKey, sortByRecency, splitAssetFileName, stripShimStamp } from "./assetSync.js";
import { toRetroArchDirName } from "./emulatorNames.js";
import { buildPspManifestEntries, isPspBundleFileName } from "./pspSave.js";

export interface ManifestEntry {
  path: string;
  hash: string;
  size: number;
  updatedAt?: string;
}

/**
 * RetroArch's cloud sync diffs against a JSON manifest of {path, hash}
 * entries fetched from `manifest.server` at the WebDAV root before every
 * sync. Rather than persist our own copy, we synthesize it fresh from
 * RomM's current save/state listing on every GET — RomM is the source of
 * truth, so the manifest can never drift from it. PUTs of manifest.server
 * (RetroArch writes one back after each sync) are accepted and discarded;
 * see webdavServer.ts.
 *
 * Every entry is picked as "the most recently updated asset for this
 * (rom, slot)" regardless of who created it — RomM's own native sync, a
 * browser play session, a manual upload, or this shim. That's what lets a
 * library's pre-existing progress show up in RetroArch automatically on
 * first sync, with no manual per-game step: this is a read-only listing,
 * so nothing about a pre-existing entry is ever touched here. Writes
 * (assetSync.ts's putAssetContent) always create a fresh shim-managed row
 * rather than overwriting whatever this surfaced, so old entries are only
 * ever read, never mutated.
 */
export async function buildServerManifest(): Promise<string> {
  const entries = await listSaveStateEntries();
  return JSON.stringify(entries.map((e) => ({ path: e.path, hash: e.hash })));
}

/** The full {path, hash, size} entry list for exactly what RetroArch would sync — one entry per (rom, slot), always the newest. Manifest.server (above) only needs path+hash; PROPFIND browsing needs size too, but still just the "current" entry — see listSaveStateHistoryEntries for the full history. */
export async function listSaveStateEntries(): Promise<ManifestEntry[]> {
  const [allSaves, states, pspEntries] = await Promise.all([
    listSaves(),
    listStates(),
    buildPspManifestEntries(),
  ]);

  const saves = allSaves.filter((s) => !isPspBundleFileName(s.file_name));
  const romName = makeRomNameResolver();

  const latestSavePerRom = latestByKey(saves, saveKey);
  const saveEntries = await buildEntries(latestSavePerRom, "saves", romName, saveSuffix);

  const latestStatePerRomAndSlot = latestByKey(states, stateKey);
  const stateEntries = await buildEntries(latestStatePerRomAndSlot, "states", romName, stateSuffix);

  return [...saveEntries, ...stateEntries, ...pspEntries];
}

/**
 * Every save/state RomM has ever stored for every (rom, slot) — not just
 * the current one — for the browsing feature only (webdavServer.ts's
 * `saveStateListing`). RomM keeps every upload as its own row (see
 * `putAssetContent` in assetSync.ts), so a game with 10 manual states has
 * 10 real rows sitting there; this is what lets a WebDAV client actually
 * see and download all of them, not just the newest.
 *
 * The current (newest) entry keeps the exact same plain path
 * `listSaveStateEntries` above would give it, so it lines up with what
 * RetroArch's sync expects. Older entries for the same (rom, slot) get a
 * disambiguating ` [<date> #<id>]` inserted before the extension — the
 * date is for a human to read, the trailing `#<id>` is what
 * `parseHistoryAssetId` below uses to serve the right one back on `GET`
 * (see `handleGetOrHead` in webdavServer.ts).
 */
export async function listSaveStateHistoryEntries(): Promise<ManifestEntry[]> {
  const [allSaves, states, pspEntries] = await Promise.all([
    listSaves(),
    listStates(),
    buildPspManifestEntries(),
  ]);

  const saves = allSaves.filter((s) => !isPspBundleFileName(s.file_name));
  const romName = makeRomNameResolver();

  const saveEntries = await buildHistoryEntries(saves, "saves", romName, saveKey, saveSuffix);
  const stateEntries = await buildHistoryEntries(states, "states", romName, stateKey, stateSuffix);

  return [...saveEntries, ...stateEntries, ...pspEntries];
}

const HISTORY_ID_RE = /#(\d+)\]/;

/** Recovers the RomM asset id embedded by `buildHistoryEntries` below, or null if `fileName` isn't a history-disambiguated name (i.e. it's the plain, current-entry name). */
export function parseHistoryAssetId(fileName: string): number | null {
  const match = HISTORY_ID_RE.exec(fileName);
  return match ? Number(match[1]) : null;
}

// Verified against a live RomM instance: POST /api/saves silently appends
// a "[<timestamp>]" suffix to whatever filename is sent, so a save's own
// file_name can't be used to reconstruct the path RetroArch expects —
// rebuild it from the owning rom's fs_name_no_ext + RomM's own (untouched,
// simple, single-segment) file_extension instead. One save per rom: unlike
// states, consoles conventionally have a single .srm/.sav per game, not
// multiple numbered slots.
const saveKey = (a: RommAsset) => assetHistoryKey("saves", a);
const saveSuffix = (a: RommAsset) => a.file_extension;

// States commonly have multiple slots per rom (RetroArch names them
// "<game>.state", "<game>.state1", "<game>.state2", "<game>.state.auto",
// ...) and RomM has no slot field for states to group by directly. RomM's
// own `file_extension` isolates most of these correctly (it's a last-dot
// split) EXCEPT the auto-savestate case: RetroArch's ".state.auto" is a
// two-segment suffix, and RomM's naive split reports file_extension="auto"
// — verified live. Deriving the suffix ourselves via `splitAssetFileName`
// (after stripping our own upload-uniqueness stamp, if present) handles
// this correctly, the same logic already used to resolve which rom a
// save/state belongs to (and to group history buckets — see assetSync.ts's
// `assetHistoryKey`, `pruneHistory`).
const stateSuffix = (a: RommAsset) => splitAssetFileName(stripShimStamp(a.file_name)).suffix;
const stateKey = (a: RommAsset) => assetHistoryKey("states", a);

function makeRomNameResolver(): (romId: number) => Promise<string | null> {
  const cache = new Map<number, string | null>();
  return async (romId: number) => {
    if (!cache.has(romId)) {
      const rom = await getRomById(romId);
      cache.set(romId, rom?.fs_name_no_ext ?? null);
    }
    return cache.get(romId) ?? null;
  };
}

function latestByKey(assets: RommAsset[], key: (a: RommAsset) => string): RommAsset[] {
  return [...groupByKey(assets, key).values()].map((group) => sortByRecency(group)[0]!);
}

function groupByKey(assets: RommAsset[], key: (a: RommAsset) => string): Map<string, RommAsset[]> {
  const groups = new Map<string, RommAsset[]>();
  for (const asset of assets) {
    const k = key(asset);
    const group = groups.get(k);
    if (group) group.push(asset);
    else groups.set(k, [asset]);
  }
  return groups;
}

async function buildEntries(
  assets: RommAsset[],
  prefix: "saves" | "states",
  romName: (romId: number) => Promise<string | null>,
  suffixOf: (asset: RommAsset) => string,
): Promise<ManifestEntry[]> {
  const entries = await Promise.all(
    assets.map(async (a) => {
      const base = await romName(a.rom_id);
      if (!base) return null;
      return toEntry(`${dirFor(prefix, a)}/${base}.${suffixOf(a)}`, a);
    }),
  );
  return entries.filter((e): e is ManifestEntry => e !== null);
}

async function buildHistoryEntries(
  assets: RommAsset[],
  prefix: "saves" | "states",
  romName: (romId: number) => Promise<string | null>,
  keyOf: (asset: RommAsset) => string,
  suffixOf: (asset: RommAsset) => string,
): Promise<ManifestEntry[]> {
  const groups = groupByKey(assets, keyOf);
  const entries: ManifestEntry[] = [];

  for (const group of groups.values()) {
    const sorted = sortByRecency(group);
    const base = await romName(sorted[0]!.rom_id);
    if (!base) continue;

    sorted.forEach((a, i) => {
      const suffix = suffixOf(a);
      const name = i === 0 ? `${base}.${suffix}` : `${base} [${historyLabel(a)}].${suffix}`;
      entries.push(toEntry(`${dirFor(prefix, a)}/${name}`, a));
    });
  }

  return entries;
}

function historyLabel(a: RommAsset): string {
  const d = new Date(a.updated_at);
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  // The "#<id>" here isn't decorative — parseHistoryAssetId (above) reads
  // it back out to know which exact RomM row to serve on GET.
  return `${date} ${time} #${a.id}`;
}

// Reconstructs RetroArch's own per-core subfolder (e.g.
// "saves/Snes9x/Game.srm"). RomM's `emulator` field is stored in RomM's
// own lowercase/underscore convention ("snes9x"), NOT RetroArch's local
// directory casing ("Snes9x") — translated via the shared table in
// emulatorNames.ts, ported from the community romm-retroarch-sync
// project, which had already solved this exact mismatch. Verified live
// that trusting a raw, un-translated `emulator` value (from either RomM's
// own casing or an inconsistent upstream client) silently drops a save
// into a folder RetroArch never looks in — translating through RomM's own
// convention rather than round-tripping raw strings fixes it for any
// entry, not just ones this shim uploaded.
function dirFor(prefix: "saves" | "states", asset: RommAsset): string {
  return asset.emulator ? `${prefix}/${toRetroArchDirName(asset.emulator)}` : prefix;
}

function toEntry(path: string, asset: RommAsset): ManifestEntry {
  return {
    path,
    // content_hash may be null on older RomM rows that predate hashing;
    // fall back to a size+mtime fingerprint so the entry still round-trips
    // through a diff (TODO: this fallback can't detect same-size same-second
    // edits — a real fix means RomM guaranteeing content_hash is always set).
    hash: asset.content_hash ?? `${asset.file_size_bytes}-${asset.updated_at}`,
    size: asset.file_size_bytes,
    updatedAt: asset.updated_at,
  };
}
