import { config } from "./config.js";
import { getRomById, listSaves, listStates, type RommAsset } from "./rommClient.js";

/**
 * RetroArch's cloud sync diffs against a JSON manifest of {path, hash}
 * entries fetched from `manifest.server` at the WebDAV root before every
 * sync. Rather than persist our own copy, we synthesize it fresh from
 * RomM's current save/state listing on every GET — RomM is the source of
 * truth, so the manifest can never drift from it. PUTs of manifest.server
 * (RetroArch writes one back after each sync) are accepted and discarded;
 * see webdavServer.ts.
 */
export async function buildServerManifest(): Promise<string> {
  const [saves, states] = await Promise.all([listSaves(), listStates()]);

  // Verified against a live RomM instance: POST /api/saves silently
  // appends a "[<timestamp>]" suffix to whatever filename is sent, so a
  // save's own file_name can't be used to reconstruct the path RetroArch
  // expects. Only saves tagged with our fixed slot are shim-managed (see
  // assetSync.ts); for those we rebuild the original filename from the
  // owning rom's fs_name_no_ext + the save's own (untouched) extension.
  // Saves from other tools/slots are intentionally left out of the
  // manifest — see README "Known limitations".
  const ourSaves = saves.filter((s) => s.slot === config.rommSaveSlot);
  const romCache = new Map<number, string | null>();
  const romName = async (romId: number): Promise<string | null> => {
    if (!romCache.has(romId)) {
      const rom = await getRomById(romId);
      romCache.set(romId, rom?.fs_name_no_ext ?? null);
    }
    return romCache.get(romId) ?? null;
  };

  const saveEntries = (
    await Promise.all(
      ourSaves.map(async (s) => {
        const base = await romName(s.rom_id);
        if (!base) return null;
        return toEntry(`saves/${base}.${s.file_extension}`, s);
      }),
    )
  ).filter((e): e is { path: string; hash: string } => e !== null);

  // States are stored under the exact filename we upload — no reconstruction needed.
  const stateEntries = states.map((s) => toEntry(`states/${s.file_name}`, s));

  return JSON.stringify([...saveEntries, ...stateEntries]);
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
