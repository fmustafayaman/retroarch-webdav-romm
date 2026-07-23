import { config } from "./config.js";
import { logger } from "./logger.js";

export interface RommAsset {
  id: number;
  rom_id: number;
  file_name: string;
  file_extension: string;
  file_size_bytes: number;
  updated_at: string;
  content_hash: string | null;
  slot?: string | null;
  emulator: string | null;
}

export interface RommRomMatch {
  id: number;
  fs_name: string;
  fs_name_no_ext: string;
  fs_name_no_tags: string;
  name: string;
  /** RomM's platform slug (e.g. "snes", "psx") — verified present on both `/api/roms` and `/api/roms/{id}/simple` responses (RomM's SimpleRomSchema). Used to guess a default RetroArch core folder for saves/states that arrive with no `emulator` field set — see emulatorNames.ts's `defaultCoreForPlatform`. */
  platform_fs_slug: string;
}

export interface RommPlatform {
  id: number;
  fs_slug: string;
  name: string;
  rom_count: number;
}

export interface RommRom {
  id: number;
  fs_name: string;
  fs_name_no_ext: string;
  fs_size_bytes: number;
  updated_at: string;
  has_multiple_files: boolean;
  files: { file_name: string }[];
}

const authHeader =
  config.rommAuth.kind === "bearer"
    ? `Bearer ${config.rommAuth.token}`
    : "Basic " +
      Buffer.from(`${config.rommAuth.username}:${config.rommAuth.password}`).toString("base64");

class RommApiError extends Error {
  constructor(
    public method: string,
    public path: string,
    public status: number,
    public body: string,
  ) {
    super(`RomM API ${method} ${path} -> HTTP ${status}: ${body.slice(0, 300)}`);
  }
}

async function rommFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const url = `${config.rommBaseUrl}${path}`;
  const method = init.method ?? "GET";
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: authHeader,
      ...init.headers,
    },
  });
  logger.debug({ method, url, status: res.status }, "romm api call");
  return res;
}

async function rommFetchOk(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await rommFetch(path, init);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new RommApiError(init.method ?? "GET", path, res.status, body);
  }
  return res;
}

/**
 * TTL cache (config.CACHE_TTL_SECONDS, default 30s) plus in-flight
 * deduplication for read-only listing calls. Verified live this matters a
 * lot more than the config comment implied: a single WebDAV client browse
 * of saves/states/roms fires a burst of near-simultaneous PROPFIND
 * requests (including macOS/iOS's own "._<name>" AppleDouble metadata
 * probes for every entry), and each one — with no caching — re-fetched
 * /api/platforms, /api/roms per platform, and /api/saves+/api/states from
 * scratch, several of them literally millisecond-identical concurrent
 * duplicates. That's what made browsing feel slow. Set CACHE_TTL_SECONDS=0
 * to disable and always hit RomM fresh.
 */
const cache = new Map<string, { expires: number; value: unknown }>();
const inFlight = new Map<string, Promise<unknown>>();

async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (config.cacheTtlSeconds <= 0) return fn();

  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as T;

  const pending = inFlight.get(key);
  if (pending) return pending as Promise<T>;

  const promise = fn()
    .then((value) => {
      cache.set(key, { expires: Date.now() + config.cacheTtlSeconds * 1000, value });
      return value;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

/** Called after any save/state upload or delete so a client that lists right after a write this shim just made sees it immediately, instead of waiting out the TTL. */
function invalidateAssetCache(kind: "saves" | "states"): void {
  cache.delete(kind);
}

/**
 * RomM's search_term is a fuzzy/relevance search over the bare title, not a
 * substring match — passing it a fully tagged filename like
 * "Silent Hill (Europe) (En,Fr,De,Es,It)" reliably returns zero results
 * (verified against a live instance), even though the rom exists. Stripping
 * "(...)"/"[...]" tag groups before searching (mirroring what RomM itself
 * exposes as `fs_name_no_tags`) fixes that; the exact tagged filename is
 * still required to match via `fs_name_no_ext`/`fs_name` below, so this
 * only loosens the search query, not the final match.
 */
function stripTags(name: string): string {
  return name.replace(/[([][^)\]]*[)\]]/g, "").trim();
}

/** Raw search candidates, tag-stripped query — used where the caller needs to apply its own match logic (e.g. pspSave.ts's fuzzier title matching). */
export async function searchRoms(term: string): Promise<RommRomMatch[]> {
  const qs = new URLSearchParams({
    search_term: stripTags(term) || term,
    limit: "25",
    with_char_index: "false",
    with_filter_values: "false",
  });
  const res = await rommFetchOk(`/api/roms?${qs}`);
  const data = (await res.json()) as { items: RommRomMatch[] };
  return data.items ?? [];
}

/** Finds a rom whose on-disk filename (without extension) matches `baseName`. */
export async function findRomByBaseName(baseName: string): Promise<RommRomMatch | null> {
  const items = await searchRoms(baseName);
  const lower = baseName.toLowerCase();
  return (
    items.find((r) => r.fs_name_no_ext.toLowerCase() === lower) ??
    items.find((r) => r.fs_name.toLowerCase() === lower) ??
    null
  );
}

/** Used to recover a rom's canonical filename when building the manifest (see manifest.ts). */
export async function getRomById(id: number): Promise<RommRomMatch | null> {
  return cached(`rom:${id}`, async () => {
    const res = await rommFetch(`/api/roms/${id}/simple`);
    if (res.status === 404) return null;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new RommApiError("GET", `/api/roms/${id}/simple`, res.status, body);
    }
    return (await res.json()) as RommRomMatch;
  });
}

export async function listPlatforms(): Promise<RommPlatform[]> {
  return cached("platforms", async () => {
    const res = await rommFetchOk(`/api/platforms`);
    return (await res.json()) as RommPlatform[];
  });
}

const ROM_PAGE_SIZE = 250;
// Safety cap so a pathological/misreported `total` can't turn a directory
// listing into an unbounded loop.
const ROM_LIST_MAX = 20000;

export async function listRomsForPlatform(platformId: number): Promise<RommRom[]> {
  return cached(`roms:${platformId}`, async () => {
    const roms: RommRom[] = [];
    let offset = 0;
    for (;;) {
      const qs = new URLSearchParams({
        platform_ids: String(platformId),
        limit: String(ROM_PAGE_SIZE),
        offset: String(offset),
        with_char_index: "false",
        with_filter_values: "false",
        // Needed to get real per-file names (with extension) for
        // single-nested-file roms — see displayName() in romBrowser.ts.
        // Without it `files` comes back as an empty array.
        with_files: "true",
      });
      const res = await rommFetchOk(`/api/roms?${qs}`);
      const data = (await res.json()) as { items: RommRom[]; total: number };
      roms.push(...data.items);
      offset += data.items.length;
      if (data.items.length === 0 || offset >= data.total || offset >= ROM_LIST_MAX) break;
    }
    return roms;
  });
}

/**
 * Streams a rom's content without buffering it in memory — roms in a
 * personal library regularly run 300MB-1.5GB+, so unlike the save/state
 * downloads above (which are small enough to buffer), this hands back the
 * raw fetch Response for the caller to pipe straight through.
 *
 * RomM's content endpoint properly supports Range requests (verified
 * against a live instance — returns real 206/Content-Range), which matters
 * a lot at this file size over a tunnel: forwarding the client's Range
 * header through is what lets iOS Files resume an interrupted download
 * instead of restarting a 1GB+ transfer from zero.
 */
export async function fetchRomContentStream(
  id: number,
  fileName: string,
  range?: string,
): Promise<Response> {
  const encoded = encodeURIComponent(fileName);
  const headers = range ? { Range: range } : undefined;
  return rommFetchOk(`/api/roms/${id}/content/${encoded}`, { headers });
}

export async function listSaves(): Promise<RommAsset[]> {
  return cached("saves", async () => {
    const res = await rommFetchOk(`/api/saves`);
    return (await res.json()) as RommAsset[];
  });
}

export async function listStates(): Promise<RommAsset[]> {
  return cached("states", async () => {
    const res = await rommFetchOk(`/api/states`);
    return (await res.json()) as RommAsset[];
  });
}

async function downloadAsset(kind: "saves" | "states", id: number): Promise<Buffer> {
  const res = await rommFetchOk(`/api/${kind}/${id}/content`);
  return Buffer.from(await res.arrayBuffer());
}

export const downloadSave = (id: number) => downloadAsset("saves", id);
export const downloadState = (id: number) => downloadAsset("states", id);

async function uploadNewAsset(
  kind: "saves" | "states",
  romId: number,
  fileName: string,
  content: Buffer,
  emulator: string | null,
): Promise<RommAsset> {
  const form = new FormData();
  const field = kind === "saves" ? "saveFile" : "stateFile";
  form.append(field, new Blob([content]), fileName);

  const qs = new URLSearchParams({ rom_id: String(romId), overwrite: "true" });
  // Only saves support a "slot" — RomM pairs saves on (rom_id, slot), and a
  // stable non-null slot keeps this a single updatable row instead of an
  // ever-growing archival history (RomM never dedupes null-slot saves).
  // States have no slot concept in the API.
  if (kind === "saves") qs.set("slot", config.rommSaveSlot);
  // Records which core (RetroArch's own per-core subfolder name, e.g.
  // "Snes9x") this save/state came from, so the manifest can reconstruct
  // the exact same subfolder path RetroArch itself uses locally — see
  // manifest.ts. Without this, the manifest's path and RetroArch's local
  // path never match, and RetroArch re-uploads the "missing" file on
  // every single sync.
  if (emulator) qs.set("emulator", emulator);
  const res = await rommFetchOk(`/api/${kind}?${qs}`, { method: "POST", body: form });
  invalidateAssetCache(kind);
  return (await res.json()) as RommAsset;
}

export const uploadNewSave = (
  romId: number,
  fileName: string,
  content: Buffer,
  emulator: string | null,
) => uploadNewAsset("saves", romId, fileName, content, emulator);
export const uploadNewState = (
  romId: number,
  fileName: string,
  content: Buffer,
  emulator: string | null,
) => uploadNewAsset("states", romId, fileName, content, emulator);

async function deleteAssets(kind: "saves" | "states", ids: number[]): Promise<void> {
  const body = kind === "saves" ? { saves: ids } : { states: ids };
  await rommFetchOk(`/api/${kind}/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  invalidateAssetCache(kind);
}

export const deleteSaves = (ids: number[]) => deleteAssets("saves", ids);
export const deleteStates = (ids: number[]) => deleteAssets("states", ids);

export { RommApiError };
