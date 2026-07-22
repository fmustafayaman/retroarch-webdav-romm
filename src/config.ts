import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function rommAuth(): { kind: "bearer"; token: string } | { kind: "basic"; username: string; password: string } {
  const token = process.env.ROMM_API_TOKEN;
  if (token) return { kind: "bearer", token };

  const username = required("ROMM_USERNAME");
  const password = required("ROMM_PASSWORD");
  return { kind: "basic", username, password };
}

export const config = {
  rommBaseUrl: required("ROMM_BASE_URL").replace(/\/+$/, ""),
  rommAuth: rommAuth(),

  // Stable RomM save "slot" tag the shim uses for every save it creates.
  // Saves are paired on (rom_id, slot) by RomM's own sync engine; a stable,
  // non-null slot keeps our uploads as a single updatable row instead of
  // piling up as untethered archival entries (RomM treats null-slot saves
  // as archival/manual and never dedupes them). States have no slot
  // concept in the RomM API, so this only applies to saves.
  rommSaveSlot: process.env.ROMM_SAVE_SLOT ?? "webdav-shim",

  webdavUsername: required("WEBDAV_USERNAME"),
  webdavPassword: required("WEBDAV_PASSWORD"),

  port: Number(process.env.PORT ?? 8080),
  bindAddress: process.env.BIND_ADDRESS ?? "0.0.0.0",

  logLevel: process.env.LOG_LEVEL ?? "info",

  // How long rom-lookup and save/state listing results are cached in memory,
  // to avoid hammering RomM with repeat requests during a single RetroArch
  // sync pass (which can touch dozens of files back-to-back).
  cacheTtlSeconds: Number(process.env.CACHE_TTL_SECONDS ?? 30),
};
