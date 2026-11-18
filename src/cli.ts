#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { analyze, toApiUsages, toCollected } from './analyze.js';
import { API_LABELS } from './apis.js';
import { expoSnippet, expoWriteTarget, findExpoConfig, findIosManifest, planExpoAppJson, planIosManifest } from './ios.js';
import { readManifest } from './manifest.js';
import { fillPlayCsv } from './play.js';
import { validateManifest } from './validate.js';
import type { PrivacyManifest } from './manifest.js';
import { c, formatMarkdown, formatScan, toJson } from './report.js';
import { scanProject } from './scanner.js';
import { DATA_TYPES } from './types.js';

const VERSION = '0.2.0';

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

${c.bold('Options')}
  -p, --project <dir>       App folder (default: current folder)
  -w, --write               (ios) Write the changes instead of only showing them
      --include-conditional (ios, play) Also declare data collected only in some setups
  -f, --format <md|json>    (report, scan) Output format (default: md for report)
  -o, --out <file>          (report, play) Write to a file instead of the terminal
  -h, --help                Show this help
  -v, --version             Show the version

${c.bold('Also')}
  Expo plugin    Add "plugins": ["rn-privacy"] to app.json to update the manifest on every prebuild
  GitHub Action  uses: yogesh2902/rn-privacy@v0.2.0 checks every pull request
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
  if (!['scan', 'ios', 'report', 'play', 'check'].includes(command)) {
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
        const plan = planExpoAppJson(expoTarget.file, apis, collected);
        report(`app.json (expo.ios.privacyManifests)`, plan.added, write);
        if (write && plan.added.length) fs.writeFileSync(expoTarget.file, plan.content);
        did = true;
      } else if (expo?.dynamic) {
        print(c.bold(`${path.basename(expo.dynamic)} is code, so rn-privacy cannot edit it. Add this under expo.ios in your config:`));
        print(expoSnippet(apis, collected));
        did = true;
      }

      const target = scan.projectType !== 'expo-managed' ? findIosManifest(projectDir) : null;
      if (target) {
        const current = target.exists ? readManifest(target.file) : null;
        if (current && refuseInvalid(path.relative(projectDir, target.file), current)) return 1;
        const plan = planIosManifest(target, apis, collected);
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
      if (analysis.data.some((d) => d.tracking)) {
        print(c.yellow('\nTracking SDKs found: set NSPrivacyTracking and NSPrivacyTrackingDomains yourself (see `rn-privacy scan`).'));
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

    case 'check': {
      const expoCfg = scan.projectType.startsWith('expo') ? findExpoConfig(projectDir) : null;
      const plugin = !!expoCfg?.usesPlugin;
      const declared = readDeclared(projectDir, scan.projectType, plugin);
      if (!declared.length && plugin) {
        return print(c.green(`✓ The rn-privacy Expo plugin adds all ${analysis.apis.length} required reason API categories at prebuild.`));
      }
      if (!declared.length) {
        const expo = expoCfg;
        if (expo?.dynamic && expo.dynamicMentionsPrivacy) {
          console.error(c.red(`✗ privacyManifests is set in ${path.basename(expo.dynamic)}, which rn-privacy cannot read (it never runs your code).`));
          console.error('  Move expo.ios.privacyManifests to app.json so it can be checked.');
        } else {
          console.error(c.red('✗ No privacy manifest found (ios/<App>/PrivacyInfo.xcprivacy or expo.ios.privacyManifests in app.json).'));
          if (analysis.apis.length) console.error(`  Your libraries use ${analysis.apis.length} required reason API categories. Run \`rn-privacy ios --write\`.`);
        }
        return 1;
      }

      let failed = false;
      let generatedOutdated = false;
      let sourceOk = false;
      let invalidFound = false;
      let missingFound = false;
      const several = declared.length > 1;
      for (const src of declared) {
        if (several) print(c.bold(src.label));
        const pad = several ? '  ' : '';
        if (src.unreadable) {
          console.error(c.red(`${pad}✗ Invalid privacy manifest: the file is not a valid property list (ITMS-91056).`));
          failed = true;
          continue;
        }
        if (!src.manifest) {
          console.error(c.red(`${pad}✗ Not generated yet: ${src.label} does not exist. Run \`npx expo prebuild\`.`));
          failed = generatedOutdated = true;
          continue;
        }
        const problems = validateManifest(src.manifest);
        for (const p of problems.filter((x) => x.level === 'warning')) print(c.yellow(`${pad}! ${p.message}`));
        const invalid = problems.filter((x) => x.level === 'error');
        for (const p of invalid) console.error(c.red(`${pad}✗ Invalid: ${p.message}`));
        if (invalid.length) {
          console.error(c.red(`${pad}  App Store Connect rejects invalid manifests with ITMS-91056.`));
          failed = true;
          invalidFound = true;
        }
        if (plugin && src.isAppJson) {
          // The plugin completes app.json's privacyManifests at prebuild: only its validity matters here.
          if (!invalid.length) print(c.green(`${pad}✓ Valid. The rn-privacy Expo plugin adds the rest at prebuild.`));
          if (!invalid.length) sourceOk = true;
          continue;
        }
        const have = new Set(list(src.manifest.NSPrivacyAccessedAPITypes).map((e) => e?.NSPrivacyAccessedAPIType));
        const missing = analysis.apis.filter((a) => !have.has(a.category));
        const haveData = new Set(list(src.manifest.NSPrivacyCollectedDataTypes).map((e) => e?.NSPrivacyCollectedDataType));
        const missingData = analysis.data.filter((d) => d.packages.length && !haveData.has(DATA_TYPES[d.type].apple));

        for (const d of missingData) print(c.yellow(`${pad}! Not declared: ${DATA_TYPES[d.type].label} (collected by ${d.packages.join(', ')})`));
        for (const m of missing) console.error(c.red(`${pad}✗ Missing required reason API: ${API_LABELS[m.category]} (used by ${m.packages.join(', ')})`));
        if (missing.length) {
          failed = missingFound = true;
          if (src.generated) generatedOutdated = true;
        } else if (!invalid.length) {
          if (!src.generated) sourceOk = true;
          print(c.green(`${pad}✓ ${several ? 'Covers' : 'Privacy manifest covers'} all ${analysis.apis.length} required reason API categories.`));
        }
      }

      if (!failed) return 0;
      if (invalidFound) {
        console.error('\nFix the invalid entries by hand: rn-privacy only adds entries, it never edits or removes yours.');
        if (missingFound) console.error('Then run `rn-privacy ios --write` to add what is missing.');
      } else if (generatedOutdated && plugin) {
        console.error('\nThe ios folder is out of date. Run `npx expo prebuild` and the rn-privacy plugin will regenerate the manifest.');
      } else if (generatedOutdated && sourceOk) {
        console.error('\napp.json is correct, but the ios folder is out of date with it.');
        console.error('Run `npx expo prebuild` to regenerate it, or `rn-privacy ios --write` to update both.');
      } else {
        console.error('\nRun `rn-privacy ios --write` to fix.');
      }
      return 1;
    }
  }
  return 0;
}

interface DeclaredSource {
  label: string;
  /** null when the file should exist (app.json declares privacy) but prebuild has not created it. */
  manifest: PrivacyManifest | null;
  /** true for the ios folder of an Expo prebuild project, which is generated from app.json. */
  generated?: boolean;
  /** The file exists but is not a valid property list. */
  unreadable?: boolean;
  /** expo.ios.privacyManifests in app.json. */
  isAppJson?: boolean;
}

/**
 * Every privacy manifest the app ships. An Expo prebuild project has two: app.json, and the
 * PrivacyInfo.xcprivacy that `expo prebuild` writes into ios/. They drift apart when app.json
 * changes and the ios folder is not regenerated, so both are checked.
 */
function readDeclared(projectDir: string, type: string, usesPlugin = false): DeclaredSource[] {
  const out: DeclaredSource[] = [];
  let appJsonHasPrivacy = false;
  if (type.startsWith('expo')) {
    const cfg = findExpoConfig(projectDir);
    if (cfg?.appJson) {
      const pm = readExpoPrivacy(cfg.appJson);
      if (pm) {
        out.push({ label: 'app.json (expo.ios.privacyManifests)', manifest: pm, isAppJson: true });
        appJsonHasPrivacy = true;
      }
    }
  }
  if (type === 'expo-managed') return out;

  const target = findIosManifest(projectDir);
  if (!target) return out;
  const label = path.relative(projectDir, target.file);
  const generated = type === 'expo-prebuild' && (appJsonHasPrivacy || usesPlugin);
  if (target.exists) {
    const manifest = readManifest(target.file);
    out.push({ label, manifest, generated, unreadable: manifest === null });
  }
  else if (generated) out.push({ label, manifest: null, generated });
  return out;
}

function readExpoPrivacy(appJson: string): PrivacyManifest | undefined {
  const json = JSON.parse(fs.readFileSync(appJson, 'utf8'));
  return (json.expo ?? json)?.ios?.privacyManifests;
}

/** An array from a manifest value that may be malformed. */
function list<T>(value: T[] | undefined): T[] {
  return Array.isArray(value) ? value : [];
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
