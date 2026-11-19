import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import plist from 'plist';

/**
 * Swift Package Manager dependencies of the iOS app.
 *
 * Xcode records the resolved packages in Package.resolved (inside the .xcworkspace or the
 * .xcodeproj) and downloads them to <DerivedData>/<App>-<hash>/SourcePackages: `checkouts/<repo>`
 * for the code and `artifacts/<identity>/<target>/*.xcframework` for binary targets.
 */
export interface SwiftPackage {
  /** SwiftPM's identity: the lowercased repository name. */
  identity: string;
  /** The repository name, as Xcode names the checkout folder. */
  name: string;
  location?: string;
  version: string;
}

export interface SwiftPackages {
  /** Package.resolved files found (relative to the project). */
  resolvedFiles: string[];
  packages: SwiftPackage[];
  /** The SourcePackages folder the packages were downloaded to, if found. */
  sourcePackagesDir: string | null;
}

const repoName = (location: string) => location.replace(/\/+$/, '').replace(/\.git$/, '').split(/[/:]/).pop() ?? location;

/** Read Package.resolved (format 1, or 2 and 3). */
export function parsePackageResolved(text: string): SwiftPackage[] {
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const pins: any[] = Array.isArray(data?.pins) ? data.pins : Array.isArray(data?.object?.pins) ? data.object.pins : [];
  const out: SwiftPackage[] = [];
  for (const pin of pins) {
    const location: string | undefined = pin.location ?? pin.repositoryURL;
    const name = location ? repoName(location) : String(pin.package ?? pin.identity ?? '');
    const identity = String(pin.identity ?? name).toLowerCase();
    if (!identity) continue;
    const state = pin.state ?? {};
    const version = state.version ?? (state.branch ? `${state.branch}@${String(state.revision ?? '').slice(0, 7)}` : String(state.revision ?? '?').slice(0, 7));
    out.push({ identity, name, location, version: String(version) });
  }
  return out;
}

/** Remote package references in an Xcode project, for projects whose packages were never resolved. */
export function pbxprojPackages(text: string): SwiftPackage[] {
  if (!text.includes('XCRemoteSwiftPackageReference')) return [];
  const out: SwiftPackage[] = [];
  for (const m of text.matchAll(/repositoryURL\s*=\s*"?([^";\s]+)"?\s*;/g)) {
    const name = repoName(m[1]);
    if (!out.some((p) => p.identity === name.toLowerCase())) out.push({ identity: name.toLowerCase(), name, location: m[1], version: '?' });
  }
  return out;
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** The DerivedData folder Xcode uses for this workspace or project. */
function derivedDataFor(workspaces: string[]): string | null {
  const root = process.env.RN_PRIVACY_DERIVED_DATA ?? path.join(os.homedir(), 'Library', 'Developer', 'Xcode', 'DerivedData');
  const wanted = new Set(workspaces.map((w) => {
    try { return fs.realpathSync(w); } catch { return path.resolve(w); }
  }));
  let best: { dir: string; time: number } | null = null;
  for (const entry of listDir(root)) {
    const dir = path.join(root, entry);
    if (!fs.existsSync(path.join(dir, 'SourcePackages'))) continue;
    let info: any;
    try {
      info = plist.parse(fs.readFileSync(path.join(dir, 'info.plist'), 'utf8'));
    } catch {
      continue;
    }
    const ws = typeof info?.WorkspacePath === 'string' ? info.WorkspacePath : '';
    let real = ws;
    try { real = fs.realpathSync(ws); } catch { /* moved or deleted */ }
    if (!wanted.has(real) && !wanted.has(ws)) continue;
    const time = fs.statSync(path.join(dir, 'SourcePackages')).mtimeMs;
    if (!best || time > best.time) best = { dir: path.join(dir, 'SourcePackages'), time };
  }
  return best?.dir ?? null;
}

/** Find the app's Swift packages and where Xcode downloaded them. */
export function findSwiftPackages(projectDir: string): SwiftPackages {
  const iosDir = path.join(projectDir, 'ios');
  const entries = listDir(iosDir);
  const workspaces = entries.filter((e) => e.endsWith('.xcworkspace')).map((e) => path.join(iosDir, e));
  const projects = entries.filter((e) => e.endsWith('.xcodeproj')).map((e) => path.join(iosDir, e));
  const resolved = [
    ...workspaces.map((w) => path.join(w, 'xcshareddata', 'swiftpm', 'Package.resolved')),
    ...projects.map((p) => path.join(p, 'project.xcworkspace', 'xcshareddata', 'swiftpm', 'Package.resolved')),
    path.join(iosDir, 'Package.resolved'),
  ].filter((f) => fs.existsSync(f));

  const packages: SwiftPackage[] = [];
  const add = (list: SwiftPackage[]) => {
    for (const p of list) if (!packages.some((x) => x.identity === p.identity)) packages.push(p);
  };
  for (const file of resolved) add(parsePackageResolved(fs.readFileSync(file, 'utf8')));
  if (!resolved.length) {
    // Packages added in Xcode but never resolved: the names are still in the project files.
    for (const pbx of [...projects.map((p) => path.join(p, 'project.pbxproj')), path.join(iosDir, 'Pods', 'Pods.xcodeproj', 'project.pbxproj')]) {
      try {
        add(pbxprojPackages(fs.readFileSync(pbx, 'utf8')));
      } catch { /* no project */ }
    }
  }
  if (!packages.length) return { resolvedFiles: [], packages, sourcePackagesDir: null };

  // A folder chosen with -clonedSourcePackagesDirPath or -derivedDataPath, then Xcode's DerivedData.
  const local = [path.join(iosDir, 'SourcePackages'), path.join(iosDir, 'build', 'SourcePackages'), path.join(iosDir, 'DerivedData', 'SourcePackages')]
    .find((d) => fs.existsSync(path.join(d, 'checkouts')) || fs.existsSync(path.join(d, 'artifacts')));
  return {
    resolvedFiles: resolved.map((f) => path.relative(projectDir, f)),
    packages,
    sourcePackagesDir: local ?? derivedDataFor([...workspaces, ...projects]),
  };
}

/** The checkout and binary artifact folders of one package inside SourcePackages. */
export function packageDirs(sourcePackagesDir: string, pkg: SwiftPackage): string[] {
  const dirs: string[] = [];
  const checkouts = path.join(sourcePackagesDir, 'checkouts');
  const checkout = listDir(checkouts).find((e) => e === pkg.name || e.toLowerCase() === pkg.identity);
  if (checkout) dirs.push(path.join(checkouts, checkout));
  const artifacts = path.join(sourcePackagesDir, 'artifacts');
  const artifact = listDir(artifacts).find((e) => e !== 'extract' && e.toLowerCase() === pkg.identity);
  if (artifact) dirs.push(path.join(artifacts, artifact));
  return dirs;
}
