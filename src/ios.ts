import fs from 'node:fs';
import path from 'node:path';
import { buildManifest, emptyManifest, mergeManifest, readManifest } from './manifest.js';
import type { MergeOptions, PrivacyManifest } from './manifest.js';
import type { ApiUsage, CollectedData } from './types.js';

export interface IosTarget {
  file: string;
  exists: boolean;
  /** false when the file exists but the Xcode project does not reference it. */
  inXcodeProject: boolean | null;
}

/** Locate the app's own PrivacyInfo.xcprivacy (not the ones inside Pods). */
export function findIosManifest(projectDir: string): IosTarget | null {
  const iosDir = path.join(projectDir, 'ios');
  if (!fs.existsSync(iosDir)) return null;
  const entries = fs.readdirSync(iosDir, { withFileTypes: true });
  const xcodeproj = entries.find((e) => e.isDirectory() && e.name.endsWith('.xcodeproj'));
  const pbxproj = xcodeproj ? path.join(iosDir, xcodeproj.name, 'project.pbxproj') : null;
  const referenced = pbxproj && fs.existsSync(pbxproj) ? fs.readFileSync(pbxproj, 'utf8').includes('PrivacyInfo.xcprivacy') : null;

  for (const e of entries) {
    if (!e.isDirectory() || ['Pods', 'build'].includes(e.name) || e.name.endsWith('.xcodeproj') || e.name.endsWith('.xcworkspace')) continue;
    const candidate = path.join(iosDir, e.name, 'PrivacyInfo.xcprivacy');
    if (fs.existsSync(candidate)) return { file: candidate, exists: true, inXcodeProject: referenced };
  }
  const rootCandidate = path.join(iosDir, 'PrivacyInfo.xcprivacy');
  if (fs.existsSync(rootCandidate)) return { file: rootCandidate, exists: true, inXcodeProject: referenced };

  const appName = xcodeproj?.name.replace(/\.xcodeproj$/, '');
  const appDir = appName && fs.existsSync(path.join(iosDir, appName)) ? path.join(iosDir, appName) : iosDir;
  return { file: path.join(appDir, 'PrivacyInfo.xcprivacy'), exists: false, inXcodeProject: false };
}

export function planIosManifest(target: IosTarget, apis: ApiUsage[], collected: CollectedData[], opts: MergeOptions = {}) {
  const existing = target.exists ? readManifest(target.file) : emptyManifest();
  if (existing === null) throw new Error(`Could not parse ${target.file}. Fix the file or move it away, then run again.`);
  const { manifest, added } = mergeManifest(existing, apis, collected, opts);
  return { manifest, added, content: buildManifest(manifest) };
}

export interface ExpoConfig {
  /** app.json, if present. */
  appJson: string | null;
  /** app.config.{js,ts,...}, if present. rn-privacy never runs it. */
  dynamic: string | null;
  /** The dynamic config spreads the app.json config (`({ config }) => ({ ...config })`), so editing app.json works. */
  dynamicExtendsAppJson: boolean;
  /** The dynamic config text mentions privacyManifests itself. */
  dynamicMentionsPrivacy: boolean;
  /** The rn-privacy config plugin is enabled, so prebuild generates the manifest. */
  usesPlugin: boolean;
}

export function findExpoConfig(projectDir: string): ExpoConfig | null {
  const dyn = ['app.config.ts', 'app.config.js', 'app.config.mjs', 'app.config.cjs']
    .map((f) => path.join(projectDir, f))
    .find((f) => fs.existsSync(f)) ?? null;
  const appJson = path.join(projectDir, 'app.json');
  const cfg: ExpoConfig = {
    appJson: fs.existsSync(appJson) ? appJson : null,
    dynamic: dyn,
    dynamicExtendsAppJson: false,
    dynamicMentionsPrivacy: false,
    usesPlugin: false,
  };
  if (cfg.appJson) {
    try {
      const json = JSON.parse(fs.readFileSync(cfg.appJson, 'utf8'));
      const plugins: unknown[] = (json.expo ?? json)?.plugins ?? [];
      cfg.usesPlugin = plugins.some((p) => (Array.isArray(p) ? p[0] : p) === 'rn-privacy');
    } catch {
      // Invalid app.json: other commands report it.
    }
  }
  if (dyn) {
    const text = fs.readFileSync(dyn, 'utf8');
    cfg.dynamicExtendsAppJson = /\.\.\.\s*config\b/.test(text);
    cfg.dynamicMentionsPrivacy = text.includes('privacyManifests');
    if (/['"`]rn-privacy['"`]/.test(text)) cfg.usesPlugin = true;
  }
  return cfg.appJson || cfg.dynamic ? cfg : null;
}

/** Where `ios --write` should put the manifest for an Expo project. */
export function expoWriteTarget(cfg: ExpoConfig): { file: string; note?: string } | null {
  if (!cfg.appJson) return null;
  if (!cfg.dynamic) return { file: cfg.appJson };
  if (cfg.dynamicExtendsAppJson && !cfg.dynamicMentionsPrivacy) {
    return { file: cfg.appJson, note: `${path.basename(cfg.dynamic)} spreads the app.json config, so the manifest goes into app.json.` };
  }
  return null;
}

interface AppJson {
  expo?: { ios?: { privacyManifests?: PrivacyManifest; [k: string]: unknown }; [k: string]: unknown };
  [k: string]: unknown;
}

/** Merge into expo.ios.privacyManifests in app.json. Returns the new file text. */
export function planExpoAppJson(file: string, apis: ApiUsage[], collected: CollectedData[], opts: MergeOptions = {}) {
  const json = JSON.parse(fs.readFileSync(file, 'utf8')) as AppJson;
  const root = json.expo ? json.expo : (json as NonNullable<AppJson['expo']>);
  root.ios ??= {};
  const { manifest, added } = mergeManifest(root.ios.privacyManifests ?? {}, apis, collected, opts);
  root.ios.privacyManifests = manifest;
  return { added, content: JSON.stringify(json, null, 2) + '\n', manifest };
}

export function expoSnippet(apis: ApiUsage[], collected: CollectedData[], opts: MergeOptions = {}): string {
  const { manifest } = mergeManifest({}, apis, collected, opts);
  return JSON.stringify({ expo: { ios: { privacyManifests: manifest } } }, null, 2);
}
