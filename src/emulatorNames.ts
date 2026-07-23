/**
 * Translates between RomM's `emulator` field convention (lowercase
 * libretro core identifier, e.g. "snes9x") and RetroArch's actual local
 * save/state directory name (its display name, e.g. "Snes9x") — these are
 * NOT the same string, just differently-cased/spaced versions of each
 * other, and naively round-tripping one as the other silently drops saves
 * into a folder RetroArch never looks in (verified live — see manifest.ts
 * and README "Known limitations").
 *
 * This mirrors the table and logic in the community
 * romm-retroarch-sync project (github.com/Covin90/romm-retroarch-sync),
 * an existing desktop RomM↔RetroArch sync tool that had already solved
 * this exact problem — reused rather than re-derived from scratch.
 */
const RETROARCH_DIR_BY_ROMM_EMULATOR: Record<string, string> = {
  // SNES
  snes9x: "Snes9x",
  bsnes: "bsnes",
  "mesen-s": "Mesen-S",
  // NES
  nestopia: "Nestopia",
  fceumm: "FCEUmm",
  mesen: "Mesen",
  // PlayStation
  beetle_psx: "Beetle PSX",
  beetle_psx_hw: "Beetle PSX HW",
  pcsx_rearmed: "PCSX-ReARMed",
  swanstation: "SwanStation",
  mednafen_psx: "Beetle PSX",
  mednafen_psx_hw: "Beetle PSX HW",
  // Game Boy
  gambatte: "Gambatte",
  sameboy: "SameBoy",
  tgbdual: "TGB Dual",
  mgba: "mGBA",
  vba_next: "VBA Next",
  vbam: "VBA-M",
  // Genesis / Mega Drive
  genesis_plus_gx: "Genesis Plus GX",
  blastem: "BlastEm",
  picodrive: "PicoDrive",
  // Nintendo 64
  mupen64plus_next: "Mupen64Plus-Next",
  parallel_n64: "ParaLLEl N64",
  // Saturn
  beetle_saturn: "Beetle Saturn",
  kronos: "Kronos",
  mednafen_saturn: "Beetle Saturn",
  // Arcade / Neo Geo
  mame: "MAME",
  fbneo: "FBNeo",
  fbalpha: "FB Alpha",
  // PlayStation 2 / GameCube
  pcsx2: "PCSX2",
  play: "Play!",
  dolphin: "Dolphin",
  // Dreamcast
  flycast: "Flycast",
  redream: "Redream",
  // Atari
  stella: "Stella",
  // PC Engine
  beetle_pce: "Beetle PCE",
  beetle_pce_fast: "Beetle PCE Fast",
  mednafen_pce: "Beetle PCE",
  mednafen_pce_fast: "Beetle PCE Fast",
  // Other common cores
  dosbox_pure: "DOSBox-Pure",
  scummvm: "ScummVM",
  ppsspp: "PPSSPP",
  desmume: "DeSmuME",
  melonds: "melonDS",
  citra: "Citra",
};

/**
 * RomM platform slug -> a default RetroArch core folder, used only when a
 * save/state has no `emulator` field at all (verified live: RomM's own
 * browser player, EmulatorJS, never sets it — so a save made by playing a
 * game in RomM's web UI has nowhere to go but this shim's flat fallback
 * otherwise, landing at a path RetroArch's local sync never recognizes as
 * "the same file"). Slugs verified against RomM's own source
 * (`backend/handler/metadata/base_handler.py`'s `UniversalPlatformSlug`
 * enum) rather than guessed. Picking the actual core a specific user plays
 * a platform with is inherently a guess when RomM gives no signal at all —
 * these are just the most common choice per platform; override any of them
 * (or add platforms not listed here) via `DEFAULT_CORE_BY_PLATFORM` in
 * .env.
 */
const DEFAULT_CORE_BY_PLATFORM: Record<string, string> = {
  snes: "Snes9x",
  nes: "Nestopia",
  gb: "Gambatte",
  gbc: "Gambatte",
  gba: "mGBA",
  genesis: "Genesis Plus GX",
  n64: "Mupen64Plus-Next",
  saturn: "Beetle Saturn",
  psx: "Beetle PSX HW",
  ps2: "PCSX2",
  ngc: "Dolphin",
  dc: "Flycast",
  atari2600: "Stella",
  tg16: "Beetle PCE",
  dos: "DOSBox-Pure",
  psp: "PPSSPP",
  nds: "melonDS",
  n3ds: "Citra",
  arcade: "MAME",
};

/**
 * Best-effort default RetroArch core folder for a platform, when a
 * save/state has no `emulator` field to translate directly. `overrides`
 * (from `DEFAULT_CORE_BY_PLATFORM` in .env) take precedence over the
 * built-in table above; returns null for a platform with no default at
 * all (falls back to the old flat, no-subfolder behavior — see
 * manifest.ts).
 */
export function defaultCoreForPlatform(
  platformFsSlug: string,
  overrides: Record<string, string>,
): string | null {
  return overrides[platformFsSlug] ?? DEFAULT_CORE_BY_PLATFORM[platformFsSlug] ?? null;
}

/** RetroArch local directory name (e.g. "Snes9x") -> RomM's `emulator` convention (e.g. "snes9x"). */
export function toRommEmulator(retroarchDirName: string): string {
  return retroarchDirName.toLowerCase().replace(/[ -]/g, "_");
}

/**
 * RomM's `emulator` value -> RetroArch's local directory name. Falls back
 * to a best-effort transform (matching the reference project's fallback)
 * for cores not in the table: strips "_libretro", turns "beetle_"/
 * "mednafen_" into "Beetle ", underscores into spaces, and title-cases.
 */
export function toRetroArchDirName(rommEmulator: string): string {
  const mapped = RETROARCH_DIR_BY_ROMM_EMULATOR[rommEmulator.toLowerCase()];
  if (mapped) return mapped;

  let fallback = rommEmulator
    .replace(/^beetle_/, "Beetle ")
    .replace(/^mednafen_/, "Beetle ")
    .replace(/_libretro$/, "")
    .replace(/_/g, " ");
  fallback = fallback
    .split(" ")
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
  return fallback;
}
