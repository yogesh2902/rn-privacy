#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { analyze, toApiUsages, toCollected, trackingDomains } from './analyze.js';
import { audit, auditProblemCount } from './audit.js';
import { expoSnippet, expoWriteTarget, findExpoConfig, findIosManifest, planExpoAppJson, planIosManifest } from './ios.js';
import { readManifest } from './manifest.js';
import { fillPlayCsv } from './play.js';
import { validateManifest } from './validate.js';
import { formatCheck, readExpoPrivacy, runCheck } from './check.js';
import { AD_ID } from './android.js';
import { buildSnapshot, changeCount, diffSnapshots, formatDiff, loadBaseSnapshot, SNAPSHOT_FILE, snapshotText } from './snapshot.js';
import { c, formatAudit, formatMarkdown, formatScan, toJson } from './report.js';
import { scanProject } from './scanner.js';

// Read from package.json so a release only needs one version bump.
const VERSION: string = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;

const HELP = `${c.bold('rn-privacy')} ${VERSION}
Privacy manifest and store privacy forms for React Native and Expo apps.

${c.bold('Usage')}
  rn-privacy [command] [options]

${c.bold('Commands')}
  scan      Show what your dependencies collect and which Apple APIs they use (default)
  ios       Update your PrivacyInfo.xcprivacy (bare) or app.json (Expo). Dry run unless --write
  report    Answers for App Store Connect "App Privacy" and Google Play "Data safety"
  play      Fill in the Data safety CSV exported from Play Console: rn-privacy play data_safety.csv -o filled.csv
  check     For CI: exit with code 1 if your manifest is missing or invalid
  audit     Check the privacy manifests your libraries ship, and where to report problems
  snapshot  Save what your dependencies need to privacy-snapshot.json (commit it)
  diff      Show privacy changes since the snapshot: new APIs, data, tracking, permissions

${c.bold('Options')}
  -p, --project <dir>       App folder (default: current folder)
  -w, --write               (ios) Write the changes instead of only showing them
      --include-conditional (ios, play) Also declare data collected only in some setups
      --tracking            (ios) Your app tracks users: set NSPrivacyTracking and add your libraries' tracking domains
      --strict              (audit, diff) Exit with code 1 when there is a problem or a change
      --base <file|ref>     (diff) Snapshot to compare with: a file, or a git ref such as origin/main
  -f, --format <md|json>    (report, scan, audit, check, diff) Output format (default: md for report)
  -o, --out <file>          (report, play, snapshot) Write to a file instead of the terminal
  -h, --help                Show this help
  -v, --version             Show the version

${c.bold('Also')}
  Expo plugin    Add "plugins": ["rn-privacy"] to app.json to update the manifest on every prebuild
  GitHub Action  uses: yogesh2902/rn-privacy@v0.4.0 checks every pull request
  Docs           https://github.com/yogesh2902/rn-privacy
`;

function main(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      project: { type: 'string', short: 'p' },
      write: { type: 'boolean', short: 'w' },
      'include-conditional': { type: 'boolean' },
      tracking: { type: 'boolean' },
      strict: { type: 'boolean' },
      base: { type: 'string' },
      format: { type: 'string', short: 'f' },
      out: { type: 'string', short: 'o' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });

  if (values.help) return print(HELP);
  if (values.version) return print(VERSION);

  const command = positionals[0] ?? 'scan';
  const projectDir = path.resolve(values.project ?? process.cwd());
  if (!['scan', 'ios', 'report', 'play', 'check', 'audit', 'snapshot', 'diff'].includes(command)) {
    console.error(`Unknown command "${command}".\n\n${HELP}`);
    return 2;
  }

  const scan = scanProject(projectDir);
  const analysis = analyze(scan);
  const apis = toApiUsages(analysis);

  switch (command) {
    case 'scan':
      return print(values.format === 'json' ? JSON.stringify(toJson(scan, analysis), null, 2) : formatScan(scan, analysis));

    case 'report': {
      const text = values.format === 'json' ? JSON.stringify(toJson(scan, analysis), null, 2) : formatMarkdown(scan, analysis);
      if (values.out) {
        fs.writeFileSync(path.resolve(values.out), text + '\n');
        return print(c.green(`Wrote ${values.out}`));
      }
      return print(text);
    }

    case 'ios': {
      const collected = toCollected(analysis, !!values['include-conditional']);
      const write = !!values.write;
      const mergeOpts = values.tracking ? { tracking: { domains: trackingDomains(analysis) } } : {};
      let did = false;

      const expo = scan.projectType.startsWith('expo') ? findExpoConfig(projectDir) : null;
      if (expo?.usesPlugin) {
        print(c.dim('The rn-privacy Expo plugin is enabled, so `expo prebuild` already adds all of this. You do not need --write.\n'));
      }
      const expoTarget = expo ? expoWriteTarget(expo) : null;
      if (expoTarget) {
        const current = readExpoPrivacy(expoTarget.file);
        if (current && refuseInvalid('app.json (expo.ios.privacyManifests)', current)) return 1;
        if (expoTarget.note) print(c.dim(expoTarget.note));
        const plan = planExpoAppJson(expoTarget.file, apis, collected, mergeOpts);
        report(`app.json (expo.ios.privacyManifests)`, plan.added, write);
        if (write && plan.added.length) fs.writeFileSync(expoTarget.file, plan.content);
        did = true;
      } else if (expo?.dynamic) {
        print(c.bold(`${path.basename(expo.dynamic)} is code, so rn-privacy cannot edit it. Add this under expo.ios in your config:`));
        print(expoSnippet(apis, collected, mergeOpts));
        did = true;
      }

      const target = scan.projectType !== 'expo-managed' ? findIosManifest(projectDir) : null;
      if (target) {
        const current = target.exists ? readManifest(target.file) : null;
        if (current && refuseInvalid(path.relative(projectDir, target.file), current)) return 1;
        const plan = planIosManifest(target, apis, collected, mergeOpts);
        const rel = path.relative(projectDir, target.file);
        report(rel + (target.exists ? '' : c.dim(' (new file)')), plan.added, write);
        if (write && (plan.added.length || !target.exists)) {
          fs.writeFileSync(target.file, plan.content);
          if (!target.exists) print(c.yellow(`\nCreated ${rel}. Open Xcode and add it to your app target (File > Add Files), or Apple will not see it.`));
        }
        if (target.exists && target.inXcodeProject === false) {
          print(c.yellow(`\n${rel} exists but is not in your Xcode project. Add it to your app target in Xcode.`));
        }
        if (scan.projectType === 'expo-prebuild') {
          print(c.dim('\nExpo prebuild regenerates the ios folder. Keep app.json as the source of truth.'));
        }
        did = true;
      }

      if (!did) {
        console.error('No ios folder or Expo config found. Run this in your React Native app folder, or pass --project.');
        return 1;
      }
      if (!write) print(c.dim('\nDry run. Run again with --write to save.'));
      if (!values.tracking && (analysis.data.some((d) => d.tracking) || analysis.tracking.length)) {
        print(c.yellow('\nYour libraries can track users. If your app uses App Tracking Transparency, run again with --tracking'));
        print(c.yellow(`to set NSPrivacyTracking and declare ${trackingDomains(analysis).length || 'their'} tracking domain(s).`));
      }
      return 0;
    }

    case 'play': {
      const csvPath = positionals[1];
      if (!csvPath) {
        console.error('Usage: rn-privacy play <data_safety.csv> [-o filled.csv]\n');
        console.error('1. In Play Console, open your app > App content > Data safety and export the form to CSV.');
        console.error('2. Run rn-privacy play on that file with -o to save the filled copy.');
        console.error('3. Import the filled CSV on the same page, then review and answer what is left.');
        return 2;
      }
      const input = path.resolve(csvPath);
      if (!fs.existsSync(input)) {
        console.error(c.red(`File not found: ${csvPath}`));
        return 1;
      }
      const collected = toCollected(analysis, !!values['include-conditional']);
      const result = fillPlayCsv(fs.readFileSync(input, 'utf8'), collected);

      print(c.bold('Google Play Data safety'));
      if (!collected.length) print(c.dim('  Your libraries collect no data that rn-privacy knows of. Add what your own code collects in Play Console.'));
      else if (!result.changes.length) print(c.green('  Already up to date.'));
      for (const ch of result.changes) print(`  ${c.green('+')} ${ch}`);
      if (result.missingRows.length) {
        print(c.yellow('\nYour CSV has no row for these answers (the template may be older or newer). Set them in Play Console:'));
        for (const m of result.missingRows) print(c.yellow(`  ! ${m}`));
      }
      print(c.bold('\nStill to answer in Play Console'));
      if (result.todo.length) print(`  - Required or optional for users? (${result.todo.join(', ')})`);
      if (analysis.data.some((d) => d.tracking || d.purposes.includes('third-party-advertising'))) {
        print('  - Shared? Ad and attribution SDKs may use data for their own purposes, which counts as sharing. Check the vendor pages in `rn-privacy report`.');
      }
      const adId = analysis.android.find((p) => p.permission === AD_ID);
      if (adId) print(`  - Advertising ID: your app uses it (from ${adId.sources.join(', ')}). Answer Yes in App content > Advertising ID.`);
      for (const p of analysis.android.filter((x) => x.permission !== AD_ID && x.note)) print(`  - ${p.label}: ${p.note}`);
      print('  - Encrypted in transit? Can users request deletion?');
      print('  - Anything your own code or server collects.');

      if (values.out) {
        fs.writeFileSync(path.resolve(values.out), result.content);
        print(c.green(`\nWrote ${values.out}. Import it on the Data safety page in Play Console.`));
      } else {
        print(c.dim('\nDry run. Add -o filled.csv to save the filled file.'));
      }
      return 0;
    }

    case 'snapshot': {
      const file = path.resolve(projectDir, values.out ?? SNAPSHOT_FILE);
      const text = snapshotText(buildSnapshot(scan, analysis));
      const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      fs.writeFileSync(file, text);
      const rel = path.relative(process.cwd(), file) || file;
      return print(before === text ? c.green(`${rel} is up to date.`) : c.green(`${before === null ? 'Wrote' : 'Updated'} ${rel}. Commit it so pull requests show privacy changes.`));
    }

    case 'diff': {
      const base = loadBaseSnapshot(projectDir, values.base);
      if (!base.snapshot) {
        console.error(c.red(`✗ ${base.error}`));
        return 1;
      }
      const result = diffSnapshots(base.snapshot, buildSnapshot(scan, analysis));
      print(values.format === 'json' ? JSON.stringify({ against: base.label, changes: changeCount(result), ...result }, null, 2) : formatDiff(result, base.label, c));
      return values.strict && changeCount(result) ? 1 : 0;
    }

    case 'audit': {
      const result = audit(scan);
      print(values.format === 'json' ? JSON.stringify(result, null, 2) : formatAudit(result));
      return values.strict && auditProblemCount(result) ? 1 : 0;
    }

    case 'check': {
      const result = runCheck(projectDir, scan, analysis);
      if (values.format === 'json') {
        print(JSON.stringify(result, null, 2));
        return result.ok ? 0 : 1;
      }
      for (const line of formatCheck(result, c)) (line.stream === 'out' ? print : (t: string) => console.error(t))(line.text);
      return result.ok ? 0 : 1;
    }
  }
  return 0;
}





/** Print errors in an existing manifest and return true if there were any. */
function refuseInvalid(label: string, manifest: unknown): boolean {
  const errors = validateManifest(manifest).filter((p) => p.level === 'error');
  if (!errors.length) return false;
  console.error(c.red(`${label} is invalid, so rn-privacy will not change it:`));
  for (const e of errors) console.error(c.red(`  ✗ ${e.message}`));
  console.error('Fix these by hand, then run again.');
  return true;
}

function report(label: string, added: string[], write: boolean) {
  print(c.bold(label));
  if (!added.length) return void print(c.green('  Already up to date.'));
  for (const a of added) print(`  ${c.green('+')} ${a}`);
  if (write) print(c.green(`  Saved ${added.length} change(s).`));
}

function print(s: string): number {
  process.stdout.write(s + '\n');
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  console.error(c.red(err instanceof Error ? err.message : String(err)));
  process.exitCode = 1;
}
