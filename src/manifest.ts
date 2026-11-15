import fs from 'node:fs';
import plist from 'plist';
import { isApiCategory } from './apis.js';
import { DATA_TYPES, PURPOSES } from './types.js';
import type { ApiUsage, CollectedData, DataType, Purpose } from './types.js';

export interface PrivacyManifest {
  NSPrivacyTracking?: boolean;
  NSPrivacyTrackingDomains?: string[];
  NSPrivacyCollectedDataTypes?: AppleCollectedEntry[];
  NSPrivacyAccessedAPITypes?: AppleApiEntry[];
  [key: string]: unknown;
}

export interface AppleCollectedEntry {
  NSPrivacyCollectedDataType: string;
  NSPrivacyCollectedDataTypeLinked: boolean;
  NSPrivacyCollectedDataTypeTracking: boolean;
  NSPrivacyCollectedDataTypePurposes: string[];
}

export interface AppleApiEntry {
  NSPrivacyAccessedAPIType: string;
  NSPrivacyAccessedAPITypeReasons: string[];
}

const appleToType = new Map<string, DataType>(
  (Object.entries(DATA_TYPES) as [DataType, { apple: string }][]).map(([k, v]) => [v.apple, k]),
);
const appleToPurpose = new Map<string, Purpose>(
  (Object.entries(PURPOSES) as [Purpose, { apple: string }][]).map(([k, v]) => [v.apple, k]),
);

export function readManifest(file: string): PrivacyManifest | null {
  try {
    const parsed = plist.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as PrivacyManifest) : {};
  } catch {
    return null;
  }
}

export function manifestApis(m: PrivacyManifest): ApiUsage[] {
  const out: ApiUsage[] = [];
  for (const entry of m.NSPrivacyAccessedAPITypes ?? []) {
    if (entry && isApiCategory(entry.NSPrivacyAccessedAPIType)) {
      out.push({ category: entry.NSPrivacyAccessedAPIType, reasons: (entry.NSPrivacyAccessedAPITypeReasons ?? []).filter((r) => typeof r === 'string') });
    }
  }
  return out;
}

export function manifestCollected(m: PrivacyManifest): CollectedData[] {
  const out: CollectedData[] = [];
  for (const entry of m.NSPrivacyCollectedDataTypes ?? []) {
    const type = entry && appleToType.get(entry.NSPrivacyCollectedDataType);
    if (!type) continue;
    out.push({
      type,
      linked: !!entry.NSPrivacyCollectedDataTypeLinked,
      tracking: !!entry.NSPrivacyCollectedDataTypeTracking,
      purposes: (entry.NSPrivacyCollectedDataTypePurposes ?? []).map((p) => appleToPurpose.get(p) ?? 'other'),
    });
  }
  return out;
}

/**
 * Merge new API usages and collected data into an existing manifest.
 * Nothing already in the manifest is removed: we only add.
 */
export function mergeManifest(
  existing: PrivacyManifest,
  apis: ApiUsage[],
  collected: CollectedData[],
): { manifest: PrivacyManifest; added: string[] } {
  const manifest: PrivacyManifest = structuredClone(existing);
  const added: string[] = [];

  manifest.NSPrivacyAccessedAPITypes ??= [];
  for (const usage of apis) {
    let entry = manifest.NSPrivacyAccessedAPITypes.find((e) => e.NSPrivacyAccessedAPIType === usage.category);
    if (!entry) {
      entry = { NSPrivacyAccessedAPIType: usage.category, NSPrivacyAccessedAPITypeReasons: [] };
      manifest.NSPrivacyAccessedAPITypes.push(entry);
    }
    entry.NSPrivacyAccessedAPITypeReasons ??= [];
    for (const reason of usage.reasons) {
      if (!entry.NSPrivacyAccessedAPITypeReasons.includes(reason)) {
        entry.NSPrivacyAccessedAPITypeReasons.push(reason);
        added.push(`${usage.category} → ${reason}`);
      }
    }
  }

  manifest.NSPrivacyCollectedDataTypes ??= [];
  for (const item of collected) {
    const appleType = DATA_TYPES[item.type].apple;
    let entry = manifest.NSPrivacyCollectedDataTypes.find((e) => e.NSPrivacyCollectedDataType === appleType);
    if (!entry) {
      entry = {
        NSPrivacyCollectedDataType: appleType,
        NSPrivacyCollectedDataTypeLinked: false,
        NSPrivacyCollectedDataTypeTracking: false,
        NSPrivacyCollectedDataTypePurposes: [],
      };
      manifest.NSPrivacyCollectedDataTypes.push(entry);
      added.push(`collected: ${appleType}`);
    }
    if (item.linked && !entry.NSPrivacyCollectedDataTypeLinked) {
      entry.NSPrivacyCollectedDataTypeLinked = true;
      added.push(`${appleType} → linked`);
    }
    if (item.tracking && !entry.NSPrivacyCollectedDataTypeTracking) {
      entry.NSPrivacyCollectedDataTypeTracking = true;
      added.push(`${appleType} → tracking`);
    }
    entry.NSPrivacyCollectedDataTypePurposes ??= [];
    for (const p of item.purposes) {
      const applePurpose = PURPOSES[p].apple;
      if (!entry.NSPrivacyCollectedDataTypePurposes.includes(applePurpose)) {
        entry.NSPrivacyCollectedDataTypePurposes.push(applePurpose);
        added.push(`${appleType} → ${applePurpose}`);
      }
    }
  }

  // NSPrivacyTracking is deliberately never switched on automatically: it has
  // App Tracking Transparency consequences, so we only warn about it.
  manifest.NSPrivacyTracking ??= false;
  manifest.NSPrivacyTrackingDomains ??= [];
  return { manifest, added };
}

export function emptyManifest(): PrivacyManifest {
  return { NSPrivacyAccessedAPITypes: [], NSPrivacyCollectedDataTypes: [], NSPrivacyTracking: false, NSPrivacyTrackingDomains: [] };
}

export function buildManifest(m: PrivacyManifest): string {
  return plist.build(m as plist.PlistValue, { indent: '\t', pretty: true }) + '\n';
}
