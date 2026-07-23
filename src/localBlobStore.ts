import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

/**
 * Plain-file storage for the cloud-sync categories RomM has no concept of
 * at all — "config/", "thumbnails/", "system/" (see
 * `task_cloud_sync_directory_map` in RetroArch's own source: these are
 * separate top-level categories from "saves"/"states", each independently
 * toggled in Cloud Sync settings). Saves/states go through RomM
 * (assetSync.ts); these three go straight to disk under
 * `config.localBlobDir`, entirely unrelated to RomM. Unlike RomM-backed
 * assets, hashes here are always real MD5s of the actual bytes — no
 * synthetic-fallback problem (see manifest.ts), since we own the storage
 * directly.
 *
 * `config.localBlobDir` needs to be a persistent mount (host bind mount or
 * volume) — plain container filesystem is wiped on every
 * redeploy/restart, which would silently "lose" everything synced here.
 */

export interface LocalBlobEntry {
  /** WebDAV-relative path, e.g. "config/retroarch.cfg" — posix separators always, regardless of host OS. */
  path: string;
  hash: string;
  size: number;
  updatedAt: string;
}

/**
 * Rejects any path that would escape `localBlobDir` (e.g. `..` segments,
 * an absolute path smuggled through a WebDAV segment) — a WebDAV path is
 * attacker-controlled input over the network, and this is the one place
 * in the shim that touches the real filesystem outside a fixed root, so
 * it's the one place that actually needs this check.
 */
function resolveDiskPath(webdavPath: string): string {
  const normalized = path.posix.normalize(webdavPath);
  if (normalized.startsWith("..") || path.posix.isAbsolute(normalized)) {
    throw new Error(`Refusing to resolve path outside blob root: ${webdavPath}`);
  }
  return path.join(config.localBlobDir, ...normalized.split("/"));
}

export async function readLocalBlob(webdavPath: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(resolveDiskPath(webdavPath));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function writeLocalBlob(webdavPath: string, content: Buffer): Promise<void> {
  const diskPath = resolveDiskPath(webdavPath);
  await fs.mkdir(path.dirname(diskPath), { recursive: true });
  await fs.writeFile(diskPath, content);
}

/** Best-effort, like every other delete in this shim — RetroArch treats cloud sync deletes as fire-and-forget. */
export async function deleteLocalBlob(webdavPath: string): Promise<boolean> {
  try {
    await fs.unlink(resolveDiskPath(webdavPath));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Recursively lists every file under a top-level category ("config",
 * "thumbnails", "system") for the manifest — real MD5 of the actual bytes
 * each time (these files are typically tiny — .cfg/.png/.bin — so hashing
 * on every manifest build is cheap, unlike RomM-backed assets where the
 * same approach means a network round-trip).
 */
export async function listLocalBlobs(category: string): Promise<LocalBlobEntry[]> {
  const root = resolveDiskPath(category);
  const entries: LocalBlobEntry[] = [];

  async function walk(dir: string, relPrefix: string): Promise<void> {
    let items: import("node:fs").Dirent[];
    try {
      items = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }

    for (const item of items) {
      const rel = relPrefix ? `${relPrefix}/${item.name}` : item.name;
      const abs = path.join(dir, item.name);
      if (item.isDirectory()) {
        await walk(abs, rel);
      } else if (item.isFile()) {
        const [stat, content] = await Promise.all([fs.stat(abs), fs.readFile(abs)]);
        entries.push({
          path: `${category}/${rel}`,
          hash: crypto.createHash("md5").update(content).digest("hex"),
          size: stat.size,
          updatedAt: stat.mtime.toISOString(),
        });
      }
    }
  }

  await walk(root, "");
  return entries;
}
