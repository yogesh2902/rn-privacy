import { analyze, toApiUsages, toCollected, trackingDomains } from './analyze.js';
import { mergeManifest } from './manifest.js';
import type { PrivacyManifest } from './manifest.js';
import { scanProject } from './scanner.js';
import { validateManifest } from './validate.js';

export interface RnPrivacyPluginOptions {
  /** Also declare data that is only collected in some setups (e.g. after Sentry.setUser()). */
  includeConditional?: boolean;
  /** Your app tracks users (App Tracking Transparency): set NSPrivacyTracking and add your libraries' tracking domains. */
  tracking?: boolean;
}

interface ExpoConfigLike {
  ios?: { privacyManifests?: PrivacyManifest; [key: string]: unknown };
  _internal?: { projectRoot?: string; [key: string]: unknown };
  [key: string]: unknown;
}

// Expo can evaluate the config several times in one run; scan each project once.
const cache = new Map<string, ReturnType<typeof analyze>>();

/**
 * Expo config plugin: `"plugins": ["rn-privacy"]` in app.json.
 *
 * On every prebuild it scans your dependencies and merges what they need into
 * `expo.ios.privacyManifests`. Expo then writes ios/<App>/PrivacyInfo.xcprivacy from it,
 * so the manifest can never fall behind your libraries. Entries you wrote yourself are kept:
 * it only adds.
 */
export default function withRnPrivacy<T extends ExpoConfigLike>(config: T, options: RnPrivacyPluginOptions = {}): T {
  const projectRoot = config._internal?.projectRoot ?? process.cwd();
  const existing = config.ios?.privacyManifests ?? {};

  const errors = validateManifest(existing).filter((p) => p.level === 'error');
  if (errors.length) {
    console.warn(
      `[rn-privacy] expo.ios.privacyManifests is invalid, so it was left unchanged:\n` +
        errors.map((e) => `  - ${e.message}`).join('\n'),
    );
    return config;
  }

  let analysis = cache.get(projectRoot);
  if (!analysis) {
    try {
      analysis = analyze(scanProject(projectRoot));
    } catch (err) {
      console.warn(`[rn-privacy] Could not scan ${projectRoot}: ${err instanceof Error ? err.message : err}`);
      return config;
    }
    cache.set(projectRoot, analysis);
  }

  const opts = options.tracking ? { tracking: { domains: trackingDomains(analysis) } } : {};
  const { manifest } = mergeManifest(existing, toApiUsages(analysis), toCollected(analysis, !!options.includeConditional), opts);
  return { ...config, ios: { ...config.ios, privacyManifests: manifest } };
}
