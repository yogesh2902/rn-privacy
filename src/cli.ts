#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { analyze, toApiUsages, toCollected } from './analyze.js';
import { API_LABELS } from './apis.js';
import { expoSnippet, expoWriteTarget, findExpoConfig, findIosManifest, planExpoAppJson, planIosManifest } from './ios.js';
import { readManifest } from './manifest.js';
import type { PrivacyManifest } from './manifest.js';
import { c, formatMarkdown, formatScan, toJson } from './report.js';
import { scanProject } from './scanner.js';
import { DATA_TYPES } from './types.js';

const VERSION = '0.1.2';

const HELP = `${c.bold('rn-privacy')} ${VERSION}
Privacy manifest and store privacy forms for React Native and Expo apps.

${c.bold('Usage')}
  rn-privacy [command] [options]

${c.bold('Commands')}
  scan      Show what your dependencies collect and which Apple APIs they use (default)
  ios       Update your PrivacyInfo.xcprivacy (bare) or app.json (Expo). Dry run unless --write
  report    Answers for App Store Connect "App Privacy" and Google Play "Data safety"
  check     For CI: exit with code 1 if your manifest is missing required reason APIs

${c.bold('Options')}
  -p, --project <dir>       App folder (default: current folder)
  -w, --write               (ios) Write the changes instead of only showing them
      --include-conditional (ios) Also declare data collected only in some setups
  -f, --format <md|json>    (report, scan) Output format (default: md for report)
  -o, --out <file>          (report) Write to a file instead of the terminal
  -h, --help                Show this help
  -v, --version             Show the version
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
  if (!['scan', 'ios', 'report', 'check'].includes(command)) {
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
      const expoTarget = expo ? expoWriteTarget(expo) : null;
      if (expoTarget) {
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

    case 'check': {
      const declared = readDeclared(projectDir, scan.projectType);
      if (!declared.length) {
        const expo = scan.projectType.startsWith('expo') ? findExpoConfig(projectDir) : null;
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
      const several = declared.length > 1;
      for (const src of declared) {
        if (several) print(c.bold(src.label));
        const pad = several ? '  ' : '';
        if (!src.manifest) {
          console.error(c.red(`${pad}✗ Not generated yet. app.json has privacyManifests, but ${src.label} does not exist.`));
          failed = generatedOutdated = true;
          continue;
        }
        const have = new Set((src.manifest.NSPrivacyAccessedAPITypes ?? []).map((e) => e.NSPrivacyAccessedAPIType));
        const missing = analysis.apis.filter((a) => !have.has(a.category));
        const haveData = new Set((src.manifest.NSPrivacyCollectedDataTypes ?? []).map((e) => e.NSPrivacyCollectedDataType));
        const missingData = analysis.data.filter((d) => d.packages.length && !haveData.has(DATA_TYPES[d.type].apple));

        for (const d of missingData) print(c.yellow(`${pad}! Not declared: ${DATA_TYPES[d.type].label} (collected by ${d.packages.join(', ')})`));
        for (const m of missing) console.error(c.red(`${pad}✗ Missing required reason API: ${API_LABELS[m.category]} (used by ${m.packages.join(', ')})`));
        if (missing.length) {
          failed = true;
          if (src.generated) generatedOutdated = true;
        } else {
          if (!src.generated) sourceOk = true;
          print(c.green(`${pad}✓ ${several ? 'Covers' : 'Privacy manifest covers'} all ${analysis.apis.length} required reason API categories.`));
        }
      }

      if (!failed) return 0;
      if (generatedOutdated && sourceOk) {
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
}

/**
 * Every privacy manifest the app ships. An Expo prebuild project has two: app.json, and the
 * PrivacyInfo.xcprivacy that `expo prebuild` writes into ios/. They drift apart when app.json
 * changes and the ios folder is not regenerated, so both are checked.
 */
function readDeclared(projectDir: string, type: string): DeclaredSource[] {
  const out: DeclaredSource[] = [];
  let appJsonHasPrivacy = false;
  if (type.startsWith('expo')) {
    const cfg = findExpoConfig(projectDir);
    if (cfg?.appJson) {
      const json = JSON.parse(fs.readFileSync(cfg.appJson, 'utf8'));
      const pm = (json.expo ?? json)?.ios?.privacyManifests;
      if (pm) {
        out.push({ label: 'app.json (expo.ios.privacyManifests)', manifest: pm });
        appJsonHasPrivacy = true;
      }
    }
  }
  if (type === 'expo-managed') return out;

  const target = findIosManifest(projectDir);
  if (!target) return out;
  const label = path.relative(projectDir, target.file);
  const generated = type === 'expo-prebuild' && appJsonHasPrivacy;
  if (target.exists) out.push({ label, manifest: readManifest(target.file), generated });
  else if (generated && appJsonHasPrivacy) out.push({ label, manifest: null, generated });
  return out;
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
