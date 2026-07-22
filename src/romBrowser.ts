import { listPlatforms, listRomsForPlatform, type RommRom } from "./rommClient.js";

export interface RomFile {
  /** Filename as shown/downloaded over WebDAV — see displayName() below. */
  displayName: string;
  romId: number;
  /** Exact fs_name RomM expects in its content URL — not necessarily displayName. */
  fsName: string;
  sizeBytes: number;
  updatedAt: string;
}

/**
 * RomM zips up genuinely multi-file roms (multi-disc/multi-track games) on
 * download and includes an .m3u — the WebDAV listing should show that
 * reality (a .zip) rather than the original fs_name. Verified against a
 * live instance that `has_simple_single_file: false` is NOT the right
 * signal for this: a rom stored one-file-in-a-subfolder reports
 * `has_nested_single_file: true` but still downloads as the raw file
 * (confirmed via `file`, got back a real .chd, not a zip) — only
 * `has_multiple_files: true` actually triggers zipping server-side.
 *
 * For that single-nested-file case, `fs_name` itself turned out to be the
 * *folder* name with no extension (e.g. "Alundra (USA) (v1.1)", not
 * "....chd") — also verified live. The real filename (with extension) is
 * on `files[0].file_name`, which the roms list endpoint includes by
 * default; falling back to `fs_name` only if that's ever missing.
 */
function displayName(rom: RommRom): string {
  if (rom.has_multiple_files) return `${rom.fs_name_no_ext}.zip`;
  return rom.files[0]?.file_name ?? rom.fs_name;
}

export async function listRomPlatforms(): Promise<{ fsSlug: string; name: string }[]> {
  const platforms = await listPlatforms();
  return platforms.filter((p) => p.rom_count > 0).map((p) => ({ fsSlug: p.fs_slug, name: p.name }));
}

export async function listRomFiles(platformFsSlug: string): Promise<RomFile[]> {
  const platforms = await listPlatforms();
  const platform = platforms.find((p) => p.fs_slug === platformFsSlug);
  if (!platform) return [];

  const roms = await listRomsForPlatform(platform.id);
  return roms.map((r) => ({
    displayName: displayName(r),
    romId: r.id,
    fsName: r.fs_name,
    sizeBytes: r.fs_size_bytes,
    updatedAt: r.updated_at,
  }));
}

export async function findRomFile(
  platformFsSlug: string,
  fileName: string,
): Promise<RomFile | null> {
  const files = await listRomFiles(platformFsSlug);
  return files.find((f) => f.displayName === fileName) ?? null;
}
