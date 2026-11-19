import { API_LABELS } from './apis.js';
import type { ApiCategory, ManifestIssue, PackageReport, ScanResult } from './types.js';

/**
 * Audit of the privacy manifests your libraries ship.
 *
 * rn-privacy already declares everything your libraries use in your app's own manifest, so these
 * findings do not break your upload. They are problems in the libraries themselves, worth
 * reporting to their maintainers so every app using them benefits.
 */
export interface LibraryRef {
  pkg: string;
  version: string;
  issuesUrl?: string;
}

export interface Audit {
  /** Packages with iOS native code (CocoaPods SDKs included). */
  nativePackages: number;
  /** Of those, how many ship a privacy manifest. */
  withManifest: number;
  /** Manifests Apple would reject or cannot read. */
  invalid: (LibraryRef & { issues: ManifestIssue[] })[];
  /** Likely mistakes in a manifest that is otherwise valid. */
  questionable: (LibraryRef & { issues: ManifestIssue[] })[];
  /** Uses required reason APIs in its code but ships no manifest at all. */
  undeclared: (LibraryRef & { categories: ApiCategory[]; evidence: string[] })[];
  /** Ships a manifest, but the code uses API categories it does not declare. */
  incomplete: (LibraryRef & { missing: ApiCategory[]; evidence: string[] })[];
  /** Declares tracking or tracking domains. */
  tracking: (LibraryRef & { declaresTracking: boolean; domains: string[] })[];
}

const ref = (p: PackageReport): LibraryRef => ({ pkg: p.name, version: p.version, issuesUrl: p.issuesUrl });

/** "ios/Foo.m (stat)" for the first few places a category was found in source code. */
function sourceEvidence(p: PackageReport, category: ApiCategory): string[] {
  return (p.apis.get(category)?.evidence ?? []).flatMap((e) => (e.kind === 'source' ? [`${e.file} (${e.symbol})`] : []));
}

export function audit(scan: ScanResult): Audit {
  const native = scan.packages.filter((p) => p.hasIosNative);
  const result: Audit = {
    nativePackages: native.length,
    withManifest: native.filter((p) => p.shipsManifest.length).length,
    invalid: [],
    questionable: [],
    undeclared: [],
    incomplete: [],
    tracking: [],
  };

  for (const p of native) {
    const errors = p.manifestIssues.filter((i) => i.level === 'error');
    const warnings = p.manifestIssues.filter((i) => i.level === 'warning');
    if (errors.length) result.invalid.push({ ...ref(p), issues: errors });
    if (warnings.length) result.questionable.push({ ...ref(p), issues: warnings });

    const fromSource = [...p.apis].filter(([, u]) => u.evidence.some((e) => e.kind === 'source')).map(([c]) => c);
    if (!p.shipsManifest.length && !errors.length && fromSource.length) {
      result.undeclared.push({ ...ref(p), categories: fromSource, evidence: fromSource.flatMap((c) => sourceEvidence(p, c)).slice(0, 3) });
    } else if (p.shipsManifest.length) {
      const missing = fromSource.filter((c) => !p.apis.get(c)!.evidence.some((e) => e.kind === 'manifest'));
      if (missing.length) result.incomplete.push({ ...ref(p), missing, evidence: missing.flatMap((c) => sourceEvidence(p, c)).slice(0, 3) });
    }

    if (p.declaresTracking || p.trackingDomains.length) {
      result.tracking.push({ ...ref(p), declaresTracking: p.declaresTracking, domains: p.trackingDomains });
    }
  }
  return result;
}

export function auditProblemCount(a: Audit): number {
  return a.invalid.length + a.undeclared.length + a.incomplete.length;
}

export const categoryList = (cats: ApiCategory[]) => cats.map((c) => API_LABELS[c]).join(', ');
