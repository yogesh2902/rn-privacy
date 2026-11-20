import fs from 'node:fs';
import path from 'node:path';
import type { Analysis } from './analyze.js';
import { API_LABELS } from './apis.js';
import { findExpoConfig, findIosManifest } from './ios.js';
import { readManifest } from './manifest.js';
import type { PrivacyManifest } from './manifest.js';
import { DATA_TYPES } from './types.js';
import type { ApiCategory, DataType, ScanResult } from './types.js';
import { validateManifest } from './validate.js';
import { checkAppPurposes, checkExtensionPurposes } from './infoplist.js';
import type { PurposeCheck } from './infoplist.js';

/**
 * `rn-privacy check`: is every privacy manifest the app ships complete and valid?
 * runCheck() builds the result; formatCheck() prints it. `--format json` prints the result itself.
 */
export type ManifestStatus = 'ok' | 'missing-apis' | 'invalid' | 'not-generated' | 'unreadable';

export interface CheckedManifest {
  /** "app.json (expo.ios.privacyManifests)" or the manifest path relative to the project. */
  label: string;
  status: ManifestStatus;
  /** The ios folder of an Expo prebuild project, generated from app.json. */
  generated: boolean;
  /** app.json's privacyManifests, which the rn-privacy Expo plugin completes at prebuild. */
  completedByPlugin: boolean;
  /** Validation errors (ITMS-91056). */
  errors: string[];
  /** Validation warnings (likely mistakes). */
  warnings: string[];
  missingApis: { category: ApiCategory; label: string; packages: string[] }[];
  undeclaredData: { type: DataType; label: string; packages: string[] }[];
  missingTrackingDomains: { pkg: string; domains: string[] }[];
}

export interface CheckedExtension {
  name: string;
  /** Folder relative to the project. */
  dir: string;
  kind?: string;
  /** The extension's PrivacyInfo.xcprivacy relative to the project, or null when it has none. */
  manifest: string | null;
  status: 'ok' | 'missing' | 'missing-apis' | 'invalid' | 'unreadable';
  missingApis: { category: ApiCategory; label: string; packages: string[] }[];
  errors: string[];
  purposeStrings: PurposeCheck[];
}

export interface CheckResult {
  ok: boolean;
  projectType: ScanResult['projectType'];
  usesExpoPlugin: boolean;
  /** Required reason API categories your libraries use. */
  requiredApis: { category: ApiCategory; label: string; reasons: string[]; packages: string[] }[];
  manifests: CheckedManifest[];
  /** Info.plist purpose strings the app needs, and whether it has them (ITMS-90683). */
  purposeStrings: PurposeCheck[];
  /** App extensions that use required reason APIs or ask for access. */
  extensions: CheckedExtension[];
  /** Set when there is nothing to check. */
  error?: string;
  /** What to do next, when the check failed. */
  hint?: string;
}

interface DeclaredSource {
  label: string;
  /** null when the file should exist (generated from app.json) but prebuild has not created it. */
  manifest: PrivacyManifest | null;
  generated?: boolean;
  /** The file exists but is not a valid property list. */
  unreadable?: boolean;
  isAppJson?: boolean;
}

/** An array from a manifest value that may be malformed. */
export function list<T>(value: T[] | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

export function readExpoPrivacy(appJson: string): PrivacyManifest | undefined {
  const json = JSON.parse(fs.readFileSync(appJson, 'utf8'));
  return (json.expo ?? json)?.ios?.privacyManifests;
}

/**
 * Every privacy manifest the app ships. An Expo prebuild project has two: app.json, and the
 * PrivacyInfo.xcprivacy that `expo prebuild` writes into ios/. They drift apart when app.json
 * changes and the ios folder is not regenerated, so both are checked.
 */
function readDeclared(projectDir: string, type: string, usesPlugin: boolean): DeclaredSource[] {
  const out: DeclaredSource[] = [];
  let appJsonHasPrivacy = false;
  if (type.startsWith('expo')) {
    const cfg = findExpoConfig(projectDir);
    if (cfg?.appJson) {
      const pm = readExpoPrivacy(cfg.appJson);
      if (pm) {
        out.push({ label: 'app.json (expo.ios.privacyManifests)', manifest: pm, isAppJson: true });
        appJsonHasPrivacy = true;
      }
    }
  }
  if (type === 'expo-managed') return out;

  const target = findIosManifest(projectDir);
  if (!target) return out;
  const label = path.relative(projectDir, target.file);
  const generated = type === 'expo-prebuild' && (appJsonHasPrivacy || usesPlugin);
  if (target.exists) {
    const manifest = readManifest(target.file);
    out.push({ label, manifest, generated, unreadable: manifest === null });
  } else if (generated) out.push({ label, manifest: null, generated });
  return out;
}

export function runCheck(projectDir: string, scan: ScanResult, analysis: Analysis): CheckResult {
  const expoCfg = scan.projectType.startsWith('expo') ? findExpoConfig(projectDir) : null;
  const plugin = !!expoCfg?.usesPlugin;
  const result: CheckResult = {
    ok: true,
    projectType: scan.projectType,
    usesExpoPlugin: plugin,
    requiredApis: analysis.apis.map((a) => ({ category: a.category, label: API_LABELS[a.category], reasons: a.reasons, packages: a.packages })),
    manifests: [],
    purposeStrings: checkAppPurposes(projectDir, scan, analysis).checks,
    extensions: checkExtensions(projectDir, scan),
  };
  const othersOk = purposesOk(result.purposeStrings) && result.extensions.every((e) => e.status === 'ok' && purposesOk(e.purposeStrings));

  const declared = readDeclared(projectDir, scan.projectType, plugin);
  if (!declared.length) {
    if (plugin) { // The plugin generates the manifest at prebuild.
      result.ok = othersOk;
      if (!result.ok) result.hint = hintFor([], plugin, result);
      return result;
    }
    result.ok = false;
    if (expoCfg?.dynamic && expoCfg.dynamicMentionsPrivacy) {
      result.error = `privacyManifests is set in ${path.basename(expoCfg.dynamic)}, which rn-privacy cannot read (it never runs your code).`;
      result.hint = 'Move expo.ios.privacyManifests to app.json so it can be checked.';
    } else {
      result.error = 'No privacy manifest found (ios/<App>/PrivacyInfo.xcprivacy or expo.ios.privacyManifests in app.json).';
      if (analysis.apis.length) result.hint = `Your libraries use ${analysis.apis.length} required reason API categories. Run \`rn-privacy ios --write\`.`;
    }
    return result;
  }

  for (const src of declared) {
    const m: CheckedManifest = {
      label: src.label,
      status: 'ok',
      generated: !!src.generated,
      completedByPlugin: plugin && !!src.isAppJson,
      errors: [],
      warnings: [],
      missingApis: [],
      undeclaredData: [],
      missingTrackingDomains: [],
    };
    result.manifests.push(m);
    if (src.unreadable) {
      m.status = 'unreadable';
      continue;
    }
    if (!src.manifest) {
      m.status = 'not-generated';
      continue;
    }

    for (const p of validateManifest(src.manifest)) (p.level === 'error' ? m.errors : m.warnings).push(p.message);
    if (m.errors.length) m.status = 'invalid';
    // The plugin completes app.json's privacyManifests at prebuild: only its validity matters here.
    if (m.completedByPlugin) continue;

    const have = new Set(list(src.manifest.NSPrivacyAccessedAPITypes).map((e) => e?.NSPrivacyAccessedAPIType));
    m.missingApis = analysis.apis
      .filter((a) => !have.has(a.category))
      .map((a) => ({ category: a.category, label: API_LABELS[a.category], packages: a.packages }));
    const haveData = new Set(list(src.manifest.NSPrivacyCollectedDataTypes).map((e) => e?.NSPrivacyCollectedDataType));
    m.undeclaredData = analysis.data
      .filter((d) => d.packages.length && !haveData.has(DATA_TYPES[d.type].apple))
      .map((d) => ({ type: d.type, label: DATA_TYPES[d.type].label, packages: d.packages }));
    if (src.manifest.NSPrivacyTracking === true) {
      const declaredDomains = new Set(list(src.manifest.NSPrivacyTrackingDomains));
      for (const t of analysis.tracking) {
        const domains = t.domains.filter((d) => !declaredDomains.has(d));
        if (domains.length) m.missingTrackingDomains.push({ pkg: t.pkg, domains });
      }
    }
    if (m.missingApis.length && m.status === 'ok') m.status = 'missing-apis';
  }

  result.ok = result.manifests.every((m) => m.status === 'ok') && othersOk;
  if (!result.ok) result.hint = hintFor(result.manifests, plugin, result);
  return result;
}

/** A missing or empty purpose string blocks the upload, except the runtime-only ones (Face ID). */
export function purposesOk(checks: PurposeCheck[]): boolean {
  return checks.every((c) => c.runtimeOnly || c.status === 'ok' || c.status === 'by-plugin');
}

function checkExtensions(projectDir: string, scan: ScanResult): CheckedExtension[] {
  const out: CheckedExtension[] = [];
  for (const ext of scan.extensions) {
    const purposeStrings = checkExtensionPurposes(ext, projectDir);
    if (!ext.apis.size && !purposeStrings.length) continue;
    const e: CheckedExtension = {
      name: ext.name,
      dir: ext.dir,
      kind: ext.kind,
      manifest: ext.manifest ? path.relative(projectDir, ext.manifest) : null,
      status: 'ok',
      missingApis: [],
      errors: [],
      purposeStrings,
    };
    out.push(e);
    if (!ext.apis.size) continue;
    const needed = [...ext.apis].map(([category, v]) => ({ category, label: API_LABELS[category], packages: [...v.packages] }));
    if (!ext.manifest) {
      e.status = 'missing';
      e.missingApis = needed;
      continue;
    }
    const m = readManifest(ext.manifest);
    if (!m) {
      e.status = 'unreadable';
      continue;
    }
    e.errors = validateManifest(m).filter((p) => p.level === 'error').map((p) => p.message);
    const have = new Set(list(m.NSPrivacyAccessedAPITypes).map((x) => x?.NSPrivacyAccessedAPIType));
    e.missingApis = needed.filter((n) => !have.has(n.category));
    e.status = e.errors.length ? 'invalid' : e.missingApis.length ? 'missing-apis' : 'ok';
  }
  return out;
}

function hintFor(manifests: CheckedManifest[], plugin: boolean, r?: CheckResult): string {
  const manifestHint = manifests.every((m) => m.status === 'ok') ? '' : manifestHintFor(manifests, plugin);
  const other = otherHintFor(r);
  return [manifestHint, other].filter(Boolean).join('\n');
}

function otherHintFor(r?: CheckResult): string {
  const purposeProblem = r && (!purposesOk(r.purposeStrings) || r.extensions.some((e) => !purposesOk(e.purposeStrings)));
  const extProblem = r?.extensions.some((e) => e.status !== 'ok');
  {
    const parts: string[] = [];
    if (purposeProblem) {
      parts.push(r!.projectType === 'expo-managed'
        ? 'Add the missing purpose strings under expo.ios.infoPlist in app.json (or the library\'s config plugin), then prebuild.'
        : r!.projectType === 'expo-prebuild'
          ? 'Add the missing purpose strings under expo.ios.infoPlist in app.json and run `npx expo prebuild`, or add them to Info.plist.'
          : 'Add the missing purpose strings to Info.plist, each with a sentence that tells users why the app needs the access.');
    }
    if (extProblem) parts.push('Run `rn-privacy ios --write` to create or update the extension manifests, then add each one to its extension target in Xcode.');
    return parts.join('\n');
  }
}

function manifestHintFor(manifests: CheckedManifest[], plugin: boolean): string {
  const invalid = manifests.some((m) => m.status === 'invalid' || m.status === 'unreadable');
  const missing = manifests.some((m) => m.missingApis.length);
  const generatedOutdated = manifests.some((m) => m.generated && (m.status === 'missing-apis' || m.status === 'not-generated'));
  const sourceOk = manifests.some((m) => !m.generated && m.status === 'ok');
  if (invalid) {
    return 'Fix the invalid entries by hand: rn-privacy only adds entries, it never edits or removes yours.' +
      (missing ? '\nThen run `rn-privacy ios --write` to add what is missing.' : '');
  }
  if (generatedOutdated && plugin) return 'The ios folder is out of date. Run `npx expo prebuild` and the rn-privacy plugin will regenerate the manifest.';
  if (generatedOutdated && sourceOk) {
    return 'app.json is correct, but the ios folder is out of date with it.\nRun `npx expo prebuild` to regenerate it, or `rn-privacy ios --write` to update both.';
  }
  return 'Run `rn-privacy ios --write` to fix.';
}

export interface Painter {
  red: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  bold: (s: string) => string;
}

/** Text output for the terminal: problems go to stderr, everything else to stdout. */
export function formatCheck(r: CheckResult, c: Painter): { stream: 'out' | 'err'; text: string }[] {
  const out: { stream: 'out' | 'err'; text: string }[] = [];
  const say = (text: string) => out.push({ stream: 'out', text });
  const fail = (text: string) => out.push({ stream: 'err', text });

  if (r.error) {
    fail(c.red(`✗ ${r.error}`));
    if (r.hint) fail(`  ${r.hint}`);
    formatOthers(r, c, say, fail);
    const other = otherHintFor(r);
    if (other) fail(`\n${other}`);
    return out;
  }
  if (!r.manifests.length && r.usesExpoPlugin) {
    say(c.green(`✓ The rn-privacy Expo plugin adds all ${r.requiredApis.length} required reason API categories at prebuild.`));
    formatOthers(r, c, say, fail);
    if (!r.ok && r.hint) fail(`\n${r.hint}`);
    return out;
  }

  const several = r.manifests.length > 1;
  const pad = several ? '  ' : '';
  for (const m of r.manifests) {
    if (several) say(c.bold(m.label));
    if (m.status === 'unreadable') {
      fail(c.red(`${pad}✗ Invalid privacy manifest: the file is not a valid property list (ITMS-91056).`));
      continue;
    }
    if (m.status === 'not-generated') {
      fail(c.red(`${pad}✗ Not generated yet: ${m.label} does not exist. Run \`npx expo prebuild\`.`));
      continue;
    }
    for (const w of m.warnings) say(c.yellow(`${pad}! ${w}`));
    for (const e of m.errors) fail(c.red(`${pad}✗ Invalid: ${e}`));
    if (m.errors.length) fail(c.red(`${pad}  App Store Connect rejects invalid manifests with ITMS-91056.`));
    if (m.completedByPlugin) {
      if (!m.errors.length) say(c.green(`${pad}✓ Valid. The rn-privacy Expo plugin adds the rest at prebuild.`));
      continue;
    }
    for (const d of m.undeclaredData) say(c.yellow(`${pad}! Not declared: ${d.label} (collected by ${d.packages.join(', ')})`));
    for (const t of m.missingTrackingDomains) {
      say(c.yellow(`${pad}! Tracking domain not declared: ${t.domains.join(', ')} (from ${t.pkg}). Run \`rn-privacy ios --write --tracking\`.`));
    }
    for (const a of m.missingApis) fail(c.red(`${pad}✗ Missing required reason API: ${a.label} (used by ${a.packages.join(', ')})`));
    if (m.status === 'ok') {
      say(c.green(`${pad}✓ ${several ? 'Covers' : 'Privacy manifest covers'} all ${r.requiredApis.length} required reason API categories.`));
    }
  }
  formatOthers(r, c, say, fail);
  if (!r.ok && r.hint) fail(`\n${r.hint}`);
  return out;
}

function formatPurposes(checks: PurposeCheck[], c: Painter, say: (t: string) => void, fail: (t: string) => void, pad = '') {
  for (const p of checks) {
    const by = `asked for by ${p.packages.join(', ')}`;
    if (p.status === 'ok') continue;
    if (p.status === 'by-plugin') { say(`${pad}✓ ${p.key} (${p.label}): added by the ${p.plugin} config plugin at prebuild`); continue; }
    const what = p.status === 'empty' ? 'is empty in' : 'is missing from';
    if (p.runtimeOnly) say(c.yellow(`${pad}! ${p.key} (${p.label}) ${what} ${p.checked}, ${by}. iOS refuses the feature without it.`));
    else fail(c.red(`${pad}✗ ${p.key} (${p.label}) ${what} ${p.checked}, ${by}. App Store Connect rejects this (ITMS-90683).`));
  }
}

function formatOthers(r: CheckResult, c: Painter, say: (t: string) => void, fail: (t: string) => void) {
  if (r.purposeStrings.length) {
    const okCount = r.purposeStrings.filter((p) => p.status === 'ok').length;
    formatPurposes(r.purposeStrings, c, say, fail);
    if (okCount === r.purposeStrings.length) say(c.green(`✓ Info.plist has all ${okCount} purpose strings your code and libraries need.`));
  }
  for (const e of r.extensions) {
    say(c.bold(`${e.dir}`) + (e.kind ? ` (${e.kind.replace(/^com\.apple\./, '')})` : ''));
    if (e.status === 'missing') fail(c.red(`  ✗ No privacy manifest, but the extension uses ${e.missingApis.map((a) => a.label).join(', ')} (${[...new Set(e.missingApis.flatMap((a) => a.packages))].join(', ')}). Each extension needs its own (ITMS-91053).`));
    else if (e.status === 'unreadable') fail(c.red(`  ✗ ${e.manifest} is not a valid property list (ITMS-91056).`));
    else {
      for (const err of e.errors) fail(c.red(`  ✗ Invalid: ${err}`));
      for (const a of e.missingApis) fail(c.red(`  ✗ Missing required reason API: ${a.label} (used by ${a.packages.join(', ')})`));
      if (e.status === 'ok' && e.manifest) say(c.green(`  ✓ ${e.manifest} covers the extension's required reason APIs.`));
    }
    formatPurposes(e.purposeStrings, c, say, fail, '  ');
  }
}
