import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Analysis } from './analyze.js';
import { trackingDomains } from './analyze.js';
import { API_LABELS } from './apis.js';
import { DATA_TYPES } from './types.js';
import type { ApiCategory, DataType, ScanResult } from './types.js';
import { SENSITIVE_PERMISSIONS } from './android.js';
import { PURPOSE_KEYS } from './purpose.js';

/**
 * A privacy snapshot: what your dependencies need, in a small file you commit
 * (privacy-snapshot.json). When a pull request changes dependencies, the snapshot changes too,
 * so the privacy impact shows up in code review. It has no dates or absolute paths, so it only
 * changes when something real changes.
 */
export const SNAPSHOT_FILE = 'privacy-snapshot.json';

export interface Snapshot {
  /** Format version of this file. */
  version: 1;
  apis: Record<string, { reasons: string[]; packages: string[] }>;
  data: Record<string, { purposes: string[]; linked: boolean; tracking: boolean; packages: string[]; conditional: string[] }>;
  trackingDomains: string[];
  android: Record<string, string[]>;
  /** Native libraries and their versions. */
  libraries: Record<string, string>;
  /** Info.plist purpose strings the code asks for, and who asks. Missing in snapshots before 0.5.0. */
  purposeStrings?: Record<string, string[]>;
}

const sorted = <T>(list: T[]) => [...list].sort();
const sortedRecord = <T>(entries: [string, T][]) => Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));

export function buildSnapshot(scan: ScanResult, a: Analysis): Snapshot {
  return {
    version: 1,
    apis: sortedRecord(a.apis.map((x) => [x.category, { reasons: sorted(x.reasons), packages: sorted(x.packages) }])),
    data: sortedRecord(a.data.map((d) => [d.type, {
      purposes: sorted([...d.purposes]),
      linked: d.linked,
      tracking: d.tracking,
      packages: sorted(d.packages),
      conditional: sorted([...new Set(d.conditional.map((c) => c.pkg))]),
    }])),
    trackingDomains: trackingDomains(a),
    android: sortedRecord(a.android.map((p) => [p.permission, sorted(p.sources)])),
    purposeStrings: sortedRecord(a.purposes.map((p) => [p.key, sorted(p.packages)])),
    libraries: sortedRecord(scan.packages.filter((p) => p.hasIosNative || p.androidPermissions.length || p.rule).map((p) => [p.name, p.version])),
  };
}

export function snapshotText(s: Snapshot): string {
  return JSON.stringify(s, null, 2) + '\n';
}

/**
 * Read the base snapshot: a file path, or `<git ref>` to read privacy-snapshot.json from that
 * commit or branch (for example origin/main).
 */
export function loadBaseSnapshot(projectDir: string, base: string | undefined): { snapshot: Snapshot | null; label: string; error?: string } {
  const file = path.resolve(projectDir, base ?? SNAPSHOT_FILE);
  if (!base || fs.existsSync(file)) {
    const label = path.relative(projectDir, file) || SNAPSHOT_FILE;
    if (!fs.existsSync(file)) return { snapshot: null, label, error: `No ${label} yet. Run \`rn-privacy snapshot\` and commit it.` };
    return parse(fs.readFileSync(file, 'utf8'), label);
  }
  const label = `${base}:${SNAPSHOT_FILE}`;
  try {
    // "<ref>:./file" is relative to the current directory, so this works inside monorepos.
    const text = execFileSync('git', ['show', `${base}:./${SNAPSHOT_FILE}`], { cwd: projectDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return parse(text, label);
  } catch {
    return { snapshot: null, label, error: `Could not read ${SNAPSHOT_FILE} from "${base}". Is it a file, or a git branch or commit that has the snapshot?` };
  }
}

function parse(text: string, label: string): { snapshot: Snapshot | null; label: string; error?: string } {
  try {
    const s = JSON.parse(text) as Snapshot;
    if (s?.version !== 1) return { snapshot: null, label, error: `${label} is not an rn-privacy snapshot.` };
    return { snapshot: s, label };
  } catch {
    return { snapshot: null, label, error: `${label} is not valid JSON.` };
  }
}

// ------------------------------------------------------------------ diff

export interface Change {
  kind: 'added' | 'removed' | 'changed';
  label: string;
  /** Libraries involved, or what changed. */
  detail: string;
}

export interface SnapshotDiff {
  apis: Change[];
  data: Change[];
  trackingDomains: Change[];
  android: Change[];
  purposeStrings: Change[];
  libraries: Change[];
}

export function diffSnapshots(base: Snapshot, current: Snapshot): SnapshotDiff {
  const diff: SnapshotDiff = { apis: [], data: [], trackingDomains: [], android: [], purposeStrings: [], libraries: [] };
  const list = (xs: string[]) => xs.join(', ');
  const delta = (before: string[], after: string[]) =>
    [...after.filter((x) => !before.includes(x)).map((x) => `+${x}`), ...before.filter((x) => !after.includes(x)).map((x) => `-${x}`)];

  compare(base.apis, current.apis, (k) => API_LABELS[k as ApiCategory] ?? k, diff.apis, (b, c) => {
    const parts = [];
    const r = delta(b.reasons, c.reasons);
    if (r.length) parts.push(`reasons ${r.join(' ')}`);
    const p = delta(b.packages, c.packages);
    if (p.length) parts.push(`used by ${p.join(' ')}`);
    return parts.join('; ');
  }, (v) => list(v.packages));

  compare(base.data, current.data, (k) => DATA_TYPES[k as DataType]?.label ?? k, diff.data, (b, c) => {
    const parts = [];
    const pu = delta(b.purposes, c.purposes);
    if (pu.length) parts.push(`purposes ${pu.join(' ')}`);
    if (b.linked !== c.linked) parts.push(c.linked ? 'now linked to the user' : 'no longer linked');
    if (b.tracking !== c.tracking) parts.push(c.tracking ? 'now used for tracking' : 'no longer used for tracking');
    const p = delta([...b.packages, ...b.conditional], [...c.packages, ...c.conditional]);
    if (p.length) parts.push(`by ${p.join(' ')}`);
    return parts.join('; ');
  }, (v) => list([...v.packages, ...v.conditional.map((x) => `${x}*`)]));

  for (const d of current.trackingDomains) if (!base.trackingDomains.includes(d)) diff.trackingDomains.push({ kind: 'added', label: d, detail: '' });
  for (const d of base.trackingDomains) if (!current.trackingDomains.includes(d)) diff.trackingDomains.push({ kind: 'removed', label: d, detail: '' });

  compare(base.android, current.android, (k) => SENSITIVE_PERMISSIONS[k]?.label ?? k, diff.android, (b, c) => {
    const p = delta(b, c);
    return p.length ? `from ${p.join(' ')}` : '';
  }, (v) => list(v));

  // Snapshots written before 0.5.0 have no purpose strings: do not report them all as new.
  if (base.purposeStrings) {
    compare(base.purposeStrings, current.purposeStrings ?? {}, (k) => `${k} (${PURPOSE_KEYS[k]?.label ?? k})`, diff.purposeStrings, (b, c) => {
      const p = delta(b, c);
      return p.length ? `asked for by ${p.join(' ')}` : '';
    }, (v) => `asked for by ${list(v)}`);
  }

  compare(base.libraries, current.libraries, (k) => k, diff.libraries, (b, c) => (b !== c ? `${b} → ${c}` : ''), (v) => v);
  return diff;
}

function compare<T>(
  base: Record<string, T>,
  current: Record<string, T>,
  label: (key: string) => string,
  out: Change[],
  changed: (before: T, after: T) => string,
  describe: (value: T) => string,
) {
  for (const key of Object.keys(current)) {
    if (!(key in base)) out.push({ kind: 'added', label: label(key), detail: describe(current[key]) });
    else {
      const detail = changed(base[key], current[key]);
      if (detail) out.push({ kind: 'changed', label: label(key), detail });
    }
  }
  for (const key of Object.keys(base)) if (!(key in current)) out.push({ kind: 'removed', label: label(key), detail: describe(base[key]) });
}

export function changeCount(d: SnapshotDiff): number {
  return d.apis.length + d.data.length + d.trackingDomains.length + d.android.length + d.purposeStrings.length + d.libraries.length;
}

/** Changes that matter for the stores (everything except library versions). */
export function privacyChangeCount(d: SnapshotDiff): number {
  return changeCount(d) - d.libraries.length;
}

export function formatDiff(d: SnapshotDiff, against: string, paint: { green: (s: string) => string; red: (s: string) => string; yellow: (s: string) => string; bold: (s: string) => string; dim: (s: string) => string }): string {
  const lines = [paint.bold('rn-privacy diff') + paint.dim(`  (against ${against})`), ''];
  const sign = { added: paint.green('+'), removed: paint.red('-'), changed: paint.yellow('~') };
  const section = (title: string, changes: Change[]) => {
    if (!changes.length) return;
    lines.push(paint.bold(title));
    for (const c of changes) lines.push(`  ${sign[c.kind]} ${c.label.padEnd(24)} ${paint.dim(c.detail)}`.trimEnd());
    lines.push('');
  };
  section('Required reason APIs (Apple privacy manifest)', d.apis);
  section('Data collected by your libraries', d.data);
  section('Tracking domains', d.trackingDomains);
  section('Android permissions', d.android);
  section('Info.plist purpose strings', d.purposeStrings);
  section('Native libraries', d.libraries);
  if (!changeCount(d)) lines.push(paint.green('No privacy changes.'));
  else if (!privacyChangeCount(d)) lines.push(paint.green('Only library versions changed: no privacy changes.'));
  else lines.push(paint.dim('Review these, update your manifest and store answers, then run `rn-privacy snapshot` to accept them.'));
  return lines.join('\n');
}
