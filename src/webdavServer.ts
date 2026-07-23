import http, { type IncomingMessage, type ServerResponse } from "node:http";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { config } from "./config.js";
import { logger } from "./logger.js";
import {
  buildServerManifest,
  listSaveStateHistoryEntries,
  parseHistoryAssetId,
  type ManifestEntry,
} from "./manifest.js";
import {
  resolveAssetPath,
  findAssetForDownload,
  downloadAssetContent,
  putAssetContent,
  deleteAssetContent,
  type AssetKind,
} from "./assetSync.js";
import { listRomPlatforms, listRomFiles, findRomFile } from "./romBrowser.js";
import { fetchRomContentStream, listSaves, listStates, type RommAsset } from "./rommClient.js";
import { buildMultistatus, type PropfindEntry } from "./webdavXml.js";
import { resolvePspPath, getPspFile, putPspFile } from "./pspSave.js";

const MANIFEST_PATH = "manifest.server";

const ALLOWED_METHODS = "OPTIONS, PROPFIND, GET, HEAD, PUT, DELETE, MKCOL, MOVE, LOCK, UNLOCK";

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function isAuthorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (!header?.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
  const sep = decoded.indexOf(":");
  if (sep === -1) return false;
  const user = decoded.slice(0, sep);
  const pass = decoded.slice(sep + 1);
  return user === config.webdavUsername && pass === config.webdavPassword;
}

function requestPath(req: IncomingMessage): string {
  // RetroArch net_http_urlencode_full percent-encodes the path; decode it
  // back to a plain relative path (e.g. "saves/Chrono%20Trigger.srm").
  const url = new URL(req.url ?? "/", "http://placeholder");
  return decodeURIComponent(url.pathname).replace(/^\/+/, "");
}

async function handleOptions(res: ServerResponse) {
  res.writeHead(200, {
    Allow: ALLOWED_METHODS,
    // Class 2 (locking) is advertised alongside the fake LOCK/UNLOCK below —
    // some WebDAV clients (iOS Files among them, by report) refuse to treat
    // a server as mountable at all without it, even for read-only browsing.
    DAV: "1, 2",
    "Content-Length": "0",
  });
  res.end();
}

/**
 * Fake, always-succeeds locking. Nothing here is actually lockable — the
 * shim has no concept of concurrent writers to guard against — but some
 * WebDAV clients (iOS Files among them, by report) won't complete
 * "Connect to Server" without a server that at least answers LOCK/UNLOCK,
 * so this exists purely for that compatibility handshake.
 */
async function handleLock(res: ServerResponse) {
  const token = `opaquelocktoken:${crypto.randomUUID()}`;
  const body =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock>` +
    `<D:locktype><D:write/></D:locktype>` +
    `<D:lockscope><D:exclusive/></D:lockscope>` +
    `<D:depth>0</D:depth>` +
    `<D:timeout>Second-3600</D:timeout>` +
    `<D:locktoken><D:href>${token}</D:href></D:locktoken>` +
    `</D:activelock></D:lockdiscovery></D:prop>`;
  res.writeHead(200, {
    "Content-Type": "text/xml; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Lock-Token": `<${token}>`,
  });
  res.end(body);
}

async function handleUnlock(res: ServerResponse) {
  res.writeHead(204).end();
}

/**
 * PROPFIND is implemented for the "roms/" tree (source: RomM's own rom
 * listing) and the "saves/"/"states/" trees (source: the same {path, hash,
 * size} entries the manifest.server synthesizer already computes — see
 * manifest.ts) purely so a real WebDAV client (e.g. iOS Files app's
 * "Connect to Server") can browse them. RetroArch's own Cloud Sync client
 * never sends PROPFIND — verified against its source — so none of this is
 * on RetroArch's actual sync path; it exists solely for read-only human
 * browsing.
 */
async function handlePropfind(reqPath: string, req: IncomingMessage, res: ServerResponse) {
  const depth = req.headers["depth"] === "0" ? 0 : 1; // "1" and "infinity" both treated as one level

  const clean = reqPath.replace(/\/+$/, "");
  const parts = clean === "" ? [] : clean.split("/");

  let entries: PropfindEntry[] | null;
  if (parts.length === 0) {
    entries =
      depth === 0
        ? [rootEntry()]
        : [rootEntry(), romsRootEntry(), virtualRootEntry("saves"), virtualRootEntry("states")];
  } else if (parts.length === 1 && parts[0] === "roms") {
    entries = depth === 0 ? [romsRootEntry()] : [romsRootEntry(), ...(await platformEntries())];
  } else if (parts.length === 2 && parts[0] === "roms") {
    entries = await platformListing(parts[1], depth);
  } else if (parts.length === 3 && parts[0] === "roms") {
    entries = await romFileEntry(parts[1], parts[2]);
  } else if (parts[0] === "saves" || parts[0] === "states") {
    entries = await saveStateListing(parts, depth);
  } else {
    entries = null;
  }

  if (!entries) {
    res.writeHead(404).end();
    return;
  }

  const body = buildMultistatus(entries);
  res.writeHead(207, {
    // iOS Files' WebDAV client is known to be picky about this — "text/xml"
    // (the traditional WebDAV content type) is the safer bet over
    // "application/xml", which some Apple WebDAV client versions have
    // reportedly failed to parse.
    "Content-Type": "text/xml; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function rootEntry(): PropfindEntry {
  return { href: "", isCollection: true, displayName: "" };
}
function romsRootEntry(): PropfindEntry {
  return { href: "roms/", isCollection: true, displayName: "roms" };
}
async function platformEntries(): Promise<PropfindEntry[]> {
  const platforms = await listRomPlatforms();
  return platforms.map((p) => ({ href: `roms/${p.fsSlug}/`, isCollection: true, displayName: p.name }));
}
async function platformListing(slug: string, depth: 0 | 1): Promise<PropfindEntry[] | null> {
  const platforms = await listRomPlatforms();
  const platform = platforms.find((p) => p.fsSlug === slug);
  if (!platform) return null;
  const self: PropfindEntry = { href: `roms/${slug}/`, isCollection: true, displayName: platform.name };
  if (depth === 0) return [self];

  const files = await listRomFiles(slug);
  return [
    self,
    ...files.map((f) => ({
      href: `roms/${slug}/${f.displayName}`,
      isCollection: false,
      displayName: f.displayName,
      // Approximate for multi-file (zipped) roms — RomM reports the sum of
      // the underlying files, not the final zip's actual byte count. Only
      // affects what Files app displays while browsing; the real download
      // (handleRomContent below) always uses the upstream response's own
      // Content-Length, so the file itself is never truncated/misreported.
      contentLength: f.sizeBytes,
      lastModified: new Date(f.updatedAt),
    })),
  ];
}
async function romFileEntry(slug: string, fileName: string): Promise<PropfindEntry[] | null> {
  const file = await findRomFile(slug, fileName);
  if (!file) return null;
  return [
    {
      href: `roms/${slug}/${fileName}`,
      isCollection: false,
      displayName: fileName,
      contentLength: file.sizeBytes,
      lastModified: new Date(file.updatedAt),
    },
  ];
}

function virtualRootEntry(name: "saves" | "states"): PropfindEntry {
  return { href: `${name}/`, isCollection: true, displayName: name };
}

function toFileEntry(entry: ManifestEntry): PropfindEntry {
  return {
    href: entry.path,
    isCollection: false,
    displayName: entry.path.split("/").pop()!,
    contentLength: entry.size,
    lastModified: entry.updatedAt ? new Date(entry.updatedAt) : undefined,
  };
}

/**
 * Generic, variable-depth virtual directory listing for saves/states,
 * derived from the same flat {path, hash, size} entry list manifest.ts
 * builds for manifest.server — no separate directory tree is maintained,
 * it's reconstructed on the fly from the path segments. Needed because PSP
 * save bundles nest up to 5 levels deep
 * (saves/PPSSPP/PSP/SAVEDATA/<folder>/<file>), unlike every other
 * save/state which is a flat one-segment file directly under saves/states/
 * (or one emulator-subfolder segment deeper) — a fixed-depth listing like
 * roms/'s platformListing above can't handle both shapes.
 */
async function saveStateListing(parts: string[], depth: 0 | 1): Promise<PropfindEntry[] | null> {
  const clean = parts.join("/");
  const allEntries = await listSaveStateHistoryEntries();

  const exactFile = parts.length > 1 ? allEntries.find((e) => e.path === clean) : undefined;
  if (exactFile) return [toFileEntry(exactFile)];

  const prefix = `${clean}/`;
  const hasChildren = allEntries.some((e) => e.path.startsWith(prefix));
  // saves/ and states/ themselves always exist (even empty); any deeper
  // path segment must actually be a prefix of something real, or it's 404.
  if (parts.length > 1 && !hasChildren) return null;

  const self: PropfindEntry = { href: prefix, isCollection: true, displayName: parts[parts.length - 1]! };
  if (depth === 0) return [self];

  const childFolders = new Set<string>();
  const childFiles: ManifestEntry[] = [];
  for (const e of allEntries) {
    if (!e.path.startsWith(prefix)) continue;
    const rest = e.path.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) childFiles.push(e);
    else childFolders.add(rest.slice(0, slash));
  }

  return [
    self,
    ...[...childFolders]
      .sort()
      .map((f): PropfindEntry => ({ href: `${prefix}${f}/`, isCollection: true, displayName: f })),
    ...childFiles.map(toFileEntry),
  ];
}

async function handleRomContent(
  slug: string,
  fileName: string,
  req: IncomingMessage,
  res: ServerResponse,
  headOnly: boolean,
) {
  const file = await findRomFile(slug, fileName);
  if (!file) {
    res.writeHead(404).end();
    return;
  }

  if (headOnly) {
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": file.sizeBytes,
      "Accept-Ranges": "bytes",
    });
    res.end();
    return;
  }

  // Forward Range through to RomM — verified it returns real 206/Content-Range,
  // which is what lets iOS Files resume an interrupted 300MB-1.5GB+ download
  // instead of restarting from zero.
  const upstream = await fetchRomContentStream(file.romId, file.fsName, req.headers.range);
  const headers: Record<string, string> = { "Content-Type": "application/octet-stream", "Accept-Ranges": "bytes" };
  const upstreamLength = upstream.headers.get("content-length");
  if (upstreamLength) headers["Content-Length"] = upstreamLength;
  const contentRange = upstream.headers.get("content-range");
  if (contentRange) headers["Content-Range"] = contentRange;
  res.writeHead(upstream.status, headers);

  if (!upstream.body) {
    res.end();
    return;
  }
  // Roms routinely run 300MB-1.5GB+ — stream straight through rather than
  // buffering, unlike the (small) save/state downloads below.
  await pipeline(Readable.fromWeb(upstream.body as never), res);
}

async function findAssetById(kind: AssetKind, id: number): Promise<RommAsset | null> {
  const assets = kind === "saves" ? await listSaves() : await listStates();
  return assets.find((a) => a.id === id) ?? null;
}

async function handleGetOrHead(
  reqPath: string,
  req: IncomingMessage,
  res: ServerResponse,
  headOnly: boolean,
) {
  const romParts = reqPath.split("/");
  if (romParts.length === 3 && romParts[0] === "roms") {
    return handleRomContent(romParts[1], romParts[2], req, res, headOnly);
  }

  if (reqPath === MANIFEST_PATH) {
    if (headOnly) {
      res.writeHead(200, { "Content-Type": "application/json" }).end();
      return;
    }
    const body = await buildServerManifest();
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
    return;
  }

  const psp = resolvePspPath(reqPath);
  if (psp === "ignore") {
    res.writeHead(404).end();
    return;
  }
  if (psp) {
    const data = await getPspFile(psp);
    if (!data) {
      res.writeHead(404).end();
      return;
    }
    if (headOnly) {
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": data.length });
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": data.length });
    res.end(data);
    return;
  }

  const resolved = resolveAssetPath(reqPath);
  if (!resolved) {
    res.writeHead(404).end();
    return;
  }

  // Files browsed via saveStateListing (PROPFIND) for anything but the
  // current entry carry a "#<id>" marker in their filename — see
  // manifest.ts's listSaveStateHistoryEntries. Serve that exact RomM row
  // directly rather than the usual "newest for this rom" lookup, so
  // downloading an older save/state from a WebDAV client actually gets
  // the one you clicked, not whatever's newest.
  const historyId = parseHistoryAssetId(resolved.fileName);
  const asset =
    historyId !== null
      ? await findAssetById(resolved.kind, historyId)
      : await findAssetForDownload(resolved.kind, resolved.fileName);
  if (!asset) {
    res.writeHead(404).end();
    return;
  }

  if (headOnly) {
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": asset.file_size_bytes,
    });
    res.end();
    return;
  }

  const content = await downloadAssetContent(resolved.kind, asset.id);
  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Length": content.length,
  });
  res.end(content);
}

async function handlePut(reqPath: string, req: IncomingMessage, res: ServerResponse) {
  const body = await readBody(req);

  if (reqPath === MANIFEST_PATH) {
    // We regenerate manifest.server from RomM on every GET, so RetroArch's
    // uploaded copy is redundant — accept it and move on.
    res.writeHead(204).end();
    return;
  }

  const psp = resolvePspPath(reqPath);
  if (psp === "ignore") {
    logger.debug({ path: reqPath }, "PSP engine cache file, not save data — discarding");
    res.writeHead(204).end();
    return;
  }
  if (psp) {
    try {
      await putPspFile(psp, body);
      res.writeHead(201).end();
    } catch (err) {
      logger.error({ err, path: reqPath }, "failed to upload PSP save bundle to romm");
      // Not 502 — see the note on the normal-asset catch below, same reasoning.
      res.writeHead(204).end();
    }
    return;
  }

  const resolved = resolveAssetPath(reqPath);
  if (!resolved) {
    logger.warn(
      { path: reqPath },
      "PUT outside saves/ or states/ — not backed by RomM in v1, discarding. " +
        "Disable Configuration/Thumbnails/System File sync in RetroArch's Cloud Sync settings.",
    );
    res.writeHead(204).end();
    return;
  }

  try {
    await putAssetContent(resolved.kind, resolved.fileName, body, resolved.emulator);
    res.writeHead(201).end();
  } catch (err) {
    // Verified against RetroArch's own webdav.c: a failed WebDAV response
    // (any non-2xx) runs it through webdav_log_http_failure, which has a
    // documented one-byte heap overflow (writes a NUL past the end of the
    // response buffer) that RetroArch's own comment says can corrupt the
    // heap and crash "when cloud sync issues many requests in quick
    // succession". Reproduced live: a burst of PUTs that each failed with
    // 502 (unmatched PSP saves, before this fix) crashed RetroArch at the
    // exact same point on two separate sync attempts. Can't fix RetroArch's
    // C code from here, so the failure never reaches it as an HTTP error at
    // all — log it clearly on this end (same as every other
    // out-of-scope/unmatched case already handled this way) and return 204.
    logger.error({ err, path: reqPath }, "failed to upload asset to romm");
    res.writeHead(204).end();
  }
}

async function handleDelete(reqPath: string, res: ServerResponse) {
  // Best-effort no-op — deleting a single member out of a PSP save bundle
  // isn't implemented (RetroArch treats cloud sync deletes as best-effort
  // anyway, matching the rest of this shim's DELETE handling).
  if (resolvePspPath(reqPath)) {
    res.writeHead(204).end();
    return;
  }

  const resolved = resolveAssetPath(reqPath);
  if (!resolved) {
    res.writeHead(204).end();
    return;
  }

  try {
    const deleted = await deleteAssetContent(resolved.kind, resolved.fileName);
    logger.debug({ path: reqPath, deleted }, "delete processed");
  } catch (err) {
    // RetroArch treats cloud sync deletes as best-effort — never fail the sync over this.
    logger.warn({ err, path: reqPath }, "delete failed upstream, soft-failing");
  }
  res.writeHead(204).end();
}

async function handleMkcol(res: ServerResponse) {
  // We have no real directory tree — every "directory" implicitly exists.
  res.writeHead(201).end();
}

async function handleMove(reqPath: string, req: IncomingMessage, res: ServerResponse) {
  const destination = req.headers["destination"];
  logger.debug({ from: reqPath, to: destination }, "MOVE received");

  // Same best-effort no-op as handleDelete above, and for the same reason:
  // deleting a single member out of a PSP save bundle isn't implemented.
  // Verified live this matters — before this check, a MOVE-to-deleted for
  // a PSP member (e.g. "PARAM.SFO") fell through to the generic
  // resolveAssetPath/deleteAssetContent path below, which tried to find a
  // RomM rom literally titled "PARAM" — never matches, so the delete
  // silently no-op'd. The PSP bundle happened to survive, but only by
  // accident (a bogus lookup failing), not by design — this makes "leave
  // PSP bundles alone on MOVE" an intentional, correct no-op instead.
  if (resolvePspPath(reqPath)) {
    res.writeHead(204).end();
    return;
  }

  // RetroArch only issues MOVE to back up a file to "deleted/<path>-<timestamp>"
  // as a soft-delete when non-destructive delete mode is on. We treat any MOVE
  // whose destination lands under deleted/ as a delete of the source.
  const destPath = destination
    ? decodeURIComponent(new URL(String(destination)).pathname).replace(/^\/+/, "")
    : "";
  const resolved = resolveAssetPath(reqPath);

  if (resolved && destPath.startsWith("deleted/")) {
    try {
      const deleted = await deleteAssetContent(resolved.kind, resolved.fileName);
      logger.debug({ path: reqPath, deleted }, "move-to-deleted processed as delete");
    } catch (err) {
      logger.warn({ err, path: reqPath }, "move-to-deleted failed upstream, soft-failing");
    }
  }

  res.writeHead(204).end();
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const reqPath = requestPath(req);

    logger.debug({ method, path: reqPath }, "webdav request");

    if (!isAuthorized(req)) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="retroarch-webdav-romm"' });
      res.end();
      return;
    }

    try {
      switch (method) {
        case "OPTIONS":
          return await handleOptions(res);
        case "PROPFIND":
          return await handlePropfind(reqPath, req, res);
        case "GET":
          return await handleGetOrHead(reqPath, req, res, false);
        case "HEAD":
          return await handleGetOrHead(reqPath, req, res, true);
        case "PUT":
          return await handlePut(reqPath, req, res);
        case "DELETE":
          return await handleDelete(reqPath, res);
        case "MKCOL":
          return await handleMkcol(res);
        case "MOVE":
          return await handleMove(reqPath, req, res);
        case "LOCK":
          return await handleLock(res);
        case "UNLOCK":
          return await handleUnlock(res);
        default:
          res.writeHead(501).end();
      }
    } catch (err) {
      logger.error({ err, method, path: reqPath }, "unhandled error");
      if (!res.headersSent) res.writeHead(500).end();
      else res.end();
    }
  });
}
