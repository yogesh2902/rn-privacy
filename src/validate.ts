import type { ApiCategory } from './types.js';

/**
 * Structural checks for an app's privacy manifest. A manifest that is present but malformed
 * (wrong value types, unknown keys, reasons that do not exist) is rejected by App Store Connect
 * with ITMS-91056 "Invalid privacy manifest".
 *
 * Lists from Apple's documentation:
 * https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacyaccessedapitypes/nsprivacyaccessedapitypereasons
 * https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacycollecteddatatypes/nsprivacycollecteddatatype
 */
export const VALID_REASONS: Record<ApiCategory, string[]> = {
  NSPrivacyAccessedAPICategoryFileTimestamp: ['DDA9.1', 'C617.1', '3B52.1', '0A2A.1'],
  NSPrivacyAccessedAPICategorySystemBootTime: ['35F9.1', '8FFB.1', '3D61.1'],
  NSPrivacyAccessedAPICategoryDiskSpace: ['85F4.1', 'E174.1', '7D9E.1', 'B728.1'],
  NSPrivacyAccessedAPICategoryActiveKeyboards: ['3EC4.1', '54BD.1'],
  NSPrivacyAccessedAPICategoryUserDefaults: ['CA92.1', '1C8F.1', 'C56D.1', 'AC6B.1'],
};

/**
 * Reasons Apple only allows inside a third-party SDK's own manifest (for SDKs
 * that wrap the API for the app). An app must never declare them itself.
 */
export const SDK_ONLY_REASONS = new Set(['C56D.1', '0A2A.1']);

export const VALID_DATA_TYPES = new Set(
  [
    'Name', 'EmailAddress', 'PhoneNumber', 'PhysicalAddress', 'OtherUserContactInfo',
    'Health', 'Fitness', 'PaymentInfo', 'CreditInfo', 'OtherFinancialInfo', 'PreciseLocation', 'CoarseLocation',
    'SensitiveInfo', 'Contacts', 'EmailsOrTextMessages', 'PhotosorVideos', 'AudioData', 'GameplayContent',
    'CustomerSupport', 'OtherUserContent', 'BrowsingHistory', 'SearchHistory', 'UserID', 'DeviceID',
    'PurchaseHistory', 'ProductInteraction', 'AdvertisingData', 'OtherUsageData', 'CrashData', 'PerformanceData',
    'OtherDiagnosticData', 'EnvironmentScanning', 'Hands', 'Head', 'OtherDataTypes',
  ].map((t) => `NSPrivacyCollectedDataType${t}`),
);

export const VALID_PURPOSES = new Set(
  ['ThirdPartyAdvertising', 'DeveloperAdvertising', 'Analytics', 'ProductPersonalization', 'AppFunctionality', 'Other'].map(
    (p) => `NSPrivacyCollectedDataTypePurpose${p}`,
  ),
);

const TOP_LEVEL_KEYS = new Set(['NSPrivacyTracking', 'NSPrivacyTrackingDomains', 'NSPrivacyCollectedDataTypes', 'NSPrivacyAccessedAPITypes']);

export interface ManifestProblem {
  level: 'error' | 'warning';
  message: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/**
 * Check a parsed privacy manifest. Errors are what App Store Connect rejects; warnings are likely mistakes.
 * Pass `{ sdk: true }` for a library's own manifest, where the SDK-only reasons are allowed.
 */
export function validateManifest(manifest: unknown, options: { sdk?: boolean } = {}): ManifestProblem[] {
  const problems: ManifestProblem[] = [];
  const error = (message: string) => problems.push({ level: 'error', message });
  const warn = (message: string) => problems.push({ level: 'warning', message });

  if (!isObject(manifest)) {
    error('The manifest is not a dictionary.');
    return problems;
  }

  for (const key of Object.keys(manifest)) {
    if (!TOP_LEVEL_KEYS.has(key)) warn(`Unknown key "${key}". Check the spelling: Apple ignores or rejects unknown keys.`);
  }

  // Tracking ---------------------------------------------------------------
  if ('NSPrivacyTracking' in manifest && typeof manifest.NSPrivacyTracking !== 'boolean') {
    error('NSPrivacyTracking must be a boolean (true or false).');
  }
  if ('NSPrivacyTrackingDomains' in manifest) {
    const domains = manifest.NSPrivacyTrackingDomains;
    if (!isStringArray(domains)) error('NSPrivacyTrackingDomains must be an array of strings.');
    else {
      for (const d of domains) {
        if (/^[a-z]+:\/\//i.test(d) || d.includes('/')) error(`Tracking domain "${d}" must be a domain name only, without https:// or a path.`);
      }
      if (domains.length && manifest.NSPrivacyTracking !== true) {
        warn('NSPrivacyTrackingDomains is set but NSPrivacyTracking is not true. These domains are only used when tracking is declared.');
      }
    }
  }

  // Required reason APIs ----------------------------------------------------
  if ('NSPrivacyAccessedAPITypes' in manifest) {
    const entries = manifest.NSPrivacyAccessedAPITypes;
    if (!Array.isArray(entries)) error('NSPrivacyAccessedAPITypes must be an array.');
    else {
      const seen = new Set<string>();
      entries.forEach((entry, i) => {
        const where = `NSPrivacyAccessedAPITypes item ${i + 1}`;
        if (!isObject(entry)) return void error(`${where} must be a dictionary.`);
        const category = entry.NSPrivacyAccessedAPIType;
        if (typeof category !== 'string') return void error(`${where} is missing NSPrivacyAccessedAPIType.`);
        const valid = VALID_REASONS[category as ApiCategory];
        if (!valid) return void error(`${where}: "${category}" is not a required reason API category.`);
        if (seen.has(category)) warn(`${category} is listed more than once. Merge the reasons into one entry.`);
        seen.add(category);

        const reasons = entry.NSPrivacyAccessedAPITypeReasons;
        if (!isStringArray(reasons)) return void error(`${category}: NSPrivacyAccessedAPITypeReasons must be an array of strings.`);
        if (!reasons.length) error(`${category}: give at least one reason.`);
        for (const r of reasons) {
          if (SDK_ONLY_REASONS.has(r) && options.sdk) continue;
          if (SDK_ONLY_REASONS.has(r)) error(`${category}: ${r} is only allowed in third-party SDKs, not in an app. Use ${valid.filter((x) => !SDK_ONLY_REASONS.has(x)).join(', ')} instead.`);
          else if (!valid.includes(r)) error(`${category}: "${r}" is not a valid reason for this category. Valid: ${valid.filter((x) => !SDK_ONLY_REASONS.has(x)).join(', ')}.`);
        }
      });
    }
  }

  // Collected data ----------------------------------------------------------
  if ('NSPrivacyCollectedDataTypes' in manifest) {
    const entries = manifest.NSPrivacyCollectedDataTypes;
    if (!Array.isArray(entries)) error('NSPrivacyCollectedDataTypes must be an array.');
    else {
      const seen = new Set<string>();
      entries.forEach((entry, i) => {
        const where = `NSPrivacyCollectedDataTypes item ${i + 1}`;
        if (!isObject(entry)) return void error(`${where} must be a dictionary.`);
        const type = entry.NSPrivacyCollectedDataType;
        if (typeof type !== 'string') return void error(`${where} is missing NSPrivacyCollectedDataType.`);
        if (!VALID_DATA_TYPES.has(type)) error(`${where}: "${type}" is not a valid collected data type.`);
        if (seen.has(type)) warn(`${type} is listed more than once. Merge the purposes into one entry.`);
        seen.add(type);

        for (const key of ['NSPrivacyCollectedDataTypeLinked', 'NSPrivacyCollectedDataTypeTracking'] as const) {
          if (typeof entry[key] !== 'boolean') error(`${type}: ${key} must be a boolean (true or false).`);
        }
        const purposes = entry.NSPrivacyCollectedDataTypePurposes;
        if (!isStringArray(purposes)) error(`${type}: NSPrivacyCollectedDataTypePurposes must be an array of strings.`);
        else {
          if (!purposes.length) error(`${type}: give at least one purpose.`);
          for (const p of purposes) if (!VALID_PURPOSES.has(p)) error(`${type}: "${p}" is not a valid purpose.`);
        }
        if (entry.NSPrivacyCollectedDataTypeTracking === true && manifest.NSPrivacyTracking !== true) {
          warn(`${type} is marked as used for tracking, but NSPrivacyTracking is not true.`);
        }
      });
    }
  }

  return problems;
}
