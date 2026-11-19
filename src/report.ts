import path from 'node:path';
import { API_LABELS, DEFAULT_REASONS } from './apis.js';
import { DATA_TYPES, PLAY_PURPOSES, PURPOSES } from './types.js';
import type { Analysis, DataFinding } from './analyze.js';
import { trackingDomains } from './analyze.js';
import { audit as runAudit, auditProblemCount, categoryList } from './audit.js';
import type { Audit, LibraryRef } from './audit.js';
import type { Purpose, ScanResult } from './types.js';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const c = { bold: paint(1), dim: paint(2), red: paint(31), green: paint(32), yellow: paint(33), cyan: paint(36) };

const purposeLabels = (ps: Purpose[], store: 'apple' | 'play') =>
  [...new Set(ps.map((p) => (store === 'apple' ? PURPOSES[p].label : PURPOSES[p].play)))].join(', ');

const allPackages = (d: DataFinding) => [...d.packages, ...d.conditional.map((x) => `${x.pkg}*`)];
/** Linked/tracking including setups where the data is only collected conditionally. */
const isLinked = (d: DataFinding) => d.linked || d.conditional.some((x) => x.item.linked);
const isTracking = (d: DataFinding) => d.tracking || d.conditional.some((x) => x.item.tracking);

// ------------------------------------------------------------------ console

export function formatScan(scan: ScanResult, a: Analysis): string {
  const lines: string[] = [];
  const native = scan.packages.filter((p) => p.hasIosNative);
  const own = scan.packages.filter((p) => p.rule?.origin).length;
  const ownText = scan.configFile ? `, ${own} using your rules` : '';
  lines.push(c.bold(`rn-privacy scan`) + c.dim(`  (${scan.projectType}, ${scan.packages.length} packages, ${native.length} with iOS native code${ownText})`), '');

  lines.push(c.bold('Required reason APIs (Apple privacy manifest)'));
  if (!a.apis.length) lines.push(c.dim('  None found.'));
  for (const api of a.apis) {
    const reason = api.defaultReason ? c.yellow(`${api.reasons[0]} (suggested, review it)`) : c.green(api.reasons.join(', '));
    lines.push(`  ${API_LABELS[api.category].padEnd(18)} ${reason}`);
    lines.push(c.dim(`  ${' '.repeat(18)} used by ${api.packages.join(', ')}`));
  }
  lines.push('');

  lines.push(c.bold(scan.configFile ? 'Data collected by your libraries and your rules' : 'Data collected by your libraries'));
  if (!a.data.length) lines.push(c.dim('  Nothing known. Libraries without a rule are not included: check them yourself, or describe them in rn-privacy.config.json.'));
  for (const d of a.data) {
    const flags = [isLinked(d) && 'linked to user', isTracking(d) && c.red('tracking')].filter(Boolean).join(', ');
    lines.push(`  ${DATA_TYPES[d.type].label.padEnd(22)} ${purposeLabels([...d.purposes, ...d.conditional.flatMap((x) => x.item.purposes)], 'apple')}${flags ? c.dim(` (${flags})`) : ''}`);
    if (d.packages.length) lines.push(c.dim(`  ${' '.repeat(22)} by ${d.packages.join(', ')}`));
    for (const cond of d.conditional) lines.push(c.dim(`  ${' '.repeat(22)} ${cond.pkg}: ${cond.condition}`));
  }
  lines.push('');

  if (a.access.length) {
    lines.push(c.bold('Sensitive data your app can read'), c.dim('  Declare it only if your app sends it off the device.'));
    for (const acc of a.access) lines.push(`  ${DATA_TYPES[acc.type].label.padEnd(22)} ${c.dim(`via ${acc.packages.join(', ')}`)}`);
    lines.push('');
  }

  if (a.android.length) {
    lines.push(c.bold('Android permissions'), c.dim('  Google Play: declare the data in Data safety if it leaves the device.'));
    for (const p of a.android) {
      lines.push(`  ${p.label.padEnd(22)} ${c.dim(`from ${p.sources.join(', ')}`)}`);
      if (p.note) lines.push(c.yellow(`  ${' '.repeat(22)} ${p.note}`));
    }
    if (!scan.android.mergedFile) lines.push(c.dim('  Build the Android app once to also see permissions added by Gradle dependencies (Google Play services...).'));
    lines.push('');
  }

  if (a.tracking.length) {
    lines.push(c.bold('Tracking declared by your libraries'));
    for (const t of a.tracking) {
      lines.push(`  ${t.pkg.padEnd(22)} ${t.domains.length ? t.domains.join(', ') : c.dim('no domains listed')}${t.declaresTracking ? '' : c.dim(' (tracking off)')}`);
    }
    lines.push(c.dim('  If your app tracks users (App Tracking Transparency), run `rn-privacy ios --write --tracking` to declare these.'), '');
  }

  const libAudit = runAudit(scan);
  const problems = auditProblemCount(libAudit);
  if (problems) {
    lines.push(c.bold('Library audit') + c.dim(`  ${problems} librar${problems === 1 ? 'y has' : 'ies have'} privacy manifest problems. Run \`rn-privacy audit\` for details.`), '');
  }

  const noManifest = native.filter((p) => !p.shipsManifest.length && p.apis.size);
  if (noManifest.length) {
    lines.push(c.bold('Native libraries without their own privacy manifest'));
    lines.push(c.dim('  rn-privacy found required reason APIs in their source, so your app manifest must cover them.'));
    if (!scan.packages.some((p) => p.name.endsWith('(CocoaPods)'))) {
      lines.push(c.dim('  Run `pod install` first: SDKs that come from CocoaPods (Firebase, AdMob...) are then scanned too.'));
    }
    for (const p of noManifest) lines.push(`  ${p.name}@${p.version}  ${c.dim([...p.apis.keys()].map((k) => API_LABELS[k]).join(', '))}`);
    lines.push('');
  }

  if (a.warnings.length) {
    lines.push(c.bold(c.yellow('Warnings')));
    for (const w of a.warnings) lines.push(`  ${c.yellow('!')} ${w.pkg ? c.bold(w.pkg) + ': ' : ''}${w.message}`);
    lines.push('');
  }

  lines.push(c.dim('Next: `rn-privacy ios` to update your privacy manifest, `rn-privacy report` for the store forms.'));
  lines.push(c.dim('These results are a starting point. Check each library\'s own docs before you submit.'));
  return lines.join('\n');
}

// -------------------------------------------------------------------- audit

const MAX_ISSUES = 5;

export function formatAudit(a: Audit): string {
  const lines: string[] = [];
  lines.push(c.bold('rn-privacy audit') + c.dim(`  (${a.nativePackages} native ${a.nativePackages === 1 ? 'library' : 'libraries'}, ${a.withManifest} ${a.withManifest === 1 ? 'ships' : 'ship'} a privacy manifest)`), '');
  const name = (r: LibraryRef) => c.bold(r.version && r.version !== '-' ? `${r.pkg}@${r.version}` : r.pkg);
  const reportTo = (r: LibraryRef) => r.issuesUrl && lines.push(c.dim(`    Report it: ${r.issuesUrl}`));

  if (a.invalid.length) {
    lines.push(c.red(c.bold(`✗ Invalid privacy manifest (${a.invalid.length})`)), c.dim('  Apple may reject or ignore these files.'));
    for (const r of a.invalid) {
      lines.push(`  ${name(r)}`);
      for (const i of r.issues.slice(0, MAX_ISSUES)) lines.push(`    ${c.dim(i.file + ':')} ${i.message}`);
      if (r.issues.length > MAX_ISSUES) lines.push(c.dim(`    ...and ${r.issues.length - MAX_ISSUES} more`));
      reportTo(r);
    }
    lines.push('');
  }

  if (a.undeclared.length) {
    lines.push(c.yellow(c.bold(`! Uses required reason APIs without a privacy manifest (${a.undeclared.length})`)));
    for (const r of a.undeclared) {
      lines.push(`  ${name(r)}  ${categoryList(r.categories)}`);
      if (r.evidence.length) lines.push(c.dim(`    found in ${r.evidence.join(', ')}`));
      reportTo(r);
    }
    lines.push('');
  }

  if (a.incomplete.length) {
    lines.push(c.yellow(c.bold(`! Privacy manifest misses APIs its code uses (${a.incomplete.length})`)));
    for (const r of a.incomplete) {
      lines.push(`  ${name(r)}  missing ${categoryList(r.missing)}`);
      if (r.evidence.length) lines.push(c.dim(`    found in ${r.evidence.join(', ')}`));
      reportTo(r);
    }
    lines.push('');
  }

  if (a.questionable.length) {
    lines.push(c.bold(`Possible mistakes (${a.questionable.length})`));
    for (const r of a.questionable) {
      lines.push(`  ${name(r)}`);
      for (const i of r.issues.slice(0, MAX_ISSUES)) lines.push(c.dim(`    ${i.file}: ${i.message}`));
    }
    lines.push('');
  }

  if (a.tracking.length) {
    lines.push(c.bold(`Tracking declared by libraries (${a.tracking.length})`));
    for (const r of a.tracking) lines.push(`  ${name(r)}  ${r.domains.length ? r.domains.join(', ') : c.dim('no domains listed')}`);
    lines.push('');
  }

  if (!auditProblemCount(a) && !a.questionable.length) lines.push(c.green('✓ No problems found in your libraries\' privacy manifests.'), '');
  else {
    lines.push(c.dim('Your app is still covered: rn-privacy adds what these libraries use to your app\'s own manifest.'));
    lines.push(c.dim('Static analysis can be wrong: check the file before you report it. A report helps every app using the library.'));
  }
  return lines.join('\n');
}

// ----------------------------------------------------------------- markdown

export function formatMarkdown(scan: ScanResult, a: Analysis): string {
  const out: string[] = [];
  const date = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local time
  out.push('# Store privacy report', '', `Generated by rn-privacy on ${date} for a ${scan.projectType} project.`, '');
  out.push(
    '> This report is a starting point, not legal advice. It only knows about the libraries in its rules database and',
    '> cannot see what your own code or your backend does with data (describe that in rn-privacy.config.json). Check every item, and the vendor links at the end,',
    '> before you fill in the store forms. Items marked `*` are only collected in some setups.',
    '',
  );

  // Apple ----------------------------------------------------------
  out.push('## App Store Connect: App Privacy', '');
  const groups: [string, (d: DataFinding) => boolean][] = [
    ['Data used to track you', (d) => isTracking(d)],
    ['Data linked to you', (d) => !isTracking(d) && isLinked(d)],
    ['Data not linked to you', (d) => !isTracking(d) && !isLinked(d)],
  ];
  for (const [title, pick] of groups) {
    const rows = a.data.filter(pick);
    if (!rows.length) continue;
    out.push(`### ${title}`, '', '| Data type | Purposes | Collected by |', '| --- | --- | --- |');
    for (const d of rows) {
      out.push(`| ${DATA_TYPES[d.type].label} | ${purposeLabels([...d.purposes, ...d.conditional.flatMap((x) => x.item.purposes)], 'apple')} | ${allPackages(d).join(', ')} |`);
    }
    out.push('');
  }
  if (!a.data.length) out.push('No data collection found in known libraries.', '');

  // Play -----------------------------------------------------------
  out.push('## Google Play Console: Data safety', '');
  out.push('Tip: export the Data safety form to CSV in Play Console and run `npx rn-privacy play data_safety.csv -o filled.csv` to fill these answers in, then import the file.', '');
  out.push('Answer **Yes** to "Does your app collect or share any of the required user data types?" if this table is not empty.', '');
  out.push('| Category | Data type | Purposes | Shared | Collected by |', '| --- | --- | --- | --- | --- |');
  // Several data types can be the same Play type (advertising data and other usage are both "Other actions").
  const merged = new Map<string, { category: string; type: string; purposes: Set<string>; shared: boolean; by: Set<string> }>();
  for (const d of a.play) {
    const info = DATA_TYPES[d.type].play;
    const key = `${info.category}\u0000${info.type}`;
    let row = merged.get(key);
    if (!row) merged.set(key, (row = { category: info.category, type: info.type, purposes: new Set(), shared: false, by: new Set() }));
    for (const p of [...d.purposes, ...d.conditional.flatMap((x) => x.item.purposes)]) row.purposes.add(PLAY_PURPOSES[p].label);
    row.shared ||= d.shared || d.conditional.some((x) => x.item.shared);
    for (const pkg of [...d.packages, ...d.conditional.map((x) => `${x.pkg}*`)]) row.by.add(d.derived.includes(pkg.replace(/\*$/, '')) ? `${pkg}†` : pkg);
  }
  const anyDerived = a.play.some((d) => d.derived.length);
  for (const row of [...merged.values()].sort((x, y) => x.category.localeCompare(y.category) || x.type.localeCompare(y.type))) {
    out.push(`| ${row.category} | ${row.type} | ${[...row.purposes].join(', ') || '_Not stated by the vendor: choose_'} | ${row.shared ? 'Yes' : 'No'} | ${[...row.by].join(', ')} |`);
  }
  out.push('');
  if (a.play.some((d) => d.conditional.length)) out.push('\\* Only in some setups: see the vendor notes below.', '');
  if (anyDerived) out.push('† No Google Play disclosure for the Android SDK (the vendor publishes none, or your rule has no `android` section): this answer comes from the iOS data. Check it.', '');
  out.push(
    'For each data type, Play also asks:',
    '- **Shared?** Data sent to a service provider that processes it for you usually does not count as sharing. Ad and attribution SDKs often do share. Check each vendor link below.',
    '- **Encrypted in transit?** Yes for all the SDKs listed here (they use HTTPS).',
    '- **Can users request deletion?** This depends on your own account deletion flow.',
    '',
  );

  if (a.android.length) {
    out.push('### Android permissions', '');
    out.push('A permission means your app can read the data. Declare it above only if the data leaves the device.', '');
    out.push('| Permission | Added by | Note |', '| --- | --- | --- |');
    for (const p of a.android) out.push(`| ${p.label} (\`${p.permission.split('.').pop()}\`) | ${p.sources.join(', ')} | ${p.note ?? ''} |`);
    out.push('');
    if (!scan.android.mergedFile) out.push('_Build the Android app once and run the report again to include permissions added by Gradle dependencies._', '');
  }

  // Device access --------------------------------------------------
  if (a.access.length) {
    out.push('## Sensitive data your app can read', '', 'Declare these only if your app sends the data off the device (for example to your server).', '');
    out.push('| Data type | Via |', '| --- | --- |');
    for (const acc of a.access) out.push(`| ${DATA_TYPES[acc.type].label} | ${acc.packages.join(', ')} |`);
    out.push('');
  }

  // Required reason APIs --------------------------------------------
  out.push('## Apple privacy manifest: required reason APIs', '');
  out.push('| API category | Reasons | Used by |', '| --- | --- | --- |');
  for (const api of a.apis) {
    const reason = api.defaultReason ? `${api.reasons[0]} (suggested: ${DEFAULT_REASONS[api.category].meaning})` : api.reasons.join(', ');
    out.push(`| ${API_LABELS[api.category]} | ${reason} | ${api.packages.join(', ')} |`);
  }
  out.push('');

  if (a.tracking.length) {
    out.push('## Tracking', '');
    out.push('These libraries declare tracking in their own privacy manifest. If your app tracks users (App Tracking Transparency),', 'set `NSPrivacyTracking` to true and declare these domains: `rn-privacy ios --write --tracking` does both.', '');
    out.push('| Library | Tracking domains |', '| --- | --- |');
    for (const t of a.tracking) out.push(`| ${t.pkg} | ${t.domains.join(', ') || '(none listed)'} |`);
    out.push('', `All domains: ${trackingDomains(a).map((d) => `\`${d}\``).join(', ') || '(none)'}`, '');
  }

  const libAudit = runAudit(scan);
  if (auditProblemCount(libAudit)) {
    out.push('## Library privacy manifests', '');
    out.push('Your app manifest covers these, but the libraries themselves have problems worth reporting to their maintainers (`rn-privacy audit`):', '');
    for (const r of libAudit.invalid) out.push(`- **${r.pkg}**: invalid manifest (${r.issues.length} problem${r.issues.length === 1 ? '' : 's'})`);
    for (const r of libAudit.undeclared) out.push(`- **${r.pkg}**: uses ${categoryList(r.categories)} without a privacy manifest`);
    for (const r of libAudit.incomplete) out.push(`- **${r.pkg}**: manifest misses ${categoryList(r.missing)}`);
    out.push('');
  }

  if (a.warnings.length) {
    out.push('## Warnings', '');
    for (const w of a.warnings) out.push(`- ${w.pkg ? `**${w.pkg}**: ` : ''}${w.message}`);
    out.push('');
  }

  if (a.sources.length) {
    out.push('## Check these vendor pages', '');
    for (const s of a.sources) {
      const ver = s.versions ? ` (rule for ${s.versions})` : '';
      const own = s.origin ? ` (your rule in ${s.origin})` : '';
      out.push(`- **${s.version === '-' ? s.pkg : `${s.pkg}@${s.version}`}**${ver}${own}${s.notes ? `: ${s.notes}` : ''}`);
      for (const url of s.urls) out.push(`  - ${url}`);
    }
    out.push('');
  }
  return out.join('\n');
}

// --------------------------------------------------------------------- json

export function toJson(scan: ScanResult, a: Analysis) {
  return {
    projectType: scan.projectType,
    configFile: scan.configFile ? path.basename(scan.configFile) : undefined,
    apis: a.apis,
    data: a.data.map((d) => ({
      type: d.type,
      apple: DATA_TYPES[d.type].apple,
      play: DATA_TYPES[d.type].play,
      purposes: d.purposes,
      linked: d.linked,
      tracking: d.tracking,
      packages: d.packages,
      conditional: d.conditional.map(({ pkg, condition, item }) => ({ pkg, condition, purposes: item.purposes })),
    })),
    access: a.access,
    packages: scan.packages.map((p) => ({
      name: p.name,
      version: p.version,
      iosNative: p.hasIosNative,
      shipsManifest: p.shipsManifest,
      apis: Object.fromEntries([...p.apis].map(([k, v]) => [k, { reasons: [...v.reasons], evidence: v.evidence }])),
      hasRule: !!p.rule,
      ruleVersions: p.rule?.versions,
      ruleOrigin: p.rule?.origin,
    })),
    warnings: a.warnings,
    tracking: a.tracking,
    trackingDomains: trackingDomains(a),
    android: a.android,
    androidMergedManifest: scan.android.mergedFile,
    play: a.play,
  };
}
