import path from 'node:path';
import type { Analysis } from './analyze.js';
import { API_CATEGORIES, API_LABELS } from './apis.js';
import { SENSITIVE_PERMISSIONS } from './android.js';
import { PURPOSE_KEYS } from './purpose.js';
import { DATA_TYPES } from './types.js';
import type { ApiCategory, ApiEvidence, DataType, PackageReport, ScanResult } from './types.js';

/**
 * `rn-privacy why <thing>`: where an entry comes from. The thing can be a required reason API
 * ("Disk space"), an Info.plist key (NSCameraUsageDescription), a data type ("Device ID"), an
 * Android permission (CAMERA), a tracking domain or a package name.
 */
export interface WhyReason {
  /** Who: a package, your app's code, an extension, or your rules. */
  who: string;
  version?: string;
  /** One line per piece of evidence, with paths relative to the project. */
  evidence: string[];
}

export interface WhyMatch {
  kind: 'api' | 'purpose-string' | 'data' | 'android-permission' | 'tracking-domain' | 'package';
  /** What matched, in words. */
  title: string;
  reasons: WhyReason[];
  /** What to do or know about it. */
  notes: string[];
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9.]/g, '');

function evidenceLine(e: ApiEvidence, base: string | undefined, projectDir: string): string {
  const file = base ? path.relative(projectDir, path.join(base, e.file)) : e.file;
  if (e.kind === 'manifest') return `declared in its privacy manifest ${file}`;
  return `${e.kind === 'binary' ? 'prebuilt binary' : 'code'} ${file}: ${e.symbol}`;
}

function ruleLine(pkg: PackageReport): string {
  if (!pkg.rule) return 'declared in its own privacy manifest';
  if (pkg.rule.origin) return `your rule in ${pkg.rule.origin}`;
  const ver = pkg.rule.versions ? ` for versions ${pkg.rule.versions}` : '';
  return `rn-privacy's rule for ${pkg.rule.name}${ver}, based on ${[...pkg.rule.sources, ...(pkg.rule.android?.sources ?? [])].join(', ') || 'the vendor documentation'}`;
}

export function explain(query: string, projectDir: string, scan: ScanResult, a: Analysis): WhyMatch[] {
  const q = norm(query);
  if (!q) return [];
  const matches: WhyMatch[] = [];

  // Required reason API categories.
  for (const category of API_CATEGORIES) {
    const label = API_LABELS[category];
    if (![norm(label), norm(category), norm(category.replace('NSPrivacyAccessedAPICategory', ''))].includes(q)) continue;
    matches.push(apiMatch(category, projectDir, scan, a));
  }

  // Info.plist purpose strings.
  for (const [key, info] of Object.entries(PURPOSE_KEYS)) {
    if (![norm(key), norm(info.label)].includes(q)) continue;
    const reasons: WhyReason[] = [];
    for (const pkg of scan.packages) {
      const ev = pkg.purposeUses.get(key);
      if (ev) reasons.push({ who: pkg.name, version: pkg.version, evidence: ev.map((e) => evidenceLine(e, pkg.dir, projectDir)) });
    }
    for (const ext of scan.extensions) {
      const ev = ext.purposeUses.get(key);
      if (ev) reasons.push({ who: `${ext.dir} (app extension)`, evidence: ev.map((e) => evidenceLine(e, projectDir, projectDir)) });
    }
    matches.push({
      kind: 'purpose-string',
      title: `${key} (${info.label}): Info.plist purpose string`,
      reasons,
      notes: reasons.length
        ? [info.runtimeOnly
          ? 'Without it, iOS refuses the feature at runtime.'
          : 'This code asks for access, so Info.plist needs the key with a sentence telling users why. Without it App Store Connect rejects the upload (ITMS-90683).']
        : ['Nothing in your code or libraries asks for this access.'],
    });
  }

  // Collected data types.
  for (const type of Object.keys(DATA_TYPES) as DataType[]) {
    const info = DATA_TYPES[type];
    if (![norm(type), norm(info.label), norm(info.apple), norm(info.apple.replace('NSPrivacyCollectedDataType', ''))].includes(q)) continue;
    const reasons: WhyReason[] = [];
    for (const pkg of scan.packages) {
      const items = [...(pkg.rule ? pkg.rule.collects ?? [] : pkg.manifestCollected).filter((c) => c.type === type)];
      const play = pkg.rule?.android?.collects.filter((c) => c.type === type) ?? [];
      if (!items.length && !play.length) continue;
      const evidence: string[] = [];
      for (const c of items) evidence.push(`iOS: ${c.purposes.join(', ')}${c.linked ? ', linked' : ''}${c.tracking ? ', tracking' : ''}${c.conditional ? ` (${c.conditional})` : ''}`);
      for (const c of play) evidence.push(`Android: ${c.purposes.join(', ') || 'purpose not stated'}${c.shared ? ', shared' : ''}${c.conditional ? ` (${c.conditional})` : ''}`);
      evidence.push(`From ${ruleLine(pkg)}`);
      reasons.push({ who: pkg.name, version: pkg.version, evidence });
    }
    matches.push({
      kind: 'data',
      title: `${info.label}: collected data (Apple ${info.apple}, Google Play "${info.play.type}")`,
      reasons,
      notes: reasons.length ? [] : ['No library or rule says it collects this. If your own code or server does, add a rule without "packages" to rn-privacy.config.json.'],
    });
  }

  // Android permissions.
  for (const [perm, info] of Object.entries(SENSITIVE_PERMISSIONS)) {
    const short = perm.split('.').pop()!;
    if (![norm(perm), norm(short), norm(info.label)].includes(q)) continue;
    const finding = a.android.find((f) => f.permission === perm);
    const reasons: WhyReason[] = (finding?.sources ?? []).map((src) => {
      const pkg = scan.packages.find((p) => p.name === src);
      return { who: src, version: pkg?.version, evidence: [pkg ? `<uses-permission> in ${path.relative(projectDir, path.join(pkg.dir ?? '', 'android', 'src', 'main', 'AndroidManifest.xml'))}` : src === 'your app' ? 'your AndroidManifest.xml or expo.android.permissions' : 'the merged manifest of your last Android build'] };
    });
    const removed = scan.android.removed.includes(perm);
    matches.push({
      kind: 'android-permission',
      title: `${short} (${info.label}): Android permission`,
      reasons,
      notes: [
        ...(removed ? ['Your app removes it (tools:node="remove" or expo.android.blockedPermissions).'] : []),
        ...(info.note ? [info.note] : []),
        ...(!reasons.length && !removed ? ['Nothing in your app adds this permission.'] : []),
      ],
    });
  }

  // Tracking domains.
  const domainHits = a.tracking.filter((t) => t.domains.some((d) => norm(d) === q));
  if (domainHits.length) {
    matches.push({
      kind: 'tracking-domain',
      title: `${query}: tracking domain`,
      reasons: domainHits.map((t) => {
        const pkg = scan.packages.find((p) => p.name === t.pkg);
        return { who: t.pkg, version: pkg?.version, evidence: (pkg?.shipsManifest ?? []).map((f) => `NSPrivacyTrackingDomains in ${path.relative(projectDir, path.join(pkg!.dir ?? '', f))}`) };
      }),
      notes: ['Declared by the SDK for tracking. If your app uses App Tracking Transparency, `rn-privacy ios --write --tracking` adds it to your manifest.'],
    });
  }

  // Packages: everything rn-privacy knows about one.
  for (const pkg of scan.packages) {
    const base = pkg.name.replace(/ \((CocoaPods|Swift Package|local module)\)$/, '');
    if (![norm(pkg.name), norm(base)].includes(q)) continue;
    matches.push(packageMatch(pkg, projectDir));
  }
  return matches;
}

function apiMatch(category: ApiCategory, projectDir: string, scan: ScanResult, a: Analysis): WhyMatch {
  const reasons: WhyReason[] = [];
  for (const pkg of scan.packages) {
    const usage = pkg.apis.get(category);
    if (!usage) continue;
    const evidence = usage.evidence.map((e) => evidenceLine(e, pkg.dir, projectDir));
    if (usage.reasons.size) evidence.push(`reasons it declares: ${[...usage.reasons].join(', ')}`);
    reasons.push({ who: pkg.name, version: pkg.version, evidence });
  }
  for (const ext of scan.extensions) {
    const usage = ext.apis.get(category);
    const pods = usage ? [...usage.packages].filter((p) => p !== ext.dir) : [];
    if (usage) reasons.push({ who: `${ext.dir} (app extension)`, evidence: [...usage.evidence.map((e) => evidenceLine(e, projectDir, projectDir)), ...(pods.length ? [`through ${pods.join(', ')}`] : [])] });
  }
  const finding = a.apis.find((x) => x.category === category);
  return {
    kind: 'api',
    title: `${API_LABELS[category]} (${category}): required reason API`,
    reasons,
    notes: finding
      ? [`Your app manifest needs it with ${finding.defaultReason ? `a reason; rn-privacy suggests ${finding.reasons[0]}, check it fits` : `the reasons ${finding.reasons.join(', ')}`}.`]
      : reasons.length ? ['Only app extensions use it: they need it in their own manifests.'] : ['Nothing in your code or libraries uses it.'],
  };
}

function packageMatch(pkg: PackageReport, projectDir: string): WhyMatch {
  const lines: string[] = [];
  if (pkg.dir) lines.push(`installed at ${path.relative(projectDir, pkg.dir) || '.'}`);
  lines.push(pkg.hasIosNative ? 'has iOS native code' : 'no iOS native code');
  for (const f of pkg.shipsManifest) lines.push(`ships the privacy manifest ${f}`);
  for (const [cat, usage] of pkg.apis) lines.push(`uses ${API_LABELS[cat]}: ${usage.evidence.map((e) => evidenceLine(e, pkg.dir, projectDir)).join('; ')}`);
  for (const [key, ev] of pkg.purposeUses) lines.push(`needs ${key}: ${ev.map((e) => evidenceLine(e, pkg.dir, projectDir)).join('; ')}`);
  const data = pkg.rule ? pkg.rule.collects ?? [] : pkg.manifestCollected;
  for (const c of data) lines.push(`collects ${DATA_TYPES[c.type].label} on iOS (${c.purposes.join(', ')}${c.conditional ? `; ${c.conditional}` : ''})`);
  for (const c of pkg.rule?.android?.collects ?? []) lines.push(`collects ${DATA_TYPES[c.type].label} on Android (${c.purposes.join(', ') || 'purpose not stated'}${c.shared ? ', shared' : ''}${c.conditional ? `; ${c.conditional}` : ''})`);
  if (data.length || pkg.rule?.android) lines.push(`data from ${ruleLine(pkg)}`);
  for (const perm of pkg.androidPermissions) if (SENSITIVE_PERMISSIONS[perm]) lines.push(`adds the Android permission ${perm.split('.').pop()} (${SENSITIVE_PERMISSIONS[perm].label})`);
  if (pkg.trackingDomains.length) lines.push(`declares tracking domains: ${pkg.trackingDomains.join(', ')}`);
  for (const issue of pkg.manifestIssues) lines.push(`manifest problem in ${issue.file}: ${issue.message}`);
  const notes: string[] = [];
  if (!pkg.rule && pkg.hasIosNative && !pkg.manifestCollected.length) notes.push('rn-privacy has no rule for what it collects. If it collects data, describe it in rn-privacy.config.json.');
  if (pkg.rule?.notes) notes.push(pkg.rule.notes);
  if (pkg.rule?.android?.notes) notes.push(`Android: ${pkg.rule.android.notes}`);
  return { kind: 'package', title: `${pkg.name}${pkg.version !== '-' ? `@${pkg.version}` : ''}`, reasons: [{ who: pkg.name, version: pkg.version, evidence: lines }], notes };
}

export function formatWhy(query: string, matches: WhyMatch[], c: { bold: (s: string) => string; dim: (s: string) => string; yellow: (s: string) => string }): string {
  if (!matches.length) {
    return `Nothing matches "${query}". Try a required reason API ("Disk space"), an Info.plist key (NSCameraUsageDescription), a data type ("Device ID"), an Android permission (CAMERA), a tracking domain or a package name.`;
  }
  const out: string[] = [];
  for (const m of matches) {
    out.push(c.bold(m.title));
    if (m.kind === 'package') {
      for (const line of m.reasons[0].evidence) out.push(`  ${line}`);
    } else {
      for (const r of m.reasons) {
        out.push(`  ${r.who}${r.version && r.version !== '-' ? c.dim(`@${r.version}`) : ''}`);
        for (const e of r.evidence) out.push(c.dim(`    ${e}`));
      }
    }
    for (const n of m.notes) out.push(c.yellow(`  ${n}`));
    out.push('');
  }
  return out.join('\n').trimEnd();
}
