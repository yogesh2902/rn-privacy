import fs from 'node:fs';
import path from 'node:path';
import type { Analysis } from './analyze.js';
import { toApiUsages, toCollected } from './analyze.js';
import { CONFIG_FILE } from './config.js';
import { findExpoConfig, findIosManifest, planIosManifest } from './ios.js';
import { buildSnapshot, SNAPSHOT_FILE, snapshotText } from './snapshot.js';
import type { ScanResult } from './types.js';

/**
 * `rn-privacy init`: set a project up in one command. It only creates files that do not exist
 * and only adds to the ones that do (the Expo plugin, the app's privacy manifest).
 */
export interface InitStep {
  /** Path relative to the project (or the repository root, for the workflow). */
  file: string;
  status: 'create' | 'update' | 'done' | 'manual';
  what: string;
  /** New file content, for create and update. */
  content?: string;
  /** For manual steps: what to do. */
  todo?: string;
}

export interface InitPlan {
  steps: InitStep[];
  /** Absolute paths for the steps, by `file`. */
  paths: Record<string, string>;
  /** Commands to run after the files are written. */
  next: string[];
}

type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun';

function findUp(dir: string, names: string[]): string | null {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    for (const n of names) if (fs.existsSync(path.join(d, n))) return path.join(d, n);
    if (path.dirname(d) === d) return null;
  }
}

/** The package manager, from the nearest lockfile (monorepos keep it at the root). */
export function detectPackageManager(projectDir: string): { pm: PackageManager; root: string } {
  const lock = findUp(projectDir, ['pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock', 'package-lock.json']);
  if (!lock) return { pm: 'npm', root: projectDir };
  const name = path.basename(lock);
  const pm: PackageManager = name.startsWith('pnpm') ? 'pnpm' : name.startsWith('yarn') ? 'yarn' : name.startsWith('bun') ? 'bun' : 'npm';
  return { pm, root: path.dirname(lock) };
}

const ADD_DEV: Record<PackageManager, string> = {
  npm: 'npm install --save-dev rn-privacy',
  yarn: 'yarn add --dev rn-privacy',
  pnpm: 'pnpm add --save-dev rn-privacy',
  bun: 'bun add --dev rn-privacy',
};

/** The GitHub workflow that runs the rn-privacy action on pull requests. */
export function workflowYaml(opts: { version: string; pm: PackageManager; installDir: string; projectPath: string; yarnBerry: boolean }): string {
  const install: Record<PackageManager, string[]> = {
    npm: ['      - run: npm ci'],
    yarn: opts.yarnBerry ? ['      - run: corepack enable', '      - run: yarn install --immutable'] : ['      - run: yarn install --frozen-lockfile'],
    pnpm: ['      - uses: pnpm/action-setup@v4', '      - run: pnpm install --frozen-lockfile'],
    bun: ['      - uses: oven-sh/setup-bun@v2', '      - run: bun install --frozen-lockfile'],
  };
  const lines = [
    '# Checks the app\'s Apple privacy manifest on every pull request and comments with privacy changes.',
    '# Created by `rn-privacy init`. Docs: https://github.com/yogesh2902/rn-privacy#github-action',
    'name: privacy',
    'on:',
    '  pull_request:',
    '  workflow_dispatch:',
    '',
    'jobs:',
    '  privacy:',
    '    runs-on: ubuntu-latest',
    '    permissions:',
    '      contents: read',
    '      pull-requests: write # to comment on pull requests',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - uses: actions/setup-node@v4',
    '        with:',
    '          node-version: 22',
    ...install[opts.pm].map((l) => (opts.installDir === '.' || l.includes('uses:') ? l : `${l}\n        working-directory: ${opts.installDir}`)),
    `      - uses: yogesh2902/rn-privacy@v${opts.version}`,
    ...(opts.projectPath === '.' ? [] : ['        with:', `          project-path: ${opts.projectPath}`]),
  ];
  return lines.join('\n') + '\n';
}

export function planInit(projectDir: string, scan: ScanResult, analysis: Analysis, version: string): InitPlan {
  const steps: InitStep[] = [];
  const paths: Record<string, string> = {};
  const next: string[] = [];
  const add = (abs: string, step: Omit<InitStep, 'file'>, base = projectDir) => {
    const file = path.relative(base, abs) || path.basename(abs);
    paths[file] = abs;
    steps.push({ file, ...step });
  };
  const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8'));
  const installed = !!(pkg.dependencies?.['rn-privacy'] ?? pkg.devDependencies?.['rn-privacy']);
  const { pm, root } = detectPackageManager(projectDir);

  // 1. The app's privacy manifest: the Expo plugin, or PrivacyInfo.xcprivacy in a bare app.
  if (scan.projectType.startsWith('expo')) {
    const expo = findExpoConfig(projectDir);
    if (expo?.usesPlugin) {
      add(expo.appJson ?? expo.dynamic!, { status: 'done', what: 'The rn-privacy Expo plugin is already enabled' });
    } else if (expo?.appJson && !expo.dynamic) {
      const json = JSON.parse(fs.readFileSync(expo.appJson, 'utf8'));
      const root = json.expo ?? json;
      root.plugins = [...(Array.isArray(root.plugins) ? root.plugins : []), 'rn-privacy'];
      add(expo.appJson, { status: 'update', what: 'Add the rn-privacy Expo plugin: every prebuild writes the privacy manifest', content: JSON.stringify(json, null, 2) + '\n' });
    } else {
      add(expo?.dynamic ?? path.join(projectDir, 'app.json'), {
        status: 'manual',
        what: 'Add the rn-privacy Expo plugin',
        todo: `Add "rn-privacy" to plugins in ${expo?.dynamic ? path.basename(expo.dynamic) : 'your Expo config'} (rn-privacy does not edit code).`,
      });
    }
    if (!installed) next.push(`${ADD_DEV[pm]}   # the Expo plugin loads rn-privacy from node_modules`);
    next.push('npx expo prebuild --platform ios   # or let EAS Build run it');
  } else {
    const target = findIosManifest(projectDir);
    if (!target) {
      add(path.join(projectDir, 'ios'), { status: 'manual', what: 'Privacy manifest', todo: 'No ios folder found. Run init in your React Native app folder.' });
    } else {
      const plan = planIosManifest(target, toApiUsages(analysis), toCollected(analysis, false));
      if (target.exists && !plan.added.length) add(target.file, { status: 'done', what: 'The privacy manifest already covers your libraries' });
      else add(target.file, { status: target.exists ? 'update' : 'create', what: `Privacy manifest: ${plan.added.length} entr${plan.added.length === 1 ? 'y' : 'ies'} your libraries need`, content: plan.content });
      if (!target.exists) next.push(`Open Xcode and add ${path.relative(projectDir, target.file)} to your app target (File > Add Files), or Apple will not see it.`);
    }
  }

  // 2. The project's own rules.
  const config = path.join(projectDir, CONFIG_FILE);
  if (fs.existsSync(config)) add(config, { status: 'done', what: 'Your rules already exist' });
  else {
    add(config, {
      status: 'create',
      what: 'Your own rules: in-house SDKs and data your app itself collects (empty for now)',
      content: JSON.stringify({ $schema: './node_modules/rn-privacy/config.schema.json', rules: [] }, null, 2) + '\n',
    });
  }

  // 3. The snapshot, so pull requests show privacy changes.
  const snapshot = path.join(projectDir, SNAPSHOT_FILE);
  if (fs.existsSync(snapshot)) add(snapshot, { status: 'done', what: 'Snapshot already exists (update it with `rn-privacy snapshot`)' });
  else add(snapshot, { status: 'create', what: 'What your dependencies need today, so pull requests show changes', content: snapshotText(buildSnapshot(scan, analysis)) });

  // 4. The GitHub workflow, at the root of the git repository.
  const git = findUp(projectDir, ['.git']);
  if (git) {
    const repo = path.dirname(git);
    const wfDir = path.join(repo, '.github', 'workflows');
    const existing = fs.existsSync(wfDir) ? fs.readdirSync(wfDir).find((f) => /\.ya?ml$/.test(f) && fs.readFileSync(path.join(wfDir, f), 'utf8').includes('yogesh2902/rn-privacy@')) : undefined;
    if (existing) add(path.join(wfDir, existing), { status: 'done', what: 'A workflow already runs the rn-privacy action' }, repo);
    else {
      const rel = (d: string) => path.relative(repo, d).split(path.sep).join('/') || '.';
      add(path.join(wfDir, 'privacy.yml'), {
        status: 'create',
        what: 'GitHub workflow: checks every pull request and comments with privacy changes',
        content: workflowYaml({ version, pm, installDir: rel(root), projectPath: rel(projectDir), yarnBerry: fs.existsSync(path.join(root, '.yarnrc.yml')) }),
      }, repo);
    }
  }

  next.push('npx rn-privacy report   # answers for App Store Connect and Google Play');
  return { steps, paths, next };
}

/** Write the create and update steps. Never replaces a file that exists, except to add to it. */
export function applyInit(plan: InitPlan): string[] {
  const written: string[] = [];
  for (const step of plan.steps) {
    if (!step.content || (step.status !== 'create' && step.status !== 'update')) continue;
    const abs = plan.paths[step.file];
    if (step.status === 'create' && fs.existsSync(abs)) continue;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, step.content);
    written.push(step.file);
  }
  return written;
}
