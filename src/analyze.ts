import { API_CATEGORIES, DEFAULT_REASONS } from './apis.js';
import type { ApiCategory, ApiUsage, CollectedData, DataType, Purpose, ScanResult } from './types.js';
import { SDK_ONLY_REASONS } from './validate.js';

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
  sources: { pkg: string; version: string; versions?: string; urls: string[]; notes?: string }[];
  /** Libraries whose own manifest declares tracking or tracking domains. */
  tracking: { pkg: string; declaresTracking: boolean; domains: string[] }[];
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

    if (pkg.rule && (pkg.rule.sources.length || pkg.rule.notes)) {
      sources.push({ pkg: pkg.name, version: pkg.version, versions: pkg.rule.versions, urls: pkg.rule.sources, notes: pkg.rule.notes });
    }

    if (pkg.hasBinaryFramework && !pkg.shipsManifest.length) {
      warnings.push({ pkg: pkg.name, message: 'Contains a prebuilt binary framework that cannot be scanned and no privacy manifest was found. Check the vendor documentation.' });
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
  for (const name of scan.missingPackages) {
    warnings.push({ pkg: name, message: 'Listed in package.json but not installed. Run your package manager install, then scan again.' });
  }

  return {
    apis,
    data,
    access: [...accessMap.entries()].map(([type, packages]) => ({ type, packages })),
    warnings,
    tracking,
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
