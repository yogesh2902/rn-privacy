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

export interface CheckResult {
  ok: boolean;
  projectType: ScanResult['projectType'];
  usesExpoPlugin: boolean;
  /** Required reason API categories your libraries use. */
  requiredApis: { category: ApiCategory; label: string; reasons: string[]; packages: string[] }[];
  manifests: CheckedManifest[];
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
  };

  const declared = readDeclared(projectDir, scan.projectType, plugin);
  if (!declared.length) {
    if (plugin) return result; // The plugin generates the manifest at prebuild.
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

  result.ok = result.manifests.every((m) => m.status === 'ok');
  if (!result.ok) result.hint = hintFor(result.manifests, plugin);
  return result;
}

function hintFor(manifests: CheckedManifest[], plugin: boolean): string {
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
    return out;
  }
  if (!r.manifests.length && r.usesExpoPlugin) {
    say(c.green(`✓ The rn-privacy Expo plugin adds all ${r.requiredApis.length} required reason API categories at prebuild.`));
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
  if (!r.ok && r.hint) fail(`\n${r.hint}`);
  return out;
}
