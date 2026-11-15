import fs from 'node:fs';
import path from 'node:path';
import { findApiSymbols } from './apis.js';
import { manifestApis, manifestCollected, readManifest } from './manifest.js';
import { findRule } from './rules.js';
import type { ApiCategory, ApiEvidence, PackageReport, ScanResult } from './types.js';

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
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
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
}

function walk(pkgDir: string): WalkResult {
  const result: WalkResult = { manifests: [], sources: [], binaryFramework: false };
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
      const rel = path.relative(pkgDir, full).split(path.sep);
      const inAppleDir = rel.some((p) => p === 'ios' || p === 'apple' || p === 'macos');
      if (APPLE_SOURCE.has(ext) || (C_SOURCE.has(ext) && inAppleDir)) result.sources.push(full);
    }
  }
  return result;
}

export function scanPackage(name: string, pkgDir: string): PackageReport {
  const pkg = readJson<PkgJson>(path.join(pkgDir, 'package.json')) ?? {};
  const report: PackageReport = {
    name,
    version: pkg.version ?? '?',
    hasIosNative: hasIosNative(pkgDir),
    shipsManifest: [],
    hasBinaryFramework: false,
    apis: new Map(),
    manifestCollected: [],
    rule: findRule(name),
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
  for (const file of files.manifests) {
    const m = readManifest(file);
    if (!m) continue;
    const rel = path.relative(pkgDir, file);
    report.shipsManifest.push(rel);
    for (const usage of manifestApis(m)) add(usage.category, usage.reasons, { kind: 'manifest', file: rel });
    report.manifestCollected.push(...manifestCollected(m));
  }
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
  return report;
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
    // Transitive packages only matter if they contain iOS native code or a known rule.
    if (direct || report.hasIosNative || report.rule) result.packages.push(report);
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
    const { manifests } = walk(podDir);
    if (!manifests.length) continue;
    const report: PackageReport = {
      name: `${pod.name} (CocoaPods)`,
      version: '-',
      hasIosNative: true,
      shipsManifest: [],
      hasBinaryFramework: false,
      apis: new Map(),
      manifestCollected: [],
    };
    for (const file of manifests) {
      const m = readManifest(file);
      if (!m) continue;
      const rel = path.relative(podsDir, file);
      report.shipsManifest.push(rel);
      for (const usage of manifestApis(m)) {
        let entry = report.apis.get(usage.category);
        if (!entry) report.apis.set(usage.category, (entry = { reasons: new Set(), evidence: [] }));
        for (const r of usage.reasons) entry.reasons.add(r);
        entry.evidence.push({ kind: 'manifest', file: rel });
      }
      report.manifestCollected.push(...manifestCollected(m));
    }
    reports.push(report);
  }
  return reports;
}
