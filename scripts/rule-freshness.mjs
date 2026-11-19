#!/usr/bin/env node
// Checks whether the SDK rules are still current. Run weekly by .github/workflows/rule-freshness.yml.
//
// For every SDK with a rule it compares the privacy manifests in the newest npm release, and the
// manifests linked from the rule's sources (GitHub), with scripts/rules-baseline.json. It also checks
// that every vendor link still exists. A changed manifest means a vendor changed what it declares,
// so the rule should be reviewed.
//
//   node scripts/rule-freshness.mjs [--out report.md]   exit 0: nothing changed, 1: something to review, 2: error
//   node scripts/rule-freshness.mjs --update            after reviewing: save the current state as the baseline
//
// Needs `npm run build` first (it reads the rules from dist/).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import plist from 'plist';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BASELINE = path.join(ROOT, 'scripts', 'rules-baseline.json');
const UA = 'rn-privacy-rule-freshness (+https://github.com/yogesh2902/rn-privacy)';

/** The parts of a privacy manifest a rule depends on: tracking, domains and collected data. */
export function summarizeManifest(xml) {
  let m;
  try {
    m = plist.parse(xml);
  } catch {
    return { invalid: true };
  }
  const collected = (Array.isArray(m?.NSPrivacyCollectedDataTypes) ? m.NSPrivacyCollectedDataTypes : []).map((e) => {
    const type = String(e?.NSPrivacyCollectedDataType ?? '?').replace('NSPrivacyCollectedDataType', '');
    const purposes = (Array.isArray(e?.NSPrivacyCollectedDataTypePurposes) ? e.NSPrivacyCollectedDataTypePurposes : [])
      .map((p) => String(p).replace('NSPrivacyCollectedDataTypePurpose', '')).sort().join('+');
    return `${type} (${purposes || 'no purpose'}${e?.NSPrivacyCollectedDataTypeLinked ? ', linked' : ''}${e?.NSPrivacyCollectedDataTypeTracking ? ', tracking' : ''})`;
  });
  return {
    tracking: m?.NSPrivacyTracking === true,
    domains: (Array.isArray(m?.NSPrivacyTrackingDomains) ? m.NSPrivacyTrackingDomains : []).map(String).sort(),
    collected: [...new Set(collected)].sort(),
  };
}

/** Files in a .tgz, as { name: Buffer }, keeping only names that `keep` accepts. */
export function readTarGz(buf, keep) {
  const tar = zlib.gunzipSync(buf);
  const files = {};
  let longName = null;
  for (let off = 0; off + 512 <= tar.length;) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const str = (a, b) => header.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(str(124, 136).trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = str(345, 500);
    let name = longName ?? (prefix ? `${prefix}/${str(0, 100)}` : str(0, 100));
    longName = null;
    const body = tar.subarray(off + 512, off + 512 + size);
    if (type === 'x') {
      const m = /\d+ path=([^\n]+)\n/.exec(body.toString('utf8'));
      if (m) longName = m[1];
    } else if (type === 'L') {
      longName = body.toString('utf8').replace(/\0.*$/s, '');
    } else if ((type === '0' || type === '\0') && keep(name)) {
      files[name.replace(/^package\//, '')] = Buffer.from(body);
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** Raw URL for a GitHub "blob" link to a privacy manifest. */
export function rawGithubUrl(url) {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+\.xcprivacy)$/.exec(url);
  return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}` : null;
}

/** What changed between the baseline and now, as readable lines. */
export function compare(base, now) {
  const changes = [];
  const show = (s) => (s.invalid ? 'not a valid property list' : [
    `tracking ${s.tracking ? 'on' : 'off'}`,
    s.domains.length ? `domains ${s.domains.join(', ')}` : 'no domains',
    s.collected.length ? `collects ${s.collected.join('; ')}` : 'collects nothing',
  ].join(' · '));
  for (const [key, entry] of Object.entries(now.manifests)) {
    const before = base.manifests?.[key];
    if (!before) { changes.push({ key, kind: 'new', text: `New manifest: ${show(entry.summary)}`, rule: entry.rule }); continue; }
    if (JSON.stringify(before.summary) !== JSON.stringify(entry.summary)) {
      const lines = [];
      const b = before.summary, n = entry.summary;
      if (b.invalid || n.invalid) lines.push(`was: ${show(b)}`, `now: ${show(n)}`);
      else {
        if (b.tracking !== n.tracking) lines.push(`NSPrivacyTracking: ${b.tracking} → ${n.tracking}`);
        for (const d of n.domains.filter((x) => !b.domains.includes(x))) lines.push(`+ tracking domain ${d}`);
        for (const d of b.domains.filter((x) => !n.domains.includes(x))) lines.push(`- tracking domain ${d}`);
        for (const d of n.collected.filter((x) => !b.collected.includes(x))) lines.push(`+ ${d}`);
        for (const d of b.collected.filter((x) => !n.collected.includes(x))) lines.push(`- ${d}`);
      }
      changes.push({ key, kind: 'changed', text: lines.join('\n'), rule: entry.rule, from: before.version, to: entry.version });
    }
  }
  for (const key of Object.keys(base.manifests ?? {})) {
    if (!now.manifests[key] && now.checked.includes(base.manifests[key].source)) {
      changes.push({ key, kind: 'removed', text: 'This manifest is no longer published.', rule: base.manifests[key].rule });
    }
  }
  return changes;
}

async function get(url, as = 'text') {
  const res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow' });
  if (!res.ok) throw Object.assign(new Error(`${res.status} ${url}`), { status: res.status });
  return as === 'buffer' ? Buffer.from(await res.arrayBuffer()) : res.text();
}

/** Read the current state of every rule's manifests and links. */
async function collect(rules) {
  const now = { manifests: {}, versions: {}, checked: [], dead: [], errors: [] };
  const vendor = rules.filter((r) => r.sources.length || r.android?.sources?.length);
  for (const rule of vendor) {
    for (const pkg of rule.packages) {
      const source = `npm:${pkg}`;
      try {
        const meta = JSON.parse(await get(`https://registry.npmjs.org/${pkg.replace('/', '%2F')}/latest`));
        now.versions[pkg] = meta.version;
        const files = readTarGz(await get(meta.dist.tarball, 'buffer'), (n) => path.basename(n) === 'PrivacyInfo.xcprivacy');
        for (const [file, body] of Object.entries(files)) {
          now.manifests[`${pkg}/${file}`] = { rule: rule.name, source, version: meta.version, summary: summarizeManifest(body.toString('utf8')) };
        }
        now.checked.push(source);
      } catch (err) {
        now.errors.push(`${pkg}: ${err.message}`);
      }
    }
    for (const url of [...rule.sources, ...(rule.android?.sources ?? [])]) {
      const raw = rawGithubUrl(url);
      try {
        if (raw) {
          now.manifests[url] = { rule: rule.name, source: url, summary: summarizeManifest(await get(raw)) };
          now.checked.push(url);
        } else {
          await get(url);
        }
      } catch (err) {
        // Many vendor sites refuse automated requests (403, 429): only a missing page counts as dead.
        if (err.status === 404 || err.status === 410) now.dead.push({ rule: rule.name, url, status: err.status });
        else if (raw) now.errors.push(`${url}: ${err.message}`);
      }
    }
  }
  return now;
}

export function formatReport(changes, now) {
  const out = ['# SDK rules to review', ''];
  out.push('The weekly check found vendors that changed what they declare, or vendor links that no longer exist.');
  out.push('Review each rule in `src/rules.ts` against the source, then run `node scripts/rule-freshness.mjs --update` and commit the baseline.', '');
  if (changes.length) {
    out.push('## Privacy manifests that changed', '');
    for (const c of changes) {
      const ver = c.from && c.to && c.from !== c.to ? ` (${c.from} → ${c.to})` : c.to ? ` (${c.to})` : '';
      out.push(`### ${c.rule}: ${c.key}${ver}`, '', '```', c.text, '```', '');
    }
  }
  if (now.dead.length) {
    out.push('## Vendor links that no longer exist', '');
    for (const d of now.dead) out.push(`- **${d.rule}**: ${d.url} (${d.status})`);
    out.push('');
  }
  if (now.errors.length) {
    out.push('<details><summary>Could not check</summary>', '', ...now.errors.map((e) => `- ${e}`), '', '</details>', '');
  }
  return out.join('\n');
}

async function main(argv) {
  const { RULES } = await import(path.join(ROOT, 'dist', 'rules.js'));
  const now = await collect(RULES);
  if (argv.includes('--update')) {
    fs.writeFileSync(BASELINE, JSON.stringify({ manifests: now.manifests, versions: now.versions }, null, 2) + '\n');
    console.log(`Saved ${Object.keys(now.manifests).length} manifests and ${Object.keys(now.versions).length} versions to ${path.relative(process.cwd(), BASELINE)}.`);
    if (now.errors.length) console.log(`Could not check:\n${now.errors.map((e) => `  ${e}`).join('\n')}`);
    return 0;
  }
  const base = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : { manifests: {} };
  const changes = compare(base, now);
  const report = formatReport(changes, now);
  const outIdx = argv.indexOf('--out');
  if (outIdx !== -1) fs.writeFileSync(argv[outIdx + 1], report);
  console.log(changes.length || now.dead.length ? report : `All ${Object.keys(now.manifests).length} manifests match the baseline and no vendor link is missing.`);
  return changes.length || now.dead.length ? 1 : 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => { console.error(err); process.exitCode = 2; });
}
