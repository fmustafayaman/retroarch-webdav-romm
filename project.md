Prompt: RomM ↔ RetroArch WebDAV Shim

Build a lightweight WebDAV server that acts as a proxy/shim between RetroArch's built-in Cloud Sync feature and a self-hosted RomM instance's API, so RetroArch (specifically iOS) can sync save files and save states through RomM as the backing store, without RomM needing native WebDAV support.

Context
RomM (https://github.com/rommapp/romm) exposes a REST API for browsing roms/platforms and (per RFC in rommapp/romm#2199) an API-client save sync mechanism — I need you to check the current RomM API docs/OpenAPI schema (usually at /api/docs or /openapi.json on a running instance) for the actual save/state upload/download endpoints and auth method (likely session cookie or Bearer token).
RetroArch's Cloud Sync (Settings → Saving → Cloud Sync) only speaks WebDAV. It expects: a WebDAV base URL, basic auth (user/pass), and standard WebDAV verbs (PROPFIND, GET, PUT, DELETE, MKCOL) against a folder structure containing config/, saves/, states/, etc. Reference: https://docs.libretro.com/guides/retroarch-cloud-sync/
Goal: RetroArch talks WebDAV to this shim. The shim translates WebDAV operations into RomM API calls, so save files physically live in RomM (per-user, per-game), not on a separate WebDAV volume.
Requirements
Language/stack: Node.js (TypeScript) using the webdav-server npm package (or Python with wsgidav if you think it's a better fit — pick one and justify briefly). Should run as a single Docker container.
Auth: HTTP Basic Auth on the WebDAV side. Map the basic-auth credentials to a RomM API token/session — support at minimum a static mapping via env vars for a single-user setup (RomM username/password or API key stored in shim config), since this is for personal/family use, not multi-tenant.
Folder mapping: Implement the minimal WebDAV verb set RetroArch's Cloud Sync needs (PROPFIND, GET, PUT, DELETE, MKCOL, MOVE if used). Map the virtual WebDAV path structure RetroArch expects to RomM API calls:
listing a directory → list matching save/state files from RomM for the relevant game/platform
GET a file → fetch bytes from RomM
PUT a file → upload bytes to RomM, associating with the correct rom/game (match by filename — RetroArch save filenames mirror the rom filename)
DELETE → remove from RomM if the API supports it, else soft-fail gracefully (log + 204) since RetroArch treats deletes as best-effort
Conflict handling: Don't try to be clever — last-write-wins is fine for v1. Note any TODO where real conflict resolution would matter.
Config: .env for RomM base URL, credentials, and the shim's own listen port/bind address. No hardcoded secrets.
Logging: Log every WebDAV request (verb + path) and the RomM API call it triggered, at debug level, so I can troubleshoot RetroArch's cloud sync failures (RetroArch's own error messages are useless — just "Cloud Sync failed").
Deliverables:
Working source code with a Dockerfile
A docker-compose.yml snippet suitable for deployment on Coolify alongside an existing RomM instance
A short README covering: how to configure RetroArch's Cloud Sync settings to point at this shim, how to set env vars, and known limitations (e.g., save states are core/version-specific so cross-core sync may not "just work" — that's a RetroArch limitation, not this shim's)
Before writing code
First inspect a live RomM instance's API (ask me for the base URL if you need to hit it, or read RomM's OpenAPI spec / GitHub source) to confirm the actual endpoints for: listing roms/platforms, and uploading/downloading save files and save states, plus what auth headers they expect. Don't assume — verify against the real schema before implementing the mapping layer.
Ask me before choosing Node vs Python if you don't have a strong reason to prefer one.
Non-goals for v1
Multi-user support (single-user/family personal setup is fine)
Real-time bidirectional sync outside of what RetroArch's Cloud Sync already triggers (login, resume-from-background, manual "Sync Now")
ROM file distribution — this shim is saves/states only, ROMs are handled separately
