import fs from 'node:fs';
import type { ApiCategory } from './types.js';
import { findPurposeUsesInBinary } from './purpose.js';

/**
 * Required reason APIs in prebuilt binaries (.framework, .xcframework, .a).
 *
 * Compiled code keeps the names of the system functions, Objective-C classes and selectors
 * it uses as zero-terminated strings (symbol and selector tables). Searching for those exact
 * names finds the same imports `nm -u` lists, without needing Apple's tools, so it also works
 * on Linux CI.
 */
const SYMBOLS: Record<ApiCategory, string[]> = {
  NSPrivacyAccessedAPICategoryUserDefaults: ['_OBJC_CLASS_$_NSUserDefaults'],
  NSPrivacyAccessedAPICategoryFileTimestamp: [
    '_stat', '_fstat', '_lstat', '_fstatat', '_stat$INODE64', '_fstat$INODE64', '_lstat$INODE64',
    '_getattrlist', '_getattrlistbulk', '_fgetattrlist', '_getattrlistat',
    '_NSFileCreationDate', '_NSFileModificationDate', '_NSURLCreationDateKey', '_NSURLContentModificationDateKey',
  ],
  NSPrivacyAccessedAPICategorySystemBootTime: ['_mach_absolute_time', 'systemUptime'],
  NSPrivacyAccessedAPICategoryDiskSpace: [
    '_statfs', '_statvfs', '_fstatfs', '_fstatvfs', '_statfs$INODE64', '_fstatfs$INODE64',
    '_NSFileSystemFreeSize', '_NSFileSystemSize',
    '_NSURLVolumeAvailableCapacityKey', '_NSURLVolumeAvailableCapacityForImportantUsageKey',
    '_NSURLVolumeAvailableCapacityForOpportunisticUsageKey', '_NSURLVolumeTotalCapacityKey',
  ],
  NSPrivacyAccessedAPICategoryActiveKeyboards: ['activeInputModes'],
};

/** Swift types are mangled; the type name still appears as is. Matched without the zero bytes. */
const SWIFT: Partial<Record<ApiCategory, string[]>> = {
  NSPrivacyAccessedAPICategoryUserDefaults: ['10Foundation12UserDefaultsC'],
};

const PATTERNS = (Object.keys(SYMBOLS) as ApiCategory[]).flatMap((category) => [
  ...SYMBOLS[category].map((name) => ({ category, name: name.replace(/^_/, ''), bytes: Buffer.from(`\0${name}\0`, 'latin1') })),
  ...(SWIFT[category] ?? []).map((name) => ({ category, name: 'UserDefaults (Swift)', bytes: Buffer.from(name, 'latin1') })),
]);

/** Files larger than this are not read (a few SDK binaries are hundreds of MB). */
export const MAX_BINARY_BYTES = 300 * 1024 * 1024;

const MAGICS = [
  [0xfe, 0xed, 0xfa, 0xce], [0xfe, 0xed, 0xfa, 0xcf], [0xce, 0xfa, 0xed, 0xfe], [0xcf, 0xfa, 0xed, 0xfe], // Mach-O
  [0xca, 0xfe, 0xba, 0xbe], [0xbe, 0xba, 0xfe, 0xca], // universal (fat) binary
];
const AR_MAGIC = Buffer.from('!<arch>\n', 'latin1'); // static library

/** True for Mach-O executables, dynamic libraries, universal binaries and static libraries. */
export function isAppleBinary(file: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(8);
    const n = fs.readSync(fd, head, 0, 8, 0);
    if (n < 4) return false;
    if (n >= 8 && head.equals(AR_MAGIC)) return true;
    return MAGICS.some((m) => m.every((b, i) => head[i] === b));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export interface BinaryHit {
  category: ApiCategory;
  symbol: string;
}

/** Required reason API symbols in one binary. Returns null when the file is too large to read. */
export function scanBinary(file: string): BinaryHit[] | null {
  return scanBinaryFull(file)?.apis ?? null;
}

/** Required reason APIs and the permission requests (purpose strings) in one binary, reading it once. */
export function scanBinaryFull(file: string): { apis: BinaryHit[]; purposes: { key: string; symbol: string }[] } | null {
  const size = fs.statSync(file).size;
  if (size > MAX_BINARY_BYTES) return null;
  const data = fs.readFileSync(file);
  const hits: BinaryHit[] = [];
  for (const p of PATTERNS) {
    if (hits.some((h) => h.category === p.category)) continue;
    if (data.indexOf(p.bytes) !== -1) hits.push({ category: p.category, symbol: p.name });
  }
  return { apis: hits, purposes: findPurposeUsesInBinary(data) };
}

/** Slices that never ship in an iOS app build (when an iOS device slice exists, that is enough). */
export const SKIP_SLICE = /(macos|maccatalyst|tvos|watchos|xros|visionos|simulator)/i;
