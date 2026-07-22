import http, { type IncomingMessage, type ServerResponse } from "node:http";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { buildServerManifest } from "./manifest.js";
import {
  resolveAssetPath,
  findAssetByFileName,
  downloadAssetContent,
  putAssetContent,
  deleteAssetContent,
} from "./assetSync.js";
import { listRomPlatforms, listRomFiles, findRomFile } from "./romBrowser.js";
import { fetchRomContentStream } from "./rommClient.js";
import { buildMultistatus, type PropfindEntry } from "./webdavXml.js";

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
 * PROPFIND is only implemented for the "roms/" tree, which exists purely so
 * a real WebDAV client (e.g. iOS Files app's "Connect to Server") can
 * browse and download a copy of the RomM library. RetroArch's own Cloud
 * Sync client never sends PROPFIND — verified against its source — so
 * saves/states/manifest.server intentionally aren't listable here; nothing
 * in that flow depends on directory listings.
 */
async function handlePropfind(reqPath: string, req: IncomingMessage, res: ServerResponse) {
  const depth = req.headers["depth"] === "0" ? 0 : 1; // "1" and "infinity" both treated as one level

  const clean = reqPath.replace(/\/+$/, "");
  const parts = clean === "" ? [] : clean.split("/");

  let entries: PropfindEntry[] | null;
  if (parts.length === 0) {
    entries = depth === 0 ? [rootEntry()] : [rootEntry(), romsRootEntry()];
  } else if (parts.length === 1 && parts[0] === "roms") {
    entries = depth === 0 ? [romsRootEntry()] : [romsRootEntry(), ...(await platformEntries())];
  } else if (parts.length === 2 && parts[0] === "roms") {
    entries = await platformListing(parts[1], depth);
  } else if (parts.length === 3 && parts[0] === "roms") {
    entries = await romFileEntry(parts[1], parts[2]);
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

  const resolved = resolveAssetPath(reqPath);
  if (!resolved) {
    res.writeHead(404).end();
    return;
  }

  const asset = await findAssetByFileName(resolved.kind, resolved.fileName);
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
    await putAssetContent(resolved.kind, resolved.fileName, body);
    res.writeHead(201).end();
  } catch (err) {
    logger.error({ err, path: reqPath }, "failed to upload asset to romm");
    res.writeHead(502).end();
  }
}

async function handleDelete(reqPath: string, res: ServerResponse) {
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
