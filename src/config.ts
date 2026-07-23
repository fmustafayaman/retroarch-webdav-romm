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
  // Saves are paired on (rom_id, slot) by RomM's own sync engine. Default
  // is "autosave" — not an arbitrary choice: it's the same slot name
  // RomM's own reference clients (grout, muos-app, the community
  // romm-retroarch-sync desktop app) report a game's primary save under,
  // so saves from this shim pair with — rather than fragment away from —
  // whatever else in the user's setup also uses that convention. States
  // have no slot concept in this RomM version, so this only applies to
  // saves.
  rommSaveSlot: process.env.ROMM_SAVE_SLOT ?? "autosave",

  webdavUsername: required("WEBDAV_USERNAME"),
  webdavPassword: required("WEBDAV_PASSWORD"),

  port: Number(process.env.PORT ?? 8080),
  bindAddress: process.env.BIND_ADDRESS ?? "0.0.0.0",

  logLevel: process.env.LOG_LEVEL ?? "info",

  // How long rom-lookup and save/state listing results are cached in memory,
  // to avoid hammering RomM with repeat requests during a single RetroArch
  // sync pass (which can touch dozens of files back-to-back).
  cacheTtlSeconds: Number(process.env.CACHE_TTL_SECONDS ?? 30),

  // Max history rows kept per (rom, save-slot) / (rom, state-slot) — every
  // upload creates a new row (see assetSync.ts), so without a cap this
  // grows forever. Once a slot exceeds this count, the oldest rows beyond
  // it are deleted right after the upload that pushed it over. 0 disables
  // pruning (unlimited history, the old default).
  historyKeepCount: Number(process.env.HISTORY_KEEP_COUNT ?? 20),

  // RomM platform slug (e.g. "snes") -> RetroArch core folder name (e.g.
  // "Snes9x"), overriding/extending the built-in defaults in
  // emulatorNames.ts. Only matters for saves/states with no `emulator`
  // field at all (e.g. made via RomM's own web player) — see
  // `defaultCoreForPlatform`. JSON object, e.g. {"snes":"bsnes"} if you
  // don't use Snes9x.
  defaultCoreByPlatform: JSON.parse(process.env.DEFAULT_CORE_BY_PLATFORM ?? "{}") as Record<
    string,
    string
  >,

  // PSP serial (e.g. "ULUS10336") -> rom title, for matching a PPSSPP save
  // folder to a RomM rom. RomM has no PSP serial field to look this up
  // automatically (checked), so this is required for the *first* sync of
  // each PSP game's save — see pspSave.ts. JSON object, e.g.
  // {"ULUS10336":"Crisis Core - Final Fantasy VII"}.
  pspSerialMap: JSON.parse(process.env.PSP_SERIAL_MAP ?? "{}") as Record<string, string>,
};
