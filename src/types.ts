/**
 * Canonical data types. Each one maps to an Apple privacy manifest key and a
 * Google Play Data safety category/type, so a single rule feeds both stores.
 */
export type DataType =
  | 'device-id'
  | 'user-id'
  | 'email'
  | 'name'
  | 'phone'
  | 'crash-data'
  | 'performance-data'
  | 'other-diagnostic'
  | 'product-interaction'
  | 'advertising-data'
  | 'other-usage'
  | 'coarse-location'
  | 'precise-location'
  | 'purchase-history'
  | 'contacts'
  | 'photos-videos'
  | 'audio'
  | 'health';

export type Purpose =
  | 'app-functionality'
  | 'analytics'
  | 'third-party-advertising'
  | 'developer-advertising'
  | 'product-personalization'
  | 'other';

export interface DataTypeInfo {
  label: string;
  apple: string;
  play: { category: string; type: string };
}

export const DATA_TYPES: Record<DataType, DataTypeInfo> = {
  'device-id': { label: 'Device ID', apple: 'NSPrivacyCollectedDataTypeDeviceID', play: { category: 'Device or other IDs', type: 'Device or other IDs' } },
  'user-id': { label: 'User ID', apple: 'NSPrivacyCollectedDataTypeUserID', play: { category: 'Personal info', type: 'User IDs' } },
  email: { label: 'Email address', apple: 'NSPrivacyCollectedDataTypeEmailAddress', play: { category: 'Personal info', type: 'Email address' } },
  name: { label: 'Name', apple: 'NSPrivacyCollectedDataTypeName', play: { category: 'Personal info', type: 'Name' } },
  phone: { label: 'Phone number', apple: 'NSPrivacyCollectedDataTypePhoneNumber', play: { category: 'Personal info', type: 'Phone number' } },
  'crash-data': { label: 'Crash data', apple: 'NSPrivacyCollectedDataTypeCrashData', play: { category: 'App info and performance', type: 'Crash logs' } },
  'performance-data': { label: 'Performance data', apple: 'NSPrivacyCollectedDataTypePerformanceData', play: { category: 'App info and performance', type: 'Diagnostics' } },
  'other-diagnostic': { label: 'Other diagnostic data', apple: 'NSPrivacyCollectedDataTypeOtherDiagnosticData', play: { category: 'App info and performance', type: 'Other app performance data' } },
  'product-interaction': { label: 'Product interaction', apple: 'NSPrivacyCollectedDataTypeProductInteraction', play: { category: 'App activity', type: 'App interactions' } },
  'advertising-data': { label: 'Advertising data', apple: 'NSPrivacyCollectedDataTypeAdvertisingData', play: { category: 'App activity', type: 'Other actions' } },
  'other-usage': { label: 'Other usage data', apple: 'NSPrivacyCollectedDataTypeOtherUsageData', play: { category: 'App activity', type: 'Other actions' } },
  'coarse-location': { label: 'Coarse location', apple: 'NSPrivacyCollectedDataTypeCoarseLocation', play: { category: 'Location', type: 'Approximate location' } },
  'precise-location': { label: 'Precise location', apple: 'NSPrivacyCollectedDataTypePreciseLocation', play: { category: 'Location', type: 'Precise location' } },
  'purchase-history': { label: 'Purchase history', apple: 'NSPrivacyCollectedDataTypePurchaseHistory', play: { category: 'Financial info', type: 'Purchase history' } },
  contacts: { label: 'Contacts', apple: 'NSPrivacyCollectedDataTypeContacts', play: { category: 'Contacts', type: 'Contacts' } },
  'photos-videos': { label: 'Photos or videos', apple: 'NSPrivacyCollectedDataTypePhotosorVideos', play: { category: 'Photos and videos', type: 'Photos' } },
  audio: { label: 'Audio data', apple: 'NSPrivacyCollectedDataTypeAudioData', play: { category: 'Audio', type: 'Voice or sound recordings' } },
  health: { label: 'Health', apple: 'NSPrivacyCollectedDataTypeHealth', play: { category: 'Health and fitness', type: 'Health info' } },
};

export const PURPOSES: Record<Purpose, { label: string; apple: string; play: string }> = {
  'app-functionality': { label: 'App functionality', apple: 'NSPrivacyCollectedDataTypePurposeAppFunctionality', play: 'App functionality' },
  analytics: { label: 'Analytics', apple: 'NSPrivacyCollectedDataTypePurposeAnalytics', play: 'Analytics' },
  'third-party-advertising': { label: 'Third-party advertising', apple: 'NSPrivacyCollectedDataTypePurposeThirdPartyAdvertising', play: 'Advertising or marketing' },
  'developer-advertising': { label: "Developer's advertising or marketing", apple: 'NSPrivacyCollectedDataTypePurposeDeveloperAdvertising', play: 'Advertising or marketing' },
  'product-personalization': { label: 'Product personalization', apple: 'NSPrivacyCollectedDataTypePurposeProductPersonalization', play: 'Personalization' },
  other: { label: 'Other purposes', apple: 'NSPrivacyCollectedDataTypePurposeOther', play: 'App functionality' },
};

export interface CollectedData {
  type: DataType;
  purposes: Purpose[];
  /** Apple: is the data linked to the user's identity? */
  linked: boolean;
  /** Apple: is the data used for tracking (as defined by App Tracking Transparency)? */
  tracking: boolean;
  /** Only collected when the app enables a feature or passes the data in (e.g. identify(user)). */
  conditional?: string;
}

/** Data the library lets the app read on the device. Only declare it if the app sends it off the device. */
export interface DeviceAccess {
  type: DataType;
  note?: string;
}

export interface LibraryRule {
  /** npm package names this rule covers. */
  packages: string[];
  name: string;
  /**
   * Package versions this rule is for, as a semver range (e.g. ">=6.0.0", "^5.2.0 || ^6.0.0").
   * Leave it out when the rule is the same for every version. When several rules cover a package,
   * the first one whose range matches the installed version wins; a rule without a range is the fallback.
   */
  versions?: string;
  collects?: CollectedData[];
  accesses?: DeviceAccess[];
  /** Vendor pages the rule is based on. Always check these before submitting. */
  sources: string[];
  notes?: string;
}

/** Apple "required reason" API categories. */
export type ApiCategory =
  | 'NSPrivacyAccessedAPICategoryUserDefaults'
  | 'NSPrivacyAccessedAPICategoryFileTimestamp'
  | 'NSPrivacyAccessedAPICategorySystemBootTime'
  | 'NSPrivacyAccessedAPICategoryDiskSpace'
  | 'NSPrivacyAccessedAPICategoryActiveKeyboards';

export interface ApiUsage {
  category: ApiCategory;
  reasons: string[];
}

export type ApiEvidence =
  | { kind: 'manifest'; file: string }
  | { kind: 'source'; file: string; symbol: string };

export interface PackageReport {
  name: string;
  version: string;
  hasIosNative: boolean;
  shipsManifest: string[];
  hasBinaryFramework: boolean;
  apis: Map<ApiCategory, { reasons: Set<string>; evidence: ApiEvidence[] }>;
  manifestCollected: CollectedData[];
  rule?: LibraryRule;
  /** Problems in the privacy manifests the package ships, validated as an SDK manifest. */
  manifestIssues: ManifestIssue[];
  /** The package's own manifest sets NSPrivacyTracking to true. */
  declaresTracking: boolean;
  /** NSPrivacyTrackingDomains from the package's own manifests. */
  trackingDomains: string[];
  /** Where to report problems: the package's issue tracker, if it has one. */
  issuesUrl?: string;
  /** <uses-permission> entries in the package's android/src/main/AndroidManifest.xml. */
  androidPermissions: string[];
}

export interface ManifestIssue {
  /** Manifest file, relative to the package folder. */
  file: string;
  level: 'error' | 'warning';
  message: string;
}

export interface ScanResult {
  projectDir: string;
  projectType: 'bare' | 'expo-managed' | 'expo-prebuild' | 'unknown';
  packages: PackageReport[];
  missingPackages: string[];
  /** The app's own Android permissions (manifest, app.json, merged manifest of the last build). */
  android: import('./android.js').AppAndroid;
}
