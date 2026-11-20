import fs from 'node:fs';
import path from 'node:path';
import { findApiSymbols } from './apis.js';
import { manifestApis, manifestCollected, readManifest } from './manifest.js';
import { findRule } from './rules.js';
import type { ApiCategory, ApiEvidence, ExtensionReport, PackageReport, ScanResult } from './types.js';
import { validateManifest } from './validate.js';
import { libraryManifestPath, readAndroidManifest, readAppAndroid } from './android.js';
import { isAppleBinary, scanBinaryFull, SKIP_SLICE } from './binary.js';
import { findPurposeUses, podfilePermissions } from './purpose.js';
import plist from 'plist';
import { loadConfig } from './config.js';
import { findSwiftPackages, packageDirs } from './spm.js';
import type { LibraryRule } from './types.js';

const SKIP_DIRS = new Set([
  'node_modules', 'android', 'example', 'examples', 'Example', 'Examples', 'sample', 'samples',
  '__tests__', '__mocks__', 'test', 'tests', 'Tests', 'docs', 'website', 'fixtures', '.git', 'Pods', 'build',
]);
const APPLE_SOURCE = new Set(['.m', '.mm', '.swift', '.h']);
const C_SOURCE = new Set(['.c', '.cc', '.cpp', '.hpp']);
const MAX_FILE_BYTES = 2 * 1024 * 1024;

interface PkgJson {
  name?: string;
  version?: string;
  bugs?: string | { url?: string };
  repository?: string | { url?: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  expo?: { autolinking?: { nativeModulesDir?: string } };
}

/** The nearest file or folder with this name in dir or a parent folder (monorepos keep it at the root). */
function findUp(dir: string, name: string): string | null {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, name))) return path.join(d, name);
    if (path.dirname(d) === d) return null;
  }
}

/** The package's issue tracker: `bugs`, or `<repository>/issues` for GitHub, GitLab and Bitbucket. */
export function issuesUrl(pkg: PkgJson): string | undefined {
  const bugs = typeof pkg.bugs === 'string' ? pkg.bugs : pkg.bugs?.url;
  if (bugs && /^https?:\/\//.test(bugs)) return bugs;
  let repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  if (!repo) return undefined;
  repo = repo.replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git:\/\//, 'https://').replace(/^git@([^:]+):/, 'https://$1/');
  const short = /^(github|gitlab|bitbucket):(.+)$/.exec(repo) ?? (/^[\w.-]+\/[\w.-]+$/.test(repo) ? [repo, 'github', repo] : null);
  if (short) repo = `https://${short[1]}.${short[1] === 'bitbucket' ? 'org' : 'com'}/${short[2]}`;
  return /^https:\/\/(github\.com|gitlab\.com|bitbucket\.org)\//.test(repo) ? `${repo}/issues` : undefined;
}

/** Read one privacy manifest a library ships and record what it declares and what is wrong with it. */
function readLibraryManifest(report: PackageReport, file: string, rel: string) {
  const m = readManifest(file);
  if (!m) {
    report.manifestIssues.push({ file: rel, level: 'error', message: 'Not a valid property list, so Apple cannot read it.' });
    return;
  }
  report.shipsManifest.push(rel);
  for (const usage of manifestApis(m)) {
    let entry = report.apis.get(usage.category);
    if (!entry) report.apis.set(usage.category, (entry = { reasons: new Set(), evidence: [] }));
    for (const r of usage.reasons) entry.reasons.add(r);
    entry.evidence.push({ kind: 'manifest', file: rel });
  }
  report.manifestCollected.push(...manifestCollected(m));
  for (const p of validateManifest(m, { sdk: true })) report.manifestIssues.push({ file: rel, ...p });
  if (m.NSPrivacyTracking === true) report.declaresTracking = true;
  if (Array.isArray(m.NSPrivacyTrackingDomains)) {
    for (const raw of m.NSPrivacyTrackingDomains) {
      // Some SDKs list URLs (https://consent.adjust.com); Apple expects the domain name only.
      const d = typeof raw === 'string' ? raw.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0].toLowerCase() : '';
      if (d && !report.trackingDomains.includes(d)) report.trackingDomains.push(d);
    }
  }
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Find an installed package by walking up node_modules folders, like Node does. */
export function resolvePackageDir(name: string, fromDir: string): string | null {
  let dir = path.resolve(fromDir);
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return fs.realpathSync(candidate);
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function hasIosNative(pkgDir: string): boolean {
  let entries: string[];
  try {
    entries = fs.readdirSync(pkgDir);
  } catch {
    return false;
  }
  if (entries.some((e) => e.endsWith('.podspec'))) return true;
  if (entries.includes('ios') || entries.includes('apple')) return true;
  const expoCfg = readJson<{ platforms?: string[]; apple?: unknown; ios?: unknown }>(path.join(pkgDir, 'expo-module.config.json'));
  return !!expoCfg && (!!expoCfg.ios || !!expoCfg.apple || (expoCfg.platforms ?? []).some((p) => p === 'ios' || p === 'apple'));
}

interface WalkResult {
  manifests: string[];
  sources: string[];
  binaryFramework: boolean;
  /** Files that may be prebuilt binaries (inside .framework/.xcframework, or .a/.dylib), iOS slices only. */
  binaries: string[];
}

function walk(pkgDir: string): WalkResult {
  const result: WalkResult = { manifests: [], sources: [], binaryFramework: false, binaries: [] };
  const stack = [pkgDir];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (entry.name.endsWith('.xcframework') || entry.name.endsWith('.framework')) result.binaryFramework = true;
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name === 'PrivacyInfo.xcprivacy') {
        result.manifests.push(full);
        continue;
      }
      const ext = path.extname(entry.name);
      const relPath = path.relative(pkgDir, full);
      const rel = relPath.split(path.sep);
      const inAppleDir = rel.some((p) => p === 'ios' || p === 'apple' || p === 'macos');
      if (APPLE_SOURCE.has(ext) || (C_SOURCE.has(ext) && inAppleDir)) result.sources.push(full);
      const inFramework = rel.some((p) => p.endsWith('.framework') || p.endsWith('.xcframework'));
      if (((inFramework && ext === '') || ext === '.a' || (inFramework && ext === '.dylib')) && !SKIP_SLICE.test(relPath)) {
        result.binaries.push(full);
      }
    }
  }
  return result;
}

/** The project's rule for a package if it has one, otherwise rn-privacy's own. */
function ruleFor(name: string, version: string | undefined, custom: LibraryRule[], builtIn = true): LibraryRule | undefined {
  return findRule(name, version, custom) ?? (builtIn ? findRule(name, version) : undefined);
}

export function scanPackage(name: string, pkgDir: string, customRules: LibraryRule[] = []): PackageReport {
  const pkg = readJson<PkgJson>(path.join(pkgDir, 'package.json')) ?? {};
  const report: PackageReport = {
    name,
    version: pkg.version ?? '?',
    dir: pkgDir,
    hasIosNative: hasIosNative(pkgDir),
    shipsManifest: [],
    hasBinaryFramework: false,
    apis: new Map(),
    manifestCollected: [],
    rule: ruleFor(name, pkg.version, customRules),
    manifestIssues: [],
    declaresTracking: false,
    trackingDomains: [],
    issuesUrl: issuesUrl(pkg),
    androidPermissions: readAndroidManifest(libraryManifestPath(pkgDir))?.uses ?? [],
    unscannedBinaries: [],
    purposeUses: new Map(),
  };
  if (!report.hasIosNative) return report;
  scanNative(report, walk(pkgDir), pkgDir);
  return report;
}

/** Read the manifests, scan the sources and the prebuilt binaries of one native package. */
function scanNative(report: PackageReport, files: WalkResult, baseDir: string, opts: { manifests?: boolean } = {}) {
  const add = (category: ApiCategory, reasons: string[], evidence: ApiEvidence) => {
    let entry = report.apis.get(category);
    if (!entry) report.apis.set(category, (entry = { reasons: new Set(), evidence: [] }));
    for (const r of reasons) entry.reasons.add(r);
    entry.evidence.push(evidence);
  };

  report.hasBinaryFramework ||= files.binaryFramework;
  // The app's own manifest is what rn-privacy checks, so it is not read as a library manifest.
  if (opts.manifests !== false) for (const file of files.manifests) readLibraryManifest(report, file, path.relative(baseDir, file));
  for (const file of files.sources) {
    let source: string;
    try {
      if (fs.statSync(file).size > MAX_FILE_BYTES) continue;
      source = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const hit of findApiSymbols(source)) {
      const entry = report.apis.get(hit.category);
      // Keep the evidence list short: a few files per category is enough to review.
      if (entry && entry.evidence.filter((e) => e.kind === 'source').length >= 3) continue;
      add(hit.category, [], { kind: 'source', file: path.relative(baseDir, file), symbol: hit.symbol });
    }
    for (const hit of findPurposeUses(source)) addPurpose(report, hit.key, { kind: 'source', file: path.relative(baseDir, file), symbol: hit.symbol });
  }
  scanBinaries(report, files.binaries, baseDir);
}

function addPurpose(report: { purposeUses: Map<string, ApiEvidence[]> }, key: string, evidence: ApiEvidence) {
  const list = report.purposeUses.get(key) ?? [];
  if (list.length < 3) list.push(evidence);
  report.purposeUses.set(key, list);
}

/** Add required reason APIs found in prebuilt binaries. */
function scanBinaries(report: PackageReport, files: string[], baseDir: string) {
  for (const file of files) {
    if (!isAppleBinary(file)) continue;
    const rel = path.relative(baseDir, file);
    const result = scanBinaryFull(file);
    if (!result) {
      report.unscannedBinaries.push(rel);
      continue;
    }
    for (const hit of result.purposes) addPurpose(report, hit.key, { kind: 'binary', file: rel, symbol: hit.symbol });
    for (const hit of result.apis) {
      let entry = report.apis.get(hit.category);
      if (!entry) report.apis.set(hit.category, (entry = { reasons: new Set(), evidence: [] }));
      if (entry.evidence.filter((e) => e.kind === 'binary').length < 3) entry.evidence.push({ kind: 'binary', file: rel, symbol: hit.symbol });
    }
  }
}

function detectProjectType(projectDir: string, pkg: PkgJson): ScanResult['projectType'] {
  const deps = { ...pkg.dependencies };
  const hasIos = fs.existsSync(path.join(projectDir, 'ios'));
  if (deps.expo) return hasIos ? 'expo-prebuild' : 'expo-managed';
  if (deps['react-native'] || hasIos) return 'bare';
  return 'unknown';
}

/**
 * Scan the app's runtime dependencies (not devDependencies), plus any native
 * packages they pull in, because autolinking (especially Expo's) can link
 * transitive native modules too.
 */
export function scanProject(projectDir: string): ScanResult {
  const pkgPath = path.join(projectDir, 'package.json');
  const pkg = readJson<PkgJson>(pkgPath);
  if (!pkg) throw new Error(`No package.json found in ${projectDir}`);

  const config = loadConfig(projectDir);
  const custom = config?.rules ?? [];
  const result: ScanResult = {
    projectDir,
    configFile: config?.file,
    unusedRules: [],
    swiftPackagesNotDownloaded: [],
    extensions: [],
    projectType: detectProjectType(projectDir, pkg),
    packages: [],
    missingPackages: [],
    android: readAppAndroid(projectDir),
    yarnPnp: findUp(projectDir, '.pnp.cjs') !== null && findUp(projectDir, 'node_modules') === null,
  };

  const seen = new Set<string>();
  const queue: { name: string; from: string; direct: boolean }[] = Object.keys(pkg.dependencies ?? {}).map((name) => ({
    name,
    from: projectDir,
    direct: true,
  }));

  while (queue.length) {
    const { name, from, direct } = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const dir = resolvePackageDir(name, from);
    if (!dir) {
      if (direct) result.missingPackages.push(name);
      continue;
    }
    const report = scanPackage(name, dir, custom);
    // Transitive packages only matter if they contain native code that needs declaring or a known rule.
    if (direct || report.hasIosNative || report.rule || report.androidPermissions.length) result.packages.push(report);
    // Only follow dependencies of native packages (and the expo meta-package):
    // pure-JS trees are huge and never ship iOS code that needs declaring.
    if (report.hasIosNative || name === 'expo') {
      const child = readJson<PkgJson>(path.join(dir, 'package.json'));
      for (const dep of Object.keys(child?.dependencies ?? {})) queue.push({ name: dep, from: dir, direct: false });
    }
  }

  result.packages.sort((a, b) => a.name.localeCompare(b.name));
  result.packages.push(...scanPods(projectDir, custom));
  const swift = scanSwiftPackages(projectDir, custom);
  result.packages.push(...swift.reports);
  result.swiftPackagesNotDownloaded = swift.notDownloaded;

  result.packages.push(...scanLocalModules(projectDir, pkg, custom));
  const native = scanAppNative(projectDir, result.packages);
  if (native.app) result.packages.push(native.app);
  result.extensions = native.extensions;
  limitPermissionHandlers(projectDir, result.packages);

  // Rules without packages describe what the app itself collects.
  for (const rule of custom.filter((r) => !r.packages.length)) result.packages.push(appReport(rule));
  // A project rule that matches nothing is probably a typo in the package name.
  for (const rule of custom.filter((r) => r.packages.length)) {
    if (!result.packages.some((p) => p.rule === rule || rule.packages.includes(p.name))) result.unusedRules.push(rule.name);
  }
  return result;
}

/**
 * Native SDKs wrapped by RN libraries (Firebase, Google Mobile Ads...) are
 * downloaded by CocoaPods into ios/Pods, not node_modules. After `pod install`
 * we read the privacy manifests those SDKs ship.
 */
export function scanPods(projectDir: string, customRules: LibraryRule[] = []): PackageReport[] {
  const podsDir = path.join(projectDir, 'ios', 'Pods');
  let pods: fs.Dirent[];
  try {
    pods = fs.readdirSync(podsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const reports: PackageReport[] = [];
  for (const pod of pods) {
    if (!pod.isDirectory() || ['Target Support Files', 'Local Podspecs', 'Headers', 'Pods.xcodeproj'].includes(pod.name)) continue;
    const podDir = path.join(podsDir, pod.name);
    const { manifests, binaries } = walk(podDir);
    // Only your own rules apply to pods: rn-privacy's rules are for npm packages.
    const rule = ruleFor(pod.name, undefined, customRules, false);
    if (!manifests.length && !binaries.length && !rule) continue;
    const report: PackageReport = {
      name: `${pod.name} (CocoaPods)`,
      rule,
      version: '-',
      dir: podsDir,
      hasIosNative: true,
      shipsManifest: [],
      hasBinaryFramework: false,
      apis: new Map(),
      manifestCollected: [],
      manifestIssues: [],
      declaresTracking: false,
      trackingDomains: [],
      androidPermissions: [],
      unscannedBinaries: [],
      purposeUses: new Map(),
      iosOnly: true,
    };
    for (const file of manifests) readLibraryManifest(report, file, path.relative(podsDir, file));
    scanBinaries(report, binaries, podsDir);
    // A pod with neither a manifest nor any required reason API has nothing to report.
    if (!manifests.length && !report.apis.size && !report.unscannedBinaries.length && !rule) continue;
    reports.push(report);
  }
  return reports;
}

/** A report for a project rule without packages: data the app's own code collects. */
function appReport(rule: LibraryRule): PackageReport {
  return {
    name: rule.name,
    version: '-',
    hasIosNative: false,
    shipsManifest: [],
    hasBinaryFramework: false,
    apis: new Map(),
    manifestCollected: [],
    rule,
    manifestIssues: [],
    declaresTracking: false,
    trackingDomains: [],
    androidPermissions: [],
    unscannedBinaries: [],
    purposeUses: new Map(),
  };
}

/**
 * Swift packages the iOS app adds in Xcode. They are not in node_modules or ios/Pods: Xcode
 * downloads them to DerivedData. Like pods, only your own rules apply to them.
 */
export function scanSwiftPackages(projectDir: string, customRules: LibraryRule[] = []): { reports: PackageReport[]; notDownloaded: string[] } {
  const found = findSwiftPackages(projectDir);
  const reports: PackageReport[] = [];
  const notDownloaded: string[] = [];
  for (const pkg of found.packages) {
    const dirs = found.sourcePackagesDir ? packageDirs(found.sourcePackagesDir, pkg) : [];
    const rule = ruleFor(pkg.identity, pkg.version, customRules, false) ?? ruleFor(pkg.name, pkg.version, customRules, false);
    const report: PackageReport = {
      name: `${pkg.name} (Swift Package)`,
      version: pkg.version,
      dir: found.sourcePackagesDir ?? undefined,
      hasIosNative: true,
      shipsManifest: [],
      hasBinaryFramework: false,
      apis: new Map(),
      manifestCollected: [],
      rule,
      manifestIssues: [],
      declaresTracking: false,
      trackingDomains: [],
      issuesUrl: pkg.location ? issuesUrl({ repository: pkg.location }) : undefined,
      androidPermissions: [],
      unscannedBinaries: [],
      purposeUses: new Map(),
      iosOnly: true,
    };
    if (!dirs.length) {
      notDownloaded.push(pkg.name);
      if (rule) reports.push(report);
      continue;
    }
    for (const dir of dirs) scanNative(report, walk(dir), found.sourcePackagesDir!);
    // Like pods: a package with no manifest, no required reason API and no rule has nothing to report.
    if (!report.shipsManifest.length && !report.manifestIssues.length && !report.apis.size && !report.unscannedBinaries.length && !rule) continue;
    reports.push(report);
  }
  return { reports, notDownloaded };
}

// ------------------------------------------------- the app's own native code

const IOS_SKIP = new Set(['Pods', 'build', 'DerivedData', 'SourcePackages', 'fastlane', 'vendor']);

function readPlist(file: string): Record<string, unknown> | null {
  try {
    const v = plist.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Podfile `target 'Name' do ... end` blocks and the pods inside each one. */
export function podfileTargets(podfile: string): Map<string, string[]> {
  const targets = new Map<string, string[]>();
  const stack: { name: string | null }[] = [];
  for (const raw of podfile.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    const t = /^(?:abstract_)?target\s+['"]([^'"]+)['"]\s+do\b/.exec(line);
    if (t) {
      stack.push({ name: t[1] });
      if (!targets.has(t[1])) targets.set(t[1], []);
      continue;
    }
    if (/\bdo\b(\s*\|[^|]*\|)?\s*$/.test(line)) { stack.push({ name: null }); continue; }
    if (/^end\b/.test(line)) { stack.pop(); continue; }
    const pod = /^pod\s+['"]([^'"/]+)/.exec(line);
    const current = [...stack].reverse().find((x) => x.name);
    if (pod && current?.name) targets.get(current.name)!.push(pod[1]);
  }
  return targets;
}

/**
 * Code in ios/ that belongs to the app itself (custom native modules, AppDelegate...), and the app
 * extensions (notification service, widgets...), which are bundles with their own manifest.
 */
export function scanAppNative(projectDir: string, packages: PackageReport[]): { app: PackageReport | null; extensions: ExtensionReport[] } {
  const iosDir = path.join(projectDir, 'ios');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(iosDir, { withFileTypes: true });
  } catch {
    return { app: null, extensions: [] };
  }
  let podfile = '';
  try { podfile = fs.readFileSync(path.join(iosDir, 'Podfile'), 'utf8'); } catch { /* no Podfile */ }
  const targets = podfileTargets(podfile);
  const app: PackageReport = {
    name: 'your app (ios)',
    version: '-',
    dir: projectDir,
    hasIosNative: true,
    shipsManifest: [],
    hasBinaryFramework: false,
    apis: new Map(),
    manifestCollected: [],
    manifestIssues: [],
    declaresTracking: false,
    trackingDomains: [],
    androidPermissions: [],
    unscannedBinaries: [],
    purposeUses: new Map(),
    iosOnly: true,
    origin: 'app-code',
  };
  const extensions: ExtensionReport[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || IOS_SKIP.has(e.name) || /\.(xcodeproj|xcworkspace)$/.test(e.name) || /Tests$/.test(e.name)) continue;
    const dir = path.join(iosDir, e.name);
    const info = readPlist(path.join(dir, 'Info.plist'));
    const files = walk(dir);
    const ext = info?.NSExtension as { NSExtensionPointIdentifier?: string } | undefined;
    if (!ext) {
      scanNative(app, files, projectDir, { manifests: false });
      continue;
    }
    const report: PackageReport = { ...app, name: e.name, apis: new Map(), purposeUses: new Map(), unscannedBinaries: [] };
    scanNative(report, files, projectDir, { manifests: false });
    const apis: ExtensionReport['apis'] = new Map();
    const addApi = (cat: ApiCategory, ev: ApiEvidence[], pkg: string) => {
      let entry = apis.get(cat);
      if (!entry) apis.set(cat, (entry = { reasons: new Set(), evidence: [], packages: new Set() }));
      entry.evidence.push(...ev.slice(0, 3 - entry.evidence.length));
      entry.packages.add(pkg);
    };
    for (const [cat, v] of report.apis) addApi(cat, v.evidence, `ios/${e.name}`);
    // Pods only this extension uses are linked into it. Those with their own manifest declare themselves.
    const pods = targets.get(e.name) ?? [];
    for (const pod of pods) {
      const pr = packages.find((p) => p.name === `${pod} (CocoaPods)`);
      if (!pr || pr.shipsManifest.length) continue;
      for (const [cat, v] of pr.apis) addApi(cat, v.evidence, pr.name);
    }
    const manifest = path.join(dir, 'PrivacyInfo.xcprivacy');
    extensions.push({
      name: e.name,
      dir: path.relative(projectDir, dir),
      kind: ext.NSExtensionPointIdentifier,
      apis,
      purposeUses: report.purposeUses,
      manifest: fs.existsSync(manifest) ? manifest : null,
      infoPlist: path.join(dir, 'Info.plist'),
      pods,
    });
  }
  return { app: app.apis.size || app.purposeUses.size ? app : null, extensions };
}

/** Expo local modules (modules/<name> with expo-module.config.json): linked into the app, but not in package.json. */
export function scanLocalModules(projectDir: string, pkg: { expo?: { autolinking?: { nativeModulesDir?: string } } }, customRules: LibraryRule[] = []): PackageReport[] {
  const base = path.resolve(projectDir, pkg.expo?.autolinking?.nativeModulesDir ?? 'modules');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: PackageReport[] = [];
  for (const e of entries) {
    const dir = path.join(base, e.name);
    if (!e.isDirectory() || !fs.existsSync(path.join(dir, 'expo-module.config.json'))) continue;
    const name = `${path.relative(projectDir, dir).split(path.sep).join('/')} (local module)`;
    const report = scanPackage(name, dir, customRules);
    report.origin = 'local-module';
    report.rule = ruleFor(path.relative(projectDir, dir).split(path.sep).join('/'), undefined, customRules, false) ?? ruleFor(e.name, undefined, customRules, false);
    out.push(report);
  }
  return out;
}

/**
 * react-native-permissions only compiles the permission handlers you enable (setup_permissions in the
 * Podfile, or iosPermissions in its Expo plugin), so only those count.
 */
function limitPermissionHandlers(projectDir: string, packages: PackageReport[]) {
  const rnp = packages.find((p) => p.name === 'react-native-permissions');
  if (!rnp) return;
  let enabled: Set<string> | null = null;
  try { enabled = podfilePermissions(fs.readFileSync(path.join(projectDir, 'ios', 'Podfile'), 'utf8')); } catch { /* no Podfile */ }
  if (!enabled) {
    try {
      const json = JSON.parse(fs.readFileSync(path.join(projectDir, 'app.json'), 'utf8'));
      const entry = ((json.expo ?? json).plugins ?? []).find((p: unknown) => Array.isArray(p) && p[0] === 'react-native-permissions');
      if (entry && Array.isArray(entry[1]?.iosPermissions)) enabled = new Set(entry[1].iosPermissions);
    } catch { /* no app.json */ }
  }
  const allowed = enabled ?? new Set<string>();
  for (const [key, evidence] of rnp.purposeUses) {
    const kept = evidence.filter((ev) => ev.file.split(/[\\/]/).some((part) => allowed.has(part)));
    if (kept.length) rnp.purposeUses.set(key, kept);
    else rnp.purposeUses.delete(key);
  }
}
