import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { buildServerManifest } from "./manifest.js";
import { resolveAssetPath, findAssetByFileName, downloadAssetContent, putAssetContent, deleteAssetContent } from "./assetSync.js";

const MANIFEST_PATH = "manifest.server";

const ALLOWED_METHODS = "OPTIONS, GET, PUT, DELETE, MKCOL, MOVE";

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
    DAV: "1",
    "Content-Length": "0",
  });
  res.end();
}

async function handleGet(reqPath: string, res: ServerResponse) {
  if (reqPath === MANIFEST_PATH) {
    const body = await buildServerManifest();
    res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
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
  const destPath = destination ? decodeURIComponent(new URL(String(destination)).pathname).replace(/^\/+/, "") : "";
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
        case "GET":
          return await handleGet(reqPath, res);
        case "PUT":
          return await handlePut(reqPath, req, res);
        case "DELETE":
          return await handleDelete(reqPath, res);
        case "MKCOL":
          return await handleMkcol(res);
        case "MOVE":
          return await handleMove(reqPath, req, res);
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
