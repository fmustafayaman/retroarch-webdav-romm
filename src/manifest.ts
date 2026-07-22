import { getRomById, listSaves, listStates, type RommAsset } from "./rommClient.js";
import { pickLatest, isShimOwned, type AssetKind } from "./assetSync.js";

/**
 * RetroArch's cloud sync diffs against a JSON manifest of {path, hash}
 * entries fetched from `manifest.server` at the WebDAV root before every
 * sync. Rather than persist our own copy, we synthesize it fresh from
 * RomM's current save/state listing on every GET — RomM is the source of
 * truth, so the manifest can never drift from it. PUTs of manifest.server
 * (RetroArch writes one back after each sync) are accepted and discarded;
 * see webdavServer.ts.
 *
 * Every entry's content is picked as "the most recently updated asset for
 * this (rom, slot)" regardless of who created it — RomM's own native
 * sync, a browser play session, a manual upload, or this shim. That's
 * what lets a library's pre-existing progress show up in RetroArch
 * automatically on first sync, with no manual per-game step: this is a
 * read-only listing, so nothing about a pre-existing entry is ever
 * touched here. Writes (assetSync.ts's putAssetContent) always create a
 * fresh shim-managed row rather than overwriting whatever this surfaced,
 * so old entries are only ever read, never mutated.
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
  // expects — rebuild it from the owning rom's fs_name_no_ext + the save's
  // own (untouched) extension instead. One save per rom: unlike states,
  // consoles conventionally have a single .srm/.sav per game, not
  // multiple numbered slots.
  const saveGroups = groupByKey(saves, (s) => String(s.rom_id));
  const saveEntries = await buildEntries(saveGroups, "saves", romName);

  // States commonly have multiple slots per rom (RetroArch names them
  // "<game>.state", "<game>.state1", "<game>.state2", ...) and RomM has no
  // slot field for states to group by directly — but file_extension
  // already isolates exactly that suffix ("state", "state1", ...), since
  // RomM derives it by splitting on the last dot. Grouping by
  // (rom_id, file_extension) picks one winner per slot instead of
  // collapsing every slot down to whichever rom-wide entry is newest, and
  // naturally folds old differently-named archival entries (which all end
  // in plain ".state", no digit) into the base/default slot bucket.
  const stateGroups = groupByKey(states, (s) => `${s.rom_id}:${s.file_extension}`);
  const stateEntries = await buildEntries(stateGroups, "states", romName);

  return JSON.stringify([...saveEntries, ...stateEntries]);
}

function groupByKey(assets: RommAsset[], key: (a: RommAsset) => string): RommAsset[][] {
  const groups = new Map<string, RommAsset[]>();
  for (const asset of assets) {
    const k = key(asset);
    const group = groups.get(k);
    if (group) group.push(asset);
    else groups.set(k, [asset]);
  }
  return [...groups.values()];
}

async function buildEntries(
  groups: RommAsset[][],
  kind: AssetKind,
  romName: (romId: number) => Promise<string | null>,
): Promise<{ path: string; hash: string }[]> {
  const entries = await Promise.all(
    groups.map(async (group) => {
      const content = pickLatest(group);
      const base = await romName(content.rom_id);
      if (!base) return null;

      // Reconstructs RetroArch's own per-core subfolder (e.g.
      // "saves/Snes9x/Game.srm") — see `emulator` on ResolvedAssetPath in
      // assetSync.ts for why the manifest path has to match RetroArch's
      // real local path exactly, or it re-uploads the "missing" file on
      // every sync. Only ever taken from a shim-created entry, though,
      // never from `content` itself if that happens to be a foreign one:
      // verified live that a pre-existing entry's `emulator` can be
      // differently-cased ("snes9x" vs. RetroArch's own "Snes9x") or
      // otherwise unreliable, and trusting it landed a downloaded save in
      // a folder RetroArch doesn't look in — invisible, not just wrong.
      // If the shim has never uploaded anything for this (rom, slot) yet,
      // there's no trustworthy subfolder info at all, so this falls back
      // to no subfolder rather than guessing.
      const ownEntries = group.filter((a) => isShimOwned(kind, a, base));
      const dirSource = ownEntries.length > 0 ? pickLatest(ownEntries) : null;
      const dir = dirSource?.emulator ? `${kind}/${dirSource.emulator}` : kind;

      return toEntry(`${dir}/${base}.${content.file_extension}`, content);
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
