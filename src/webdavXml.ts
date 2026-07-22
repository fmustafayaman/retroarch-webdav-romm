export interface PropfindEntry {
  /** Path relative to the WebDAV root, e.g. "roms/" or "roms/psx/Game.zip". */
  href: string;
  isCollection: boolean;
  displayName: string;
  contentLength?: number;
  lastModified?: Date;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function hrefEscape(path: string): string {
  return (
    "/" +
    path
      .split("/")
      .map((seg) => encodeURIComponent(seg))
      .join("/")
  );
}

function responseXml(entry: PropfindEntry): string {
  const resourceType = entry.isCollection ? "<D:collection/>" : "";
  const extra = entry.isCollection
    ? ""
    : `<D:getcontentlength>${entry.contentLength ?? 0}</D:getcontentlength>` +
      `<D:getcontenttype>application/octet-stream</D:getcontenttype>`;
  const lastModified = entry.lastModified
    ? `<D:getlastmodified>${entry.lastModified.toUTCString()}</D:getlastmodified>`
    : "";

  return (
    `<D:response>` +
    `<D:href>${hrefEscape(entry.href)}</D:href>` +
    `<D:propstat><D:prop>` +
    `<D:resourcetype>${resourceType}</D:resourcetype>` +
    `<D:displayname>${xmlEscape(entry.displayName)}</D:displayname>` +
    extra +
    lastModified +
    `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>` +
    `</D:response>`
  );
}

export function buildMultistatus(entries: PropfindEntry[]): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<D:multistatus xmlns:D="DAV:">` +
    entries.map(responseXml).join("") +
    `</D:multistatus>`
  );
}
