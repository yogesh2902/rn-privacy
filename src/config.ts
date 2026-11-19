import fs from 'node:fs';
import path from 'node:path';
import { DATA_TYPES, PLAY_PURPOSES, PURPOSES } from './types.js';
import type { CollectedData, DataType, DeviceAccess, LibraryRule, PlayCollected, PlayPurpose, Purpose } from './types.js';
import { isValidRange } from './semver.js';

/**
 * The project's own rules, for SDKs rn-privacy does not know (in-house SDKs, private packages,
 * CocoaPods or Swift packages) and to replace a built-in rule. A rule without `packages`
 * describes data the app itself collects, for example the email address for sign-in.
 */
export const CONFIG_FILE = 'rn-privacy.config.json';

export interface ProjectConfig {
  /** Path of the config file. */
  file: string;
  rules: LibraryRule[];
}

export class ConfigError extends Error {
  constructor(file: string, public problems: string[]) {
    super(`${path.basename(file)} has ${problems.length === 1 ? 'a problem' : `${problems.length} problems`}:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

const RULE_KEYS = new Set(['packages', 'name', 'versions', 'collects', 'android', 'accesses', 'sources', 'notes']);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const list = (keys: string[]) => keys.map((k) => `"${k}"`).join(', ');

/** Read and check rn-privacy.config.json in the project folder. Returns null when there is none. */
export function loadConfig(projectDir: string): ProjectConfig | null {
  const file = path.join(projectDir, CONFIG_FILE);
  if (!fs.existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ConfigError(file, [`Not valid JSON: ${err instanceof Error ? err.message : String(err)}`]);
  }
  return { file, rules: parseConfig(raw, file) };
}

/** Check a config object and turn it into rules. Throws a ConfigError listing every problem. */
export function parseConfig(raw: unknown, file = CONFIG_FILE): LibraryRule[] {
  const problems: string[] = [];
  if (!isObject(raw)) throw new ConfigError(file, ['The file must contain a JSON object, like { "rules": [] }.']);
  for (const key of Object.keys(raw)) if (key !== 'rules' && key !== '$schema') problems.push(`Unknown setting "${key}". Use "rules".`);
  if (raw.rules !== undefined && !Array.isArray(raw.rules)) problems.push('"rules" must be a list.');
  const rules: LibraryRule[] = [];
  const origin = path.basename(file);

  (Array.isArray(raw.rules) ? raw.rules : []).forEach((r: unknown, i: number) => {
    const at = `rules[${i}]`;
    if (!isObject(r)) return void problems.push(`${at} must be an object.`);
    const label = typeof r.name === 'string' && r.name.trim() ? `${at} (${r.name})` : at;
    for (const key of Object.keys(r)) if (!RULE_KEYS.has(key)) problems.push(`${label}: unknown field "${key}". Use ${list([...RULE_KEYS])}.`);
    if (typeof r.name !== 'string' || !r.name.trim()) problems.push(`${at}: "name" is required (for example the SDK name).`);

    let packages: string[] = [];
    if (r.packages !== undefined) {
      if (!Array.isArray(r.packages) || !r.packages.length || r.packages.some((p) => typeof p !== 'string' || !p.trim())) {
        problems.push(`${label}: "packages" must be a non-empty list of package names. Leave it out for data your app itself collects.`);
      } else packages = r.packages as string[];
    }
    if (r.versions !== undefined) {
      if (!packages.length) problems.push(`${label}: "versions" only works with "packages".`);
      else if (typeof r.versions !== 'string' || !isValidRange(r.versions)) problems.push(`${label}: "versions" is not a version range rn-privacy understands (for example ">=6.0.0" or "^5.2.0 || ^6.0.0").`);
    }
    const sources = r.sources === undefined ? [] : r.sources;
    if (!Array.isArray(sources) || sources.some((s) => typeof s !== 'string')) problems.push(`${label}: "sources" must be a list of links.`);
    if (r.notes !== undefined && typeof r.notes !== 'string') problems.push(`${label}: "notes" must be text.`);

    const collects = r.collects === undefined ? undefined : collected(r.collects, `${label}.collects`, problems);
    const accesses = r.accesses === undefined ? undefined : deviceAccess(r.accesses, `${label}.accesses`, problems);
    let android: LibraryRule['android'];
    if (r.android !== undefined) {
      const a = r.android;
      if (!isObject(a)) problems.push(`${label}.android must be an object, like { "collects": [] }.`);
      else {
        for (const key of Object.keys(a)) if (!['collects', 'sources', 'notes'].includes(key)) problems.push(`${label}.android: unknown field "${key}". Use "collects", "sources", "notes".`);
        const aSources = a.sources === undefined ? [] : a.sources;
        if (!Array.isArray(aSources) || aSources.some((s) => typeof s !== 'string')) problems.push(`${label}.android: "sources" must be a list of links.`);
        android = { collects: playCollected(a.collects, `${label}.android.collects`, problems), sources: aSources as string[], notes: a.notes as string | undefined };
      }
    }
    if (collects === undefined && accesses === undefined && android === undefined) {
      problems.push(`${label}: add "collects" (iOS and Android), "android" (Android only) or "accesses". Use "collects": [] for a package that collects nothing.`);
    }
    rules.push({
      packages,
      name: String(r.name ?? ''),
      versions: r.versions as string | undefined,
      collects,
      android,
      accesses,
      sources: sources as string[],
      notes: r.notes as string | undefined,
      origin,
    });
  });

  if (problems.length) throw new ConfigError(file, problems);
  return rules;
}

function dataType(v: unknown, at: string, problems: string[]): DataType | null {
  if (typeof v === 'string' && v in DATA_TYPES) return v as DataType;
  problems.push(`${at}: "type" ${JSON.stringify(v)} is not a data type. Use one of ${list(Object.keys(DATA_TYPES))}.`);
  return null;
}

function collected(v: unknown, at: string, problems: string[]): CollectedData[] {
  if (!Array.isArray(v)) return void problems.push(`${at} must be a list.`), [];
  const out: CollectedData[] = [];
  v.forEach((item: unknown, i: number) => {
    const here = `${at}[${i}]`;
    if (!isObject(item)) return void problems.push(`${here} must be an object.`);
    for (const key of Object.keys(item)) if (!['type', 'purposes', 'linked', 'tracking', 'conditional'].includes(key)) problems.push(`${here}: unknown field "${key}". Use "type", "purposes", "linked", "tracking", "conditional".`);
    const type = dataType(item.type, here, problems);
    const purposes = Array.isArray(item.purposes) ? item.purposes : [];
    if (!purposes.length) problems.push(`${here}: "purposes" must list at least one of ${list(Object.keys(PURPOSES))} (Apple requires a purpose).`);
    for (const p of purposes) if (typeof p !== 'string' || !(p in PURPOSES)) problems.push(`${here}: ${JSON.stringify(p)} is not a purpose. Use one of ${list(Object.keys(PURPOSES))}.`);
    for (const key of ['linked', 'tracking'] as const) {
      if (typeof item[key] !== 'boolean') problems.push(`${here}: "${key}" must be true or false (${key === 'linked' ? 'is the data linked to the user\'s identity?' : 'is it used for tracking, as App Tracking Transparency defines it?'}).`);
    }
    if (item.conditional !== undefined && typeof item.conditional !== 'string') problems.push(`${here}: "conditional" must be text, for example "Only if you call identify()".`);
    if (type) out.push({ type, purposes: purposes as Purpose[], linked: item.linked === true, tracking: item.tracking === true, conditional: item.conditional as string | undefined });
  });
  return out;
}

function playCollected(v: unknown, at: string, problems: string[]): PlayCollected[] {
  if (!Array.isArray(v)) return void problems.push(`${at} must be a list.`), [];
  const out: PlayCollected[] = [];
  v.forEach((item: unknown, i: number) => {
    const here = `${at}[${i}]`;
    if (!isObject(item)) return void problems.push(`${here} must be an object.`);
    for (const key of Object.keys(item)) if (!['type', 'purposes', 'shared', 'conditional'].includes(key)) problems.push(`${here}: unknown field "${key}". Use "type", "purposes", "shared", "conditional".`);
    const type = dataType(item.type, here, problems);
    const purposes = item.purposes === undefined ? [] : item.purposes;
    if (!Array.isArray(purposes)) problems.push(`${here}: "purposes" must be a list.`);
    else for (const p of purposes) if (typeof p !== 'string' || !(p in PLAY_PURPOSES)) problems.push(`${here}: ${JSON.stringify(p)} is not a Google Play purpose. Use one of ${list(Object.keys(PLAY_PURPOSES))}.`);
    if (item.shared !== undefined && typeof item.shared !== 'boolean') problems.push(`${here}: "shared" must be true or false.`);
    if (item.conditional !== undefined && typeof item.conditional !== 'string') problems.push(`${here}: "conditional" must be text.`);
    if (type) out.push({ type, purposes: (Array.isArray(purposes) ? purposes : []) as PlayPurpose[], shared: item.shared === true || undefined, conditional: item.conditional as string | undefined });
  });
  return out;
}

function deviceAccess(v: unknown, at: string, problems: string[]): DeviceAccess[] {
  if (!Array.isArray(v)) return void problems.push(`${at} must be a list.`), [];
  const out: DeviceAccess[] = [];
  v.forEach((item: unknown, i: number) => {
    const here = `${at}[${i}]`;
    if (!isObject(item)) return void problems.push(`${here} must be an object, like { "type": "contacts" }.`);
    const type = dataType(item.type, here, problems);
    if (type) out.push({ type, note: typeof item.note === 'string' ? item.note : undefined });
  });
  return out;
}
