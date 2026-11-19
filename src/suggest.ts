import path from 'node:path';
import { API_LABELS, DEFAULT_REASONS, isApiCategory } from './apis.js';
import { audit } from './audit.js';
import { buildManifest, readManifest } from './manifest.js';
import type { PrivacyManifest } from './manifest.js';
import { DATA_TYPES, PURPOSES } from './types.js';
import type { ApiCategory, PackageReport, ScanResult } from './types.js';
import { VALID_DATA_TYPES, VALID_PURPOSES, VALID_REASONS } from './validate.js';

/**
 * `rn-privacy audit --suggest`: for each library with a privacy manifest problem, a corrected
 * PrivacyInfo.xcprivacy and a ready-to-post issue. Nothing is guessed: what rn-privacy cannot
 * know is listed under "Please decide" for the maintainer.
 */
export interface Suggestion {
  pkg: string;
  version: string;
  issuesUrl?: string;
  /** Where the file belongs in the library (its current manifest, or ios/PrivacyInfo.xcprivacy). */
  manifestPath: string;
  manifest: PrivacyManifest;
  /** What was changed, for the issue. */
  changes: string[];
  /** What the maintainer has to decide. */
  decide: string[];
  /** Found problems, for the issue. */
  problems: string[];
  /** Where the APIs were found. */
  evidence: string[];
}

const APPLE_DOCS = {
  reasons: 'https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacyaccessedapitypes/nsprivacyaccessedapitypereasons',
  types: 'https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacycollecteddatatypes/nsprivacycollecteddatatype',
  purposes: 'https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacycollecteddatatypes/nsprivacycollecteddatatypepurposes',
};

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function suggestFixes(scan: ScanResult): Suggestion[] {
  const result = audit(scan);
  const names = new Set([...result.invalid, ...result.undeclared, ...result.incomplete].map((r) => r.pkg));
  const out: Suggestion[] = [];
  for (const pkg of scan.packages) {
    if (!names.has(pkg.name)) continue;
    out.push(suggestFor(pkg, {
      problems: [
        ...(result.invalid.find((r) => r.pkg === pkg.name)?.issues.map((i) => `${i.file}: ${i.message}`) ?? []),
        ...(result.undeclared.find((r) => r.pkg === pkg.name) ? ['Uses required reason APIs but ships no privacy manifest.'] : []),
        ...(result.incomplete.find((r) => r.pkg === pkg.name)?.missing.map((c) => `The manifest does not declare ${API_LABELS[c]}, which the code uses.`) ?? []),
      ],
    }));
  }
  return out;
}

function suggestFor(pkg: PackageReport, found: { problems: string[] }): Suggestion {
  const changes: string[] = [];
  const decide: string[] = [];
  const existingRel = pkg.shipsManifest[0];
  const parsed = existingRel && pkg.dir ? readManifest(path.join(pkg.dir, existingRel)) : null;
  const base: Record<string, unknown> = isObject(parsed) ? structuredClone(parsed) : {};
  if (existingRel && !parsed) changes.push('Replaced a file that was not a valid property list.');

  const manifest: PrivacyManifest = {};
  // Keep keys in Apple's usual order; unknown keys are kept as they are.
  manifest.NSPrivacyTracking = typeof base.NSPrivacyTracking === 'boolean' ? base.NSPrivacyTracking : false;
  if ('NSPrivacyTracking' in base && typeof base.NSPrivacyTracking !== 'boolean') {
    decide.push(`NSPrivacyTracking was ${JSON.stringify(base.NSPrivacyTracking)}, not a boolean. Set to false: change it to true if the SDK tracks users.`);
  }

  // Tracking domains: domain names only.
  manifest.NSPrivacyTrackingDomains = [];
  for (const raw of strings(base.NSPrivacyTrackingDomains)) {
    const d = raw.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0].toLowerCase();
    if (!d) continue;
    if (d !== raw) changes.push(`Tracking domain "${raw}" → "${d}" (Apple expects the domain name only).`);
    if (!manifest.NSPrivacyTrackingDomains.includes(d)) manifest.NSPrivacyTrackingDomains.push(d);
  }

  // Collected data: drop unknown types and purposes. Missing purposes come from the rn-privacy
  // rule for this library (which is based on the vendor's own disclosure) or are left to decide.
  manifest.NSPrivacyCollectedDataTypes = [];
  const rulePurposes = (appleType: string): string[] => {
    const type = (Object.keys(DATA_TYPES) as (keyof typeof DATA_TYPES)[]).find((t) => DATA_TYPES[t].apple === appleType);
    const item = type && pkg.rule?.collects?.find((c) => c.type === type);
    return item ? [...new Set(item.purposes.map((p) => PURPOSES[p].apple))] : [];
  };
  for (const entry of Array.isArray(base.NSPrivacyCollectedDataTypes) ? base.NSPrivacyCollectedDataTypes : []) {
    if (!isObject(entry)) continue;
    const type = entry.NSPrivacyCollectedDataType;
    if (typeof type !== 'string' || !VALID_DATA_TYPES.has(type)) {
      changes.push(`Removed ${JSON.stringify(type)}: not one of Apple's collected data types.`);
      decide.push(`If ${JSON.stringify(type)} was meant to declare real data, pick the matching Apple type (for example NSPrivacyCollectedDataTypeOtherDataTypes).`);
      continue;
    }
    const given = strings(entry.NSPrivacyCollectedDataTypePurposes);
    let purposes = given.filter((p) => VALID_PURPOSES.has(p));
    for (const p of given.filter((x) => !VALID_PURPOSES.has(x))) changes.push(`${type}: removed the invalid purpose ${JSON.stringify(p)}.`);
    if (!purposes.length) {
      const fromRule = rulePurposes(type);
      if (fromRule.length) {
        purposes = fromRule;
        const names = fromRule.map((p) => p.replace('NSPrivacyCollectedDataTypePurpose', '')).join(', ');
        changes.push(`${type}: added purposes ${names}, taken from rn-privacy's rule for ${pkg.rule!.name} (based on its documentation).`);
        decide.push(`${type}: confirm the purposes ${names} match how the SDK uses it.`);
      } else {
        decide.push(`${type} has no valid purpose. Add the real one(s), for example NSPrivacyCollectedDataTypePurposeAnalytics.`);
      }
    }
    const linked = entry.NSPrivacyCollectedDataTypeLinked;
    const tracking = entry.NSPrivacyCollectedDataTypeTracking;
    if (typeof linked !== 'boolean') decide.push(`${type}: NSPrivacyCollectedDataTypeLinked was not a boolean. Set to false: confirm.`);
    if (typeof tracking !== 'boolean') decide.push(`${type}: NSPrivacyCollectedDataTypeTracking was not a boolean. Set to false: confirm.`);
    manifest.NSPrivacyCollectedDataTypes.push({
      NSPrivacyCollectedDataType: type,
      NSPrivacyCollectedDataTypeLinked: typeof linked === 'boolean' ? linked : false,
      NSPrivacyCollectedDataTypeTracking: typeof tracking === 'boolean' ? tracking : false,
      NSPrivacyCollectedDataTypePurposes: purposes,
    });
  }

  // Required reason APIs: keep valid reasons, add the categories the code uses.
  manifest.NSPrivacyAccessedAPITypes = [];
  const declared = new Set<string>();
  for (const entry of Array.isArray(base.NSPrivacyAccessedAPITypes) ? base.NSPrivacyAccessedAPITypes : []) {
    if (!isObject(entry) || !isApiCategory(entry.NSPrivacyAccessedAPIType)) {
      if (isObject(entry)) changes.push(`Removed ${JSON.stringify(entry.NSPrivacyAccessedAPIType)}: not a required reason API category.`);
      continue;
    }
    const category: ApiCategory = entry.NSPrivacyAccessedAPIType;
    const given = strings(entry.NSPrivacyAccessedAPITypeReasons);
    let reasons = given.filter((r) => VALID_REASONS[category].includes(r));
    for (const r of given.filter((x) => !VALID_REASONS[category].includes(x))) changes.push(`${API_LABELS[category]}: removed "${r}", not a valid reason for this category.`);
    if (!reasons.length) {
      reasons = [DEFAULT_REASONS[category].code];
      decide.push(`${API_LABELS[category]}: no valid reason was given, so ${reasons[0]} (${DEFAULT_REASONS[category].meaning}) is suggested. Confirm it matches what the code does.`);
    }
    const existing = manifest.NSPrivacyAccessedAPITypes.find((e) => e.NSPrivacyAccessedAPIType === category);
    if (existing) for (const r of reasons) { if (!existing.NSPrivacyAccessedAPITypeReasons.includes(r)) existing.NSPrivacyAccessedAPITypeReasons.push(r); }
    else manifest.NSPrivacyAccessedAPITypes.push({ NSPrivacyAccessedAPIType: category, NSPrivacyAccessedAPITypeReasons: reasons });
    declared.add(category);
  }
  const evidence: string[] = [];
  for (const [category, usage] of pkg.apis) {
    const seen = usage.evidence.filter((e) => e.kind !== 'manifest');
    if (!seen.length) continue;
    evidence.push(...seen.slice(0, 2).map((e) => `${API_LABELS[category]}: ${e.file} (${'symbol' in e ? e.symbol : ''})`));
    if (declared.has(category)) continue;
    const reason = DEFAULT_REASONS[category];
    manifest.NSPrivacyAccessedAPITypes.push({ NSPrivacyAccessedAPIType: category, NSPrivacyAccessedAPITypeReasons: [reason.code] });
    changes.push(`Added ${API_LABELS[category]} with reason ${reason.code}.`);
    decide.push(`${API_LABELS[category]}: ${reason.code} means "${reason.meaning}". Confirm it matches what the code does, or pick another reason from Apple's list.`);
  }

  // Keep any other keys the maintainer had.
  for (const [key, value] of Object.entries(base)) if (!(key in manifest)) manifest[key] = value;

  return {
    pkg: pkg.name,
    version: pkg.version,
    issuesUrl: pkg.issuesUrl,
    manifestPath: existingRel ?? 'ios/PrivacyInfo.xcprivacy',
    manifest,
    changes,
    decide,
    problems: found.problems,
    evidence,
  };
}

export function suggestionManifest(s: Suggestion): string {
  return buildManifest(s.manifest);
}

/** The text of a GitHub issue for the library's maintainers. */
export function suggestionIssue(s: Suggestion): { title: string; body: string } {
  const title = s.problems.some((p) => p.includes('ships no privacy manifest'))
    ? 'Add an iOS privacy manifest (PrivacyInfo.xcprivacy) for required reason APIs'
    : 'iOS privacy manifest (PrivacyInfo.xcprivacy) needs a fix';
  const lines = [
    `Checked \`${s.pkg}\`${s.version && s.version !== '-' ? ` ${s.version}` : ''}. Apple requires apps and SDKs to declare required reason APIs and collected data in \`PrivacyInfo.xcprivacy\`, with values from Apple's lists.`,
    '',
    '## What I found',
    '',
    ...s.problems.map((p) => `- ${p}`),
    ...(s.evidence.length ? ['', 'Where the APIs are used:', '', ...s.evidence.map((e) => `- ${e}`)] : []),
    '',
    `## Suggested \`${s.manifestPath}\``,
    '',
    '```xml',
    suggestionManifest(s).trimEnd(),
    '```',
    '',
    ...(s.changes.length ? ['Changes:', '', ...s.changes.map((c) => `- ${c}`), ''] : []),
    ...(s.decide.length ? ['Please decide (I could not know these):', '', ...s.decide.map((d) => `- ${d}`), ''] : []),
    `Apple's lists: [reasons](${APPLE_DOCS.reasons}), [data types](${APPLE_DOCS.types}), [purposes](${APPLE_DOCS.purposes}).`,
    '',
    'Found with [rn-privacy](https://github.com/yogesh2902/rn-privacy) (`npx rn-privacy audit --suggest`). Static analysis can be wrong, so please check before applying. Happy to open a PR.',
  ];
  return { title, body: lines.join('\n') + '\n' };
}
