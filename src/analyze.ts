import { API_CATEGORIES, DEFAULT_REASONS } from './apis.js';
import type { ApiCategory, ApiUsage, CollectedData, DataType, PackageReport, PlayCollected, PlayPurpose, Purpose, ScanResult } from './types.js';
import { APPLE_TO_PLAY_PURPOSE } from './types.js';
import { SDK_ONLY_REASONS } from './validate.js';
import { SENSITIVE_PERMISSIONS } from './android.js';
import { PURPOSE_KEY_NAMES } from './purpose.js';

export interface ApiFinding {
  category: ApiCategory;
  reasons: string[];
  /** true when no library gave a reason and we fell back to the default one. */
  defaultReason: boolean;
  packages: string[];
}

export interface DataFinding {
  type: DataType;
  purposes: Purpose[];
  linked: boolean;
  tracking: boolean;
  /** Packages that always collect it. */
  packages: string[];
  /** Packages that collect it only in some setups, with the condition. */
  conditional: { pkg: string; condition: string; item: CollectedData }[];
}

export interface Warning {
  pkg?: string;
  message: string;
}

export interface Analysis {
  apis: ApiFinding[];
  data: DataFinding[];
  access: { type: DataType; packages: string[] }[];
  warnings: Warning[];
  sources: { pkg: string; version: string; versions?: string; urls: string[]; notes?: string; /** Config file, for the project's own rules. */ origin?: string }[];
  /** Libraries whose own manifest declares tracking or tracking domains. */
  tracking: { pkg: string; declaresTracking: boolean; domains: string[] }[];
  /** Sensitive Android permissions and who adds them. Permissions the app removes are left out. */
  android: AndroidFinding[];
  /** Data collected, in Google Play's terms (from vendors' Play disclosures where they exist). */
  play: PlayFinding[];
  /** Info.plist purpose strings the app needs, because its code or a library asks for that access. */
  purposes: { key: string; packages: string[] }[];
}

export interface PlayFinding {
  type: DataType;
  purposes: PlayPurpose[];
  /** At least one SDK says this data is shared. */
  shared: boolean;
  /** Purposes of the SDKs that share it. */
  sharedPurposes: PlayPurpose[];
  /** Packages that always collect it. */
  packages: string[];
  /** Packages that collect it only in some setups. */
  conditional: { pkg: string; condition: string; item: PlayCollected }[];
  /** Packages whose vendor publishes no Play disclosure: their answer comes from the iOS disclosure. */
  derived: string[];
}

/** What a package collects on Android, and whether that comes from a Play disclosure. */
function playItems(pkg: PackageReport): { items: PlayCollected[]; derived: boolean } {
  if (pkg.rule?.android) return { items: pkg.rule.android.collects, derived: false };
  // Pods and Swift packages are not in the Android app.
  if (pkg.iosOnly) return { items: [], derived: false };
  const ios = pkg.rule ? pkg.rule.collects ?? [] : pkg.manifestCollected;
  return {
    items: ios.map((c) => ({ type: c.type, purposes: [...new Set(c.purposes.map((p) => APPLE_TO_PLAY_PURPOSE[p]))], conditional: c.conditional })),
    derived: true,
  };
}

function playFindings(scan: ScanResult): PlayFinding[] {
  const map = new Map<DataType, PlayFinding>();
  for (const pkg of scan.packages) {
    const { items, derived } = playItems(pkg);
    for (const item of items) {
      let f = map.get(item.type);
      if (!f) map.set(item.type, (f = { type: item.type, purposes: [], shared: false, sharedPurposes: [], packages: [], conditional: [], derived: [] }));
      if (derived && !f.derived.includes(pkg.name)) f.derived.push(pkg.name);
      if (item.conditional) {
        f.conditional.push({ pkg: pkg.name, condition: item.conditional, item });
        continue;
      }
      for (const p of item.purposes) if (!f.purposes.includes(p)) f.purposes.push(p);
      if (item.shared) {
        f.shared = true;
        for (const p of item.purposes) if (!f.sharedPurposes.includes(p)) f.sharedPurposes.push(p);
      }
      if (!f.packages.includes(pkg.name)) f.packages.push(pkg.name);
    }
  }
  return [...map.values()];
}

/** Play answers for `play` and the report: always-collected data, plus conditional data when asked. */
export function toPlayCollected(a: Analysis, includeConditional: boolean): PlayCollected[] {
  const out: PlayCollected[] = [];
  for (const f of a.play) {
    const items: PlayCollected[] = [];
    if (f.packages.length) items.push({ type: f.type, purposes: f.purposes, shared: f.shared, sharedPurposes: f.sharedPurposes });
    if (includeConditional) items.push(...f.conditional.map((c) => ({ ...c.item, sharedPurposes: c.item.shared ? c.item.purposes : [] })));
    if (!items.length) continue;
    out.push({
      type: f.type,
      purposes: [...new Set(items.flatMap((i) => i.purposes))],
      shared: items.some((i) => i.shared),
      sharedPurposes: [...new Set(items.flatMap((i) => i.sharedPurposes ?? []))],
    });
  }
  return out;
}

export interface AndroidFinding {
  permission: string;
  label: string;
  type?: DataType;
  note?: string;
  /** Libraries, "your app", or "a Gradle dependency" (only seen in the merged manifest). */
  sources: string[];
}

export const APP_SOURCE = 'your app';
export const GRADLE_SOURCE = 'a Gradle dependency';

function androidFindings(scan: ScanResult): AndroidFinding[] {
  const removed = new Set(scan.android.removed);
  const map = new Map<string, Set<string>>();
  const add = (perm: string, source: string) => {
    if (!SENSITIVE_PERMISSIONS[perm] || removed.has(perm)) return;
    if (!map.has(perm)) map.set(perm, new Set());
    map.get(perm)!.add(source);
  };
  for (const pkg of scan.packages) for (const perm of pkg.androidPermissions) add(perm, pkg.name);
  for (const perm of scan.android.declared) add(perm, APP_SOURCE);
  // The merged manifest of the last build also has what Gradle dependencies add. It can be older than
  // node_modules, so it only adds to the list; it never removes anything.
  for (const perm of scan.android.merged ?? []) if (!map.has(perm)) add(perm, GRADLE_SOURCE);
  return [...map].map(([permission, sources]) => ({ permission, ...SENSITIVE_PERMISSIONS[permission], sources: [...sources] }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Every tracking domain your libraries declare, without duplicates. */
export function trackingDomains(a: Analysis): string[] {
  return [...new Set(a.tracking.flatMap((t) => t.domains))].sort();
}

export { SDK_ONLY_REASONS };

function mergeData(map: Map<DataType, DataFinding>, pkg: string, item: CollectedData, conditional: boolean) {
  let f = map.get(item.type);
  if (!f) map.set(item.type, (f = { type: item.type, purposes: [], linked: false, tracking: false, packages: [], conditional: [] }));
  if (conditional) {
    f.conditional.push({ pkg, condition: item.conditional ?? 'Depends on configuration', item });
    return;
  }
  for (const p of item.purposes) if (!f.purposes.includes(p)) f.purposes.push(p);
  f.linked ||= item.linked;
  f.tracking ||= item.tracking;
  if (!f.packages.includes(pkg)) f.packages.push(pkg);
}

export function analyze(scan: ScanResult): Analysis {
  const apiMap = new Map<ApiCategory, { reasons: Set<string>; packages: Set<string> }>();
  const dataMap = new Map<DataType, DataFinding>();
  const accessMap = new Map<DataType, string[]>();
  const warnings: Warning[] = [];
  const sources: Analysis['sources'] = [];
  const tracking: Analysis['tracking'] = [];

  for (const pkg of scan.packages) {
    // Apple does not reliably read manifests from statically linked pods (see
    // https://docs.expo.dev/guides/apple-privacy/), so every library's reasons,
    // CocoaPods SDKs included, go into the app manifest. An extra reason never
    // causes a rejection; a missing one does (ITMS-91053).
    for (const [category, usage] of pkg.apis) {
      let a = apiMap.get(category);
      if (!a) apiMap.set(category, (a = { reasons: new Set(), packages: new Set() }));
      for (const r of usage.reasons) if (!SDK_ONLY_REASONS.has(r)) a.reasons.add(r);
      a.packages.add(pkg.name);
    }

    // Prefer the curated rule; fall back to what the library's own manifest says.
    const ruleData = pkg.rule?.collects ?? [];
    for (const item of ruleData) mergeData(dataMap, pkg.name, item, !!item.conditional);
    // Libraries with a device-access rule (camera, location...) only collect if the app uploads the data.
    if (!pkg.rule) for (const item of pkg.manifestCollected) mergeData(dataMap, pkg.name, item, false);

    for (const acc of pkg.rule?.accesses ?? []) {
      const list = accessMap.get(acc.type) ?? [];
      if (!list.includes(pkg.name)) list.push(pkg.name);
      accessMap.set(acc.type, list);
    }

    if (pkg.declaresTracking || pkg.trackingDomains.length) {
      tracking.push({ pkg: pkg.name, declaresTracking: pkg.declaresTracking, domains: pkg.trackingDomains });
    }

    if (pkg.rule && (pkg.rule.sources.length || pkg.rule.notes || pkg.rule.android || pkg.rule.origin)) {
      const notes = [pkg.rule.notes, pkg.rule.android?.notes && `Android: ${pkg.rule.android.notes}`].filter(Boolean).join(' ');
      sources.push({ pkg: pkg.name, version: pkg.version, versions: pkg.rule.versions, urls: [...pkg.rule.sources, ...(pkg.rule.android?.sources ?? [])], notes: notes || undefined, origin: pkg.rule.origin });
    }

    if (pkg.unscannedBinaries.length && !pkg.shipsManifest.length) {
      warnings.push({ pkg: pkg.name, message: `Contains a prebuilt binary too large to scan (${pkg.unscannedBinaries[0]}) and no privacy manifest. Check the vendor documentation.` });
    }
  }

  const apis: ApiFinding[] = [];
  for (const category of API_CATEGORIES) {
    const a = apiMap.get(category);
    if (!a) continue;
    const defaultReason = a.reasons.size === 0;
    apis.push({
      category,
      reasons: defaultReason ? [DEFAULT_REASONS[category].code] : [...a.reasons].sort(),
      defaultReason,
      packages: [...a.packages].sort(),
    });
  }

  const data = [...dataMap.values()];
  if (data.some((d) => d.tracking)) {
    warnings.push({
      message:
        'Some libraries collect data used for tracking. On iOS you must ask for App Tracking Transparency permission, set NSPrivacyTracking to true and list the tracking domains in NSPrivacyTrackingDomains. rn-privacy never turns this on for you.',
    });
  }
  if (scan.swiftPackagesNotDownloaded.length) {
    const names = scan.swiftPackagesNotDownloaded;
    warnings.push({
      message: `${names.length} Swift package${names.length === 1 ? ' is' : 's are'} listed in Package.resolved but not downloaded, so ${names.length === 1 ? 'it was' : 'they were'} not scanned (${names.slice(0, 5).join(', ')}${names.length > 5 ? ', ...' : ''}). Build the app in Xcode once, or run \`xcodebuild -resolvePackageDependencies -workspace ios/<App>.xcworkspace -scheme <App> -clonedSourcePackagesDirPath ios/SourcePackages\`, then scan again.`,
    });
  }
  for (const name of scan.unusedRules) {
    warnings.push({ pkg: name, message: `Your rule in rn-privacy.config.json matches no installed package. Check the names in "packages".` });
  }
  if (scan.yarnPnp) {
    warnings.push({ message: 'This project uses Yarn Plug\'n\'Play, which React Native does not support, so there is no node_modules to scan. Add `nodeLinker: node-modules` to .yarnrc.yml, run `yarn install`, then scan again.' });
  } else {
    for (const name of scan.missingPackages) {
      warnings.push({ pkg: name, message: 'Listed in package.json but not installed. Run your package manager install, then scan again.' });
    }
  }

  const purposeMap = new Map<string, string[]>();
  for (const pkg of scan.packages) {
    for (const key of pkg.purposeUses?.keys() ?? []) purposeMap.set(key, [...(purposeMap.get(key) ?? []), pkg.name]);
  }
  const purposes = PURPOSE_KEY_NAMES.filter((k) => purposeMap.has(k)).map((key) => ({ key, packages: purposeMap.get(key)! }));

  return {
    apis,
    purposes,
    data,
    access: [...accessMap.entries()].map(([type, packages]) => ({ type, packages })),
    warnings,
    tracking,
    android: androidFindings(scan),
    play: playFindings(scan),
    sources,
  };
}

export function toApiUsages(a: Analysis): ApiUsage[] {
  return a.apis.map((f) => ({ category: f.category, reasons: f.reasons }));
}

export function toCollected(a: Analysis, includeConditional: boolean): CollectedData[] {
  const out: CollectedData[] = [];
  for (const d of a.data) {
    const items: CollectedData[] = [];
    if (d.packages.length) items.push({ type: d.type, purposes: d.purposes, linked: d.linked, tracking: d.tracking });
    if (includeConditional) items.push(...d.conditional.map((c) => c.item));
    if (!items.length) continue;
    out.push({
      type: d.type,
      purposes: [...new Set(items.flatMap((i) => i.purposes))],
      linked: items.some((i) => i.linked),
      tracking: items.some((i) => i.tracking),
    });
  }
  return out;
}
