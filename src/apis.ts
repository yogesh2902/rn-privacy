import type { ApiCategory } from './types.js';

/**
 * Apple's "required reason" APIs and the symbols that indicate their use.
 * https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api
 */
export const API_SYMBOLS: Record<ApiCategory, RegExp[]> = {
  NSPrivacyAccessedAPICategoryUserDefaults: [/\bNSUserDefaults\b/, /\bUserDefaults\b/, /@AppStorage\b/],
  NSPrivacyAccessedAPICategoryFileTimestamp: [
    /\bNSFile(Creation|Modification)Date\b/,
    /\bNSURL(Creation|ContentModification)DateKey\b/,
    /\b(creationDateKey|contentModificationDateKey)\b/,
    /\bFileAttributeKey\.(creationDate|modificationDate)\b/,
    /\bfileModificationDate\b/,
    /\b(getattrlist|getattrlistbulk|fgetattrlist|getattrlistat)\s*\(/,
    /\b(stat|fstat|lstat|fstatat)\s*\(/,
  ],
  NSPrivacyAccessedAPICategorySystemBootTime: [/\bsystemUptime\b/, /\bmach_absolute_time\s*\(/],
  NSPrivacyAccessedAPICategoryDiskSpace: [
    /\b(NSURL)?[vV]olume(AvailableCapacity|AvailableCapacityForImportantUsage|AvailableCapacityForOpportunisticUsage|TotalCapacity)Key\b/,
    /\bNSFileSystem(Free)?Size\b/,
    /\bsystem(Free)?Size\b/,
    /\b(statfs|statvfs|fstatfs|fstatvfs)\s*\(/,
  ],
  NSPrivacyAccessedAPICategoryActiveKeyboards: [/\bactiveInputModes\b/],
};

/**
 * Reason used when the scanner finds an API in a library's source code and the
 * library gives no reason itself. These are the reasons most React Native apps
 * use (React Native's own template uses CA92.1, C617.1 and 35F9.1). Review them:
 * the right reason depends on what your app actually does with the API.
 */
export const DEFAULT_REASONS: Record<ApiCategory, { code: string; meaning: string }> = {
  NSPrivacyAccessedAPICategoryUserDefaults: { code: 'CA92.1', meaning: 'Read/write data only accessible to the app itself' },
  NSPrivacyAccessedAPICategoryFileTimestamp: { code: 'C617.1', meaning: 'Access timestamps of files inside the app container' },
  NSPrivacyAccessedAPICategorySystemBootTime: { code: '35F9.1', meaning: 'Measure time elapsed between events in the app' },
  NSPrivacyAccessedAPICategoryDiskSpace: { code: 'E174.1', meaning: 'Check there is enough space before writing files' },
  NSPrivacyAccessedAPICategoryActiveKeyboards: { code: '54BD.1', meaning: 'Customize the UI based on the active keyboard' },
};

export const API_LABELS: Record<ApiCategory, string> = {
  NSPrivacyAccessedAPICategoryUserDefaults: 'User defaults',
  NSPrivacyAccessedAPICategoryFileTimestamp: 'File timestamps',
  NSPrivacyAccessedAPICategorySystemBootTime: 'System boot time',
  NSPrivacyAccessedAPICategoryDiskSpace: 'Disk space',
  NSPrivacyAccessedAPICategoryActiveKeyboards: 'Active keyboards',
};

export const API_CATEGORIES = Object.keys(API_SYMBOLS) as ApiCategory[];

export function isApiCategory(value: unknown): value is ApiCategory {
  return typeof value === 'string' && value in API_SYMBOLS;
}

/** Remove comments so commented-out code is not reported. */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:"'])\/\/.*$/gm, '$1');
}

export function findApiSymbols(source: string): { category: ApiCategory; symbol: string }[] {
  const code = stripComments(source);
  const found: { category: ApiCategory; symbol: string }[] = [];
  for (const category of API_CATEGORIES) {
    for (const re of API_SYMBOLS[category]) {
      const m = re.exec(code);
      if (m) {
        found.push({ category, symbol: m[0].replace(/\s*\($/, '') });
        break;
      }
    }
  }
  return found;
}
