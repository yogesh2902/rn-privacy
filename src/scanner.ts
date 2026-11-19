import fs from 'node:fs';
import path from 'node:path';
import { findApiSymbols } from './apis.js';
import { manifestApis, manifestCollected, readManifest } from './manifest.js';
import { findRule } from './rules.js';
import type { ApiCategory, ApiEvidence, PackageReport, ScanResult } from './types.js';
import { validateManifest } from './validate.js';
import { libraryManifestPath, readAndroidManifest, readAppAndroid } from './android.js';
import { isAppleBinary, scanBinary, SKIP_SLICE } from './binary.js';

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

export function scanPackage(name: string, pkgDir: string): PackageReport {
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
    rule: findRule(name, pkg.version),
    manifestIssues: [],
    declaresTracking: false,
    trackingDomains: [],
    issuesUrl: issuesUrl(pkg),
    androidPermissions: readAndroidManifest(libraryManifestPath(pkgDir))?.uses ?? [],
    unscannedBinaries: [],
  };
  if (!report.hasIosNative) return report;

  const add = (category: ApiCategory, reasons: string[], evidence: ApiEvidence) => {
    let entry = report.apis.get(category);
    if (!entry) report.apis.set(category, (entry = { reasons: new Set(), evidence: [] }));
    for (const r of reasons) entry.reasons.add(r);
    entry.evidence.push(evidence);
  };

  const files = walk(pkgDir);
  report.hasBinaryFramework = files.binaryFramework;
  for (const file of files.manifests) readLibraryManifest(report, file, path.relative(pkgDir, file));
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
      add(hit.category, [], { kind: 'source', file: path.relative(pkgDir, file), symbol: hit.symbol });
    }
  }
  scanBinaries(report, files.binaries, pkgDir);
  return report;
}

/** Add required reason APIs found in prebuilt binaries. */
function scanBinaries(report: PackageReport, files: string[], baseDir: string) {
  for (const file of files) {
    if (!isAppleBinary(file)) continue;
    const rel = path.relative(baseDir, file);
    const hits = scanBinary(file);
    if (!hits) {
      report.unscannedBinaries.push(rel);
      continue;
    }
    for (const hit of hits) {
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

  const result: ScanResult = {
    projectDir,
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
    const report = scanPackage(name, dir);
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
  result.packages.push(...scanPods(projectDir));
  return result;
}

/**
 * Native SDKs wrapped by RN libraries (Firebase, Google Mobile Ads...) are
 * downloaded by CocoaPods into ios/Pods, not node_modules. After `pod install`
 * we read the privacy manifests those SDKs ship.
 */
export function scanPods(projectDir: string): PackageReport[] {
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
    if (!manifests.length && !binaries.length) continue;
    const report: PackageReport = {
      name: `${pod.name} (CocoaPods)`,
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
    };
    for (const file of manifests) readLibraryManifest(report, file, path.relative(podsDir, file));
    scanBinaries(report, binaries, podsDir);
    // A pod with neither a manifest nor any required reason API has nothing to report.
    if (!manifests.length && !report.apis.size && !report.unscannedBinaries.length) continue;
    reports.push(report);
  }
  return reports;
}
