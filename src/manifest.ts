import { getRomById, listSaves, listStates, type RommAsset } from "./rommClient.js";
import { pickLatest, splitAssetFileName, stripShimStamp } from "./assetSync.js";
import { toRetroArchDirName } from "./emulatorNames.js";

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
  const [saves, states] = await Promise.all([listSaves(), listStates()]);

  const romCache = new Map<number, string | null>();
  const romName = async (romId: number): Promise<string | null> => {
    if (!romCache.has(romId)) {
      const rom = await getRomById(romId);
      romCache.set(romId, rom?.fs_name_no_ext ?? null);
    }
    return romCache.get(romId) ?? null;
  };

  // Verified against a live RomM instance: POST /api/saves silently
  // appends a "[<timestamp>]" suffix to whatever filename is sent, so a
  // save's own file_name can't be used to reconstruct the path RetroArch
  // expects — rebuild it from the owning rom's fs_name_no_ext + RomM's own
  // (untouched, simple, single-segment) file_extension instead. One save
  // per rom: unlike states, consoles conventionally have a single
  // .srm/.sav per game, not multiple numbered slots.
  const latestSavePerRom = latestByKey(saves, (s) => String(s.rom_id));
  const saveEntries = await buildEntries(latestSavePerRom, "saves", romName, (a) => a.file_extension);

  // States commonly have multiple slots per rom (RetroArch names them
  // "<game>.state", "<game>.state1", "<game>.state2", "<game>.state.auto",
  // ...) and RomM has no slot field for states to group by directly.
  // RomM's own `file_extension` isolates most of these correctly (it's a
  // last-dot split) EXCEPT the auto-savestate case: RetroArch's
  // ".state.auto" is a two-segment suffix, and RomM's naive split reports
  // file_extension="auto", which would collapse it into the same bucket
  // as a plain numeric slot named literally "auto" (impossible, but
  // illustrates the field can't be trusted here) and reconstruct the
  // wrong path ("<game>.auto" instead of "<game>.state.auto") — verified
  // live. Deriving the suffix ourselves via `splitAssetFileName` (after
  // stripping our own upload-uniqueness stamp, if present) handles this
  // correctly, the same logic already used to resolve which rom a
  // save/state belongs to.
  const stateSuffix = (a: RommAsset) => splitAssetFileName(stripShimStamp(a.file_name)).suffix;
  const latestStatePerRomAndSlot = latestByKey(states, (s) => `${s.rom_id}:${stateSuffix(s)}`);
  const stateEntries = await buildEntries(latestStatePerRomAndSlot, "states", romName, stateSuffix);

  return JSON.stringify([...saveEntries, ...stateEntries]);
}

function latestByKey(assets: RommAsset[], key: (a: RommAsset) => string): RommAsset[] {
  const groups = new Map<string, RommAsset[]>();
  for (const asset of assets) {
    const k = key(asset);
    const group = groups.get(k);
    if (group) group.push(asset);
    else groups.set(k, [asset]);
  }
  return [...groups.values()].map(pickLatest);
}

async function buildEntries(
  assets: RommAsset[],
  prefix: "saves" | "states",
  romName: (romId: number) => Promise<string | null>,
  suffixOf: (asset: RommAsset) => string,
): Promise<{ path: string; hash: string }[]> {
  const entries = await Promise.all(
    assets.map(async (a) => {
      const base = await romName(a.rom_id);
      if (!base) return null;
      // Reconstructs RetroArch's own per-core subfolder (e.g.
      // "saves/Snes9x/Game.srm"). RomM's `emulator` field is stored in
      // RomM's own lowercase/underscore convention ("snes9x"), NOT
      // RetroArch's local directory casing ("Snes9x") — translated via
      // the shared table in emulatorNames.ts, ported from the community
      // romm-retroarch-sync project, which had already solved this exact
      // mismatch. Verified live that trusting a raw, un-translated
      // `emulator` value (from either RomM's own casing or an inconsistent
      // upstream client) silently drops a save into a folder RetroArch
      // never looks in — translating through RomM's own convention rather
      // than round-tripping raw strings fixes it for any entry, not just
      // ones this shim uploaded.
      const dir = a.emulator ? `${prefix}/${toRetroArchDirName(a.emulator)}` : prefix;
      return toEntry(`${dir}/${base}.${suffixOf(a)}`, a);
    }),
  );
  return entries.filter((e): e is { path: string; hash: string } => e !== null);
}

function toEntry(path: string, asset: RommAsset) {
  return {
    path,
    // content_hash may be null on older RomM rows that predate hashing;
    // fall back to a size+mtime fingerprint so the entry still round-trips
    // through a diff (TODO: this fallback can't detect same-size same-second
    // edits — a real fix means RomM guaranteeing content_hash is always set).
    hash: asset.content_hash ?? `${asset.file_size_bytes}-${asset.updated_at}`,
  };
}
