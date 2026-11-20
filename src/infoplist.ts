import fs from 'node:fs';
import path from 'node:path';
import plist from 'plist';
import type { Analysis } from './analyze.js';
import { findExpoConfig } from './ios.js';
import { PURPOSE_KEYS } from './purpose.js';
import type { ScanResult } from './types.js';

/**
 * Purpose strings: which ones the app needs (from its code and its libraries) and whether
 * Info.plist, or app.json in an Expo project, has them.
 */
export type PurposeStatus = 'ok' | 'missing' | 'empty' | 'by-plugin';

export interface PurposeCheck {
  key: string;
  label: string;
  status: PurposeStatus;
  /** Missing it does not block the upload, but the feature fails at runtime. */
  runtimeOnly: boolean;
  /** The libraries (or your code) that ask for this access. */
  packages: string[];
  /** Where it was looked up: an Info.plist path or app.json. */
  checked: string;
  /** For by-plugin: the config plugin that adds it at prebuild. */
  plugin?: string;
}

/**
 * Expo config plugins that add default purpose strings at prebuild. Expo applies these for installed
 * packages even when they are not listed in app.json (they started as app.json permissions).
 */
export const EXPO_PLUGIN_KEYS: Record<string, string[]> = {
  'expo-camera': ['NSCameraUsageDescription', 'NSMicrophoneUsageDescription'],
  'expo-image-picker': ['NSPhotoLibraryUsageDescription', 'NSCameraUsageDescription', 'NSMicrophoneUsageDescription'],
  'expo-media-library': ['NSPhotoLibraryUsageDescription', 'NSPhotoLibraryAddUsageDescription'],
  'expo-location': ['NSLocationWhenInUseUsageDescription', 'NSLocationAlwaysAndWhenInUseUsageDescription'],
  'expo-contacts': ['NSContactsUsageDescription'],
  'expo-calendar': ['NSCalendarsUsageDescription', 'NSRemindersUsageDescription'],
  'expo-av': ['NSMicrophoneUsageDescription'],
  'expo-sensors': ['NSMotionUsageDescription'],
  'expo-local-authentication': ['NSFaceIDUsageDescription'],
};

/** Plugins that only add their strings when listed in app.json `plugins`. */
const LISTED_ONLY = new Set(['expo-audio', 'expo-tracking-transparency', 'expo-speech-recognition']);
export const EXPO_LISTED_PLUGIN_KEYS: Record<string, string[]> = {
  'expo-audio': ['NSMicrophoneUsageDescription'],
  'expo-tracking-transparency': ['NSUserTrackingUsageDescription'],
};

function readPlist(file: string): Record<string, unknown> | null {
  try {
    const v = plist.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The main app's Info.plist (not an extension's). */
export function findAppInfoPlist(projectDir: string): string | null {
  const iosDir = path.join(projectDir, 'ios');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(iosDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const project = entries.find((e) => e.isDirectory() && e.name.endsWith('.xcodeproj'))?.name.replace(/\.xcodeproj$/, '');
  const candidates = [
    ...(project ? [path.join(iosDir, project, 'Info.plist')] : []),
    ...entries.filter((e) => e.isDirectory() && !['Pods', 'build'].includes(e.name) && !/Tests$/.test(e.name)).map((e) => path.join(iosDir, e.name, 'Info.plist')),
  ];
  for (const file of candidates) {
    const p = fs.existsSync(file) ? readPlist(file) : null;
    if (p && !p.NSExtension) return file;
  }
  return null;
}

const present = (v: unknown) => typeof v === 'string' && v.trim() !== '';
const has = (dict: Record<string, unknown>, key: string) => [key, ...(PURPOSE_KEYS[key].alternatives ?? [])].find((k) => k in dict);

/** Check one Info.plist-like dictionary against the purpose strings needed. */
export function checkPurposes(needed: Analysis['purposes'], dict: Record<string, unknown>, checked: string): PurposeCheck[] {
  return needed.map((n) => {
    const found = has(dict, n.key);
    return {
      key: n.key,
      label: PURPOSE_KEYS[n.key].label,
      runtimeOnly: !!PURPOSE_KEYS[n.key].runtimeOnly,
      packages: n.packages,
      checked,
      status: !found ? 'missing' : present(dict[found]) ? 'ok' : 'empty',
    };
  });
}

export interface PurposeResult {
  checks: PurposeCheck[];
  /** The Info.plist used, or null when only app.json could be read (Expo before prebuild). */
  infoPlist: string | null;
}

/**
 * Bare and Expo prebuild projects: the Info.plist in ios/ is what ships, so it decides. Expo managed
 * projects (no ios folder): app.json `ios.infoPlist`, plus the config plugins that add strings.
 */
export function checkAppPurposes(projectDir: string, scan: ScanResult, analysis: Analysis): PurposeResult {
  const needed = analysis.purposes;
  if (!needed.length) return { checks: [], infoPlist: null };
  const file = findAppInfoPlist(projectDir);
  if (file) {
    const dict = readPlist(file) ?? {};
    return { checks: checkPurposes(needed, dict, path.relative(projectDir, file)), infoPlist: file };
  }
  if (!scan.projectType.startsWith('expo')) return { checks: [], infoPlist: null };

  const cfg = findExpoConfig(projectDir);
  let infoPlist: Record<string, unknown> = {};
  let plugins: string[] = [];
  if (cfg?.appJson) {
    try {
      const json = JSON.parse(fs.readFileSync(cfg.appJson, 'utf8'));
      const root = json.expo ?? json;
      infoPlist = root?.ios?.infoPlist ?? {};
      plugins = (root?.plugins ?? []).map((p: unknown) => (Array.isArray(p) ? p[0] : p)).filter((p: unknown): p is string => typeof p === 'string');
    } catch { /* invalid app.json: other checks report it */ }
  }
  const installed = new Set(scan.packages.map((p) => p.name));
  const checks = checkPurposes(needed, infoPlist, 'app.json (expo.ios.infoPlist)');
  for (const c of checks) {
    if (c.status !== 'missing') continue;
    const auto = Object.entries(EXPO_PLUGIN_KEYS).find(([pkg, keys]) => installed.has(pkg) && keys.includes(c.key));
    const listed = Object.entries(EXPO_LISTED_PLUGIN_KEYS).find(([pkg, keys]) => plugins.includes(pkg) && keys.includes(c.key));
    // A library that needs it and has its own config plugin listed in app.json usually adds it.
    const own = c.packages.find((pkg) => plugins.includes(pkg) && !LISTED_ONLY.has(pkg));
    const plugin = auto?.[0] ?? listed?.[0] ?? own;
    if (plugin) {
      c.status = 'by-plugin';
      c.plugin = plugin;
    }
  }
  return { checks, infoPlist: null };
}

/** Purpose strings an extension's own code needs, checked against its Info.plist. */
export function checkExtensionPurposes(ext: { purposeUses: Map<string, unknown[]>; infoPlist: string; name: string }, projectDir: string): PurposeCheck[] {
  const needed = [...ext.purposeUses.keys()].map((key) => ({ key, packages: [ext.name] }));
  if (!needed.length) return [];
  return checkPurposes(needed as Analysis['purposes'], readPlist(ext.infoPlist) ?? {}, path.relative(projectDir, ext.infoPlist));
}
