import fs from 'node:fs';
import path from 'node:path';
import type { DataType } from './types.js';

/**
 * Android permissions that matter for Google Play's Data safety form and the Advertising ID
 * declaration. A permission only means the app *can* read the data: declare it in Data safety
 * when the data leaves the device.
 */
export const SENSITIVE_PERMISSIONS: Record<string, { label: string; type?: DataType; note?: string }> = {
  'android.permission.ACCESS_FINE_LOCATION': { label: 'Precise location', type: 'precise-location' },
  'android.permission.ACCESS_COARSE_LOCATION': { label: 'Approximate location', type: 'coarse-location' },
  'android.permission.ACCESS_BACKGROUND_LOCATION': { label: 'Location in the background', type: 'precise-location', note: 'Play also requires a background location declaration.' },
  'android.permission.READ_CONTACTS': { label: 'Contacts', type: 'contacts' },
  'android.permission.CAMERA': { label: 'Camera', type: 'photos-videos' },
  'android.permission.READ_MEDIA_IMAGES': { label: 'Photos', type: 'photos-videos', note: 'Play restricts this permission to apps whose core use needs broad photo access.' },
  'android.permission.READ_MEDIA_VIDEO': { label: 'Videos', type: 'photos-videos', note: 'Play restricts this permission to apps whose core use needs broad video access.' },
  'android.permission.READ_EXTERNAL_STORAGE': { label: 'Files and media', type: 'photos-videos' },
  'android.permission.READ_MEDIA_AUDIO': { label: 'Audio files', type: 'audio' },
  'android.permission.RECORD_AUDIO': { label: 'Microphone', type: 'audio' },
  'android.permission.BODY_SENSORS': { label: 'Body sensors', type: 'health' },
  'android.permission.ACTIVITY_RECOGNITION': { label: 'Physical activity', type: 'health' },
  'android.permission.READ_CALENDAR': { label: 'Calendar' },
  'android.permission.READ_SMS': { label: 'SMS', note: 'Play only allows SMS permissions for a few app types and requires a declaration.' },
  'android.permission.READ_CALL_LOG': { label: 'Call log', note: 'Play only allows call log permissions for a few app types and requires a declaration.' },
  'android.permission.READ_PHONE_STATE': { label: 'Phone state' },
  'android.permission.READ_PHONE_NUMBERS': { label: 'Phone numbers', type: 'phone' },
  'android.permission.GET_ACCOUNTS': { label: 'Accounts on the device' },
  'android.permission.QUERY_ALL_PACKAGES': { label: 'Installed apps', note: 'Play restricts this permission and requires a declaration.' },
  'com.google.android.gms.permission.AD_ID': {
    label: 'Advertising ID',
    type: 'device-id',
    note: 'Answer Yes to the Advertising ID question in Play Console (App content > Advertising ID).',
  },
};

export const AD_ID = 'com.google.android.gms.permission.AD_ID';

/** Expo and app.json often use short names ("ACCESS_FINE_LOCATION"). */
export function normalizePermission(name: string): string {
  const n = name.trim();
  return n.includes('.') ? n : `android.permission.${n}`;
}

export interface ManifestPermissions {
  /** Permissions the manifest requests. */
  uses: string[];
  /** Permissions removed with tools:node="remove" (only meaningful in the app's own manifest). */
  removed: string[];
}

/** Read <uses-permission> entries from an AndroidManifest.xml. Returns null when the file does not exist. */
export function readAndroidManifest(file: string): ManifestPermissions | null {
  let xml: string;
  try {
    xml = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  xml = xml.replace(/<!--[\s\S]*?-->/g, '');
  const result: ManifestPermissions = { uses: [], removed: [] };
  for (const m of xml.matchAll(/<uses-permission(?:-sdk-23)?\b([^>]*)>/g)) {
    const attrs = m[1];
    const name = /android:name\s*=\s*"([^"]+)"/.exec(attrs)?.[1];
    if (!name || name.includes('${')) continue;
    const list = /tools:node\s*=\s*"remove"/.test(attrs) ? result.removed : result.uses;
    if (!list.includes(name)) list.push(name);
  }
  return result;
}

/** A library's own AndroidManifest.xml. */
export function libraryManifestPath(pkgDir: string): string {
  return path.join(pkgDir, 'android', 'src', 'main', 'AndroidManifest.xml');
}

/**
 * The merged manifest from the last Android build: it also contains permissions that Gradle
 * dependencies (Google Play services, ad SDKs...) add, which are not in node_modules.
 */
export function findMergedManifest(projectDir: string): string | null {
  const root = path.join(projectDir, 'android', 'app', 'build', 'intermediates');
  const found: { file: string; mtime: number }[] = [];
  const visit = (dir: string, depth: number) => {
    if (depth > 5) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) visit(full, depth + 1);
      else if (e.name === 'AndroidManifest.xml' && /merged_manifests?/.test(full) && !/androidTest|[\\/]test[\\/]/i.test(full)) {
        found.push({ file: full, mtime: fs.statSync(full).mtimeMs });
      }
    }
  };
  for (const dir of ['merged_manifest', 'merged_manifests']) visit(path.join(root, dir), 0);
  found.sort((a, b) => b.mtime - a.mtime || a.file.localeCompare(b.file));
  return found[0]?.file ?? null;
}

export interface AppAndroid {
  /** Requested in android/app/src/main/AndroidManifest.xml or expo.android.permissions. */
  declared: string[];
  /** Removed with tools:node="remove" or expo.android.blockedPermissions. */
  removed: string[];
  /** From the merged manifest of the last build, when there is one. */
  merged: string[] | null;
  mergedFile: string | null;
}

export function readAppAndroid(projectDir: string): AppAndroid {
  const result: AppAndroid = { declared: [], removed: [], merged: null, mergedFile: null };
  const own = readAndroidManifest(path.join(projectDir, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'));
  if (own) {
    result.declared.push(...own.uses);
    result.removed.push(...own.removed);
  }
  try {
    const json = JSON.parse(fs.readFileSync(path.join(projectDir, 'app.json'), 'utf8'));
    const android = (json.expo ?? json)?.android ?? {};
    for (const p of android.permissions ?? []) if (typeof p === 'string') result.declared.push(normalizePermission(p));
    for (const p of android.blockedPermissions ?? []) if (typeof p === 'string') result.removed.push(normalizePermission(p));
  } catch {
    // No app.json, or not JSON: nothing to add.
  }
  const mergedFile = findMergedManifest(projectDir);
  if (mergedFile) {
    result.merged = readAndroidManifest(mergedFile)?.uses ?? [];
    result.mergedFile = path.relative(projectDir, mergedFile);
  }
  result.declared = [...new Set(result.declared)];
  result.removed = [...new Set(result.removed)];
  return result;
}
