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
}

export interface RommRomMatch {
  id: number;
  fs_name: string;
  fs_name_no_ext: string;
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

/** Finds a rom whose on-disk filename (without extension) matches `baseName`. */
export async function findRomByBaseName(baseName: string): Promise<RommRomMatch | null> {
  const qs = new URLSearchParams({
    search_term: stripTags(baseName) || baseName,
    limit: "25",
    with_char_index: "false",
    with_filter_values: "false",
  });
  const res = await rommFetchOk(`/api/roms?${qs}`);
  const data = (await res.json()) as { items: RommRomMatch[] };
  const items = data.items ?? [];
  const lower = baseName.toLowerCase();
  return (
    items.find((r) => r.fs_name_no_ext.toLowerCase() === lower) ??
    items.find((r) => r.fs_name.toLowerCase() === lower) ??
    null
  );
}

/** Used to recover a rom's canonical filename when building the manifest (see manifest.ts). */
export async function getRomById(id: number): Promise<RommRomMatch | null> {
  const res = await rommFetch(`/api/roms/${id}/simple`);
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new RommApiError("GET", `/api/roms/${id}/simple`, res.status, body);
  }
  return (await res.json()) as RommRomMatch;
}

export async function listSaves(): Promise<RommAsset[]> {
  const res = await rommFetchOk(`/api/saves`);
  return (await res.json()) as RommAsset[];
}

export async function listStates(): Promise<RommAsset[]> {
  const res = await rommFetchOk(`/api/states`);
  return (await res.json()) as RommAsset[];
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
  const res = await rommFetchOk(`/api/${kind}?${qs}`, { method: "POST", body: form });
  return (await res.json()) as RommAsset;
}

async function updateExistingAsset(
  kind: "saves" | "states",
  id: number,
  fileName: string,
  content: Buffer,
): Promise<RommAsset> {
  const form = new FormData();
  const field = kind === "saves" ? "saveFile" : "stateFile";
  form.append(field, new Blob([content]), fileName);

  const res = await rommFetchOk(`/api/${kind}/${id}`, { method: "PUT", body: form });
  return (await res.json()) as RommAsset;
}

export const uploadNewSave = (romId: number, fileName: string, content: Buffer) =>
  uploadNewAsset("saves", romId, fileName, content);
export const uploadNewState = (romId: number, fileName: string, content: Buffer) =>
  uploadNewAsset("states", romId, fileName, content);
export const updateSave = (id: number, fileName: string, content: Buffer) =>
  updateExistingAsset("saves", id, fileName, content);
export const updateState = (id: number, fileName: string, content: Buffer) =>
  updateExistingAsset("states", id, fileName, content);

async function deleteAssets(kind: "saves" | "states", ids: number[]): Promise<void> {
  const body = kind === "saves" ? { saves: ids } : { states: ids };
  await rommFetchOk(`/api/${kind}/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export const deleteSaves = (ids: number[]) => deleteAssets("saves", ids);
export const deleteStates = (ids: number[]) => deleteAssets("states", ids);

export { RommApiError };
