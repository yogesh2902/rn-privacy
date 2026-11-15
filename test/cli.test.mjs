import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findApiSymbols } from '../dist/apis.js';
import { mergeManifest } from '../dist/manifest.js';
import { analyze } from '../dist/analyze.js';
import { scanProject } from '../dist/scanner.js';
import { formatMarkdown } from '../dist/report.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');
const run = (cwd, ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });

function write(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
}

const manifestXml = (apis) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>NSPrivacyAccessedAPITypes</key><array>${apis
  .map(([t, r]) => `<dict><key>NSPrivacyAccessedAPIType</key><string>${t}</string><key>NSPrivacyAccessedAPITypeReasons</key><array><string>${r}</string></array></dict>`)
  .join('')}</array></dict></plist>`;

function fixture(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `rn-privacy-${name}-`));
}

test('finds required reason API symbols and ignores comments', () => {
  const hits = findApiSymbols(`
    // [NSUserDefaults standardUserDefaults];
    /* mach_absolute_time() */
    NSDictionary *a = [fm attributesOfFileSystemForPath:p error:nil][NSFileSystemFreeSize];
    struct stat st; stat(path, &st);
  `);
  const cats = hits.map((h) => h.category).sort();
  assert.deepEqual(cats, ['NSPrivacyAccessedAPICategoryDiskSpace', 'NSPrivacyAccessedAPICategoryFileTimestamp']);
});

test('mergeManifest only adds and is idempotent', () => {
  const existing = {
    NSPrivacyAccessedAPITypes: [{ NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults', NSPrivacyAccessedAPITypeReasons: ['1C8F.1'] }],
    NSPrivacyTracking: true,
    Custom: 'keep me',
  };
  const apis = [{ category: 'NSPrivacyAccessedAPICategoryUserDefaults', reasons: ['CA92.1'] }];
  const collected = [{ type: 'crash-data', purposes: ['app-functionality'], linked: false, tracking: false }];
  const first = mergeManifest(existing, apis, collected);
  assert.deepEqual(first.manifest.NSPrivacyAccessedAPITypes[0].NSPrivacyAccessedAPITypeReasons, ['1C8F.1', 'CA92.1']);
  assert.equal(first.manifest.NSPrivacyTracking, true, 'never switches tracking off');
  assert.equal(first.manifest.Custom, 'keep me');
  assert.equal(existing.NSPrivacyAccessedAPITypes[0].NSPrivacyAccessedAPITypeReasons.length, 1, 'input not mutated');
  const second = mergeManifest(first.manifest, apis, collected);
  assert.deepEqual(second.added, []);
});

test('bare app: scan, ios --write, check', () => {
  const dir = fixture('bare');
  write(dir, {
    'package.json': { name: 'App', dependencies: { 'native-lib': '1.0.0', 'sdk-lib': '1.0.0', '@sentry/react-native': '1.0.0', 'js-only': '1.0.0' } },
    'node_modules/native-lib/package.json': { name: 'native-lib', version: '1.2.3' },
    'node_modules/native-lib/native-lib.podspec': '',
    'node_modules/native-lib/ios/Thing.m': 'uint64_t t = mach_absolute_time();\n[NSUserDefaults standardUserDefaults];',
    'node_modules/native-lib/example/ios/Ignored.m': 'NSFileSystemFreeSize',
    // A library whose own manifest uses an SDK-only reason: must not leak into the app manifest.
    'node_modules/sdk-lib/package.json': { name: 'sdk-lib', version: '2.0.0' },
    'node_modules/sdk-lib/ios/PrivacyInfo.xcprivacy': manifestXml([['NSPrivacyAccessedAPICategoryFileTimestamp', '0A2A.1']]),
    'node_modules/@sentry/react-native/package.json': { name: '@sentry/react-native', version: '6.0.0' },
    'node_modules/js-only/package.json': { name: 'js-only', version: '1.0.0' },
    'ios/App.xcodeproj/project.pbxproj': '',
    'ios/App/AppDelegate.mm': '',
  });

  const scan = scanProject(dir);
  assert.equal(scan.projectType, 'bare');
  const a = analyze(scan);
  const byCat = Object.fromEntries(a.apis.map((x) => [x.category.replace('NSPrivacyAccessedAPICategory', ''), x]));
  assert.deepEqual(Object.keys(byCat).sort(), ['FileTimestamp', 'SystemBootTime', 'UserDefaults'], 'example/ folder is skipped');
  assert.deepEqual(byCat.FileTimestamp.reasons, ['C617.1'], 'SDK-only reason replaced by the default');
  assert.equal(byCat.FileTimestamp.defaultReason, true);

  assert.equal(run(dir, 'check').status, 1, 'check fails without a manifest');

  const dry = run(dir, 'ios');
  assert.equal(dry.status, 0);
  assert.match(dry.stdout, /new file/);
  assert.ok(!fs.existsSync(path.join(dir, 'ios/App/PrivacyInfo.xcprivacy')), 'dry run writes nothing');

  const wrote = run(dir, 'ios', '--write');
  assert.equal(wrote.status, 0, wrote.stderr);
  const xml = fs.readFileSync(path.join(dir, 'ios/App/PrivacyInfo.xcprivacy'), 'utf8');
  assert.match(xml, /NSPrivacyAccessedAPICategorySystemBootTime/);
  assert.match(xml, /NSPrivacyCollectedDataTypeCrashData/, 'Sentry crash data declared');
  assert.doesNotMatch(xml, /0A2A\.1/);
  assert.doesNotMatch(xml, /NSPrivacyCollectedDataTypeUserID/, 'conditional data not declared by default');
  assert.match(wrote.stdout, /add it to your app target/);

  const check = run(dir, 'check');
  assert.equal(check.status, 0, check.stderr);
  assert.match(run(dir, 'ios').stdout, /Already up to date/);
});

test('expo managed app: merges into app.json and keeps other settings', () => {
  const dir = fixture('expo');
  write(dir, {
    'package.json': { name: 'ExpoApp', dependencies: { expo: '52.0.0', 'expo-location': '18.0.0', 'expo-notifications': '0.29.0' } },
    'app.json': { expo: { name: 'ExpoApp', ios: { bundleIdentifier: 'com.example.app' } } },
    'node_modules/expo/package.json': { name: 'expo', version: '52.0.0', dependencies: { 'expo-file-system': '18.0.0' } },
    'node_modules/expo-file-system/package.json': { name: 'expo-file-system', version: '18.0.0' },
    'node_modules/expo-file-system/expo-module.config.json': { platforms: ['apple', 'android'] },
    'node_modules/expo-file-system/ios/FileSystem.swift': 'let free = values.volumeAvailableCapacityForImportantUsage // URLResourceKey\nlet k: URLResourceKey = .volumeAvailableCapacityForImportantUsageKey',
    'node_modules/expo-location/package.json': { name: 'expo-location', version: '18.0.0' },
    'node_modules/expo-location/ios/Location.swift': '',
    'node_modules/expo-notifications/package.json': { name: 'expo-notifications', version: '0.29.0' },
  });

  const scan = scanProject(dir);
  assert.equal(scan.projectType, 'expo-managed');
  assert.ok(scan.packages.some((p) => p.name === 'expo-file-system'), 'transitive Expo module scanned');
  const a = analyze(scan);
  assert.ok(a.access.some((x) => x.type === 'precise-location'));
  assert.ok(!a.data.some((x) => x.type === 'precise-location'), 'device access is not reported as collection');

  const res = run(dir, 'ios', '--write');
  assert.equal(res.status, 0, res.stderr);
  const json = JSON.parse(fs.readFileSync(path.join(dir, 'app.json'), 'utf8'));
  assert.equal(json.expo.ios.bundleIdentifier, 'com.example.app');
  const types = json.expo.ios.privacyManifests.NSPrivacyAccessedAPITypes.map((t) => t.NSPrivacyAccessedAPIType);
  assert.deepEqual(types, ['NSPrivacyAccessedAPICategoryDiskSpace']);
  assert.equal(run(dir, 'check').status, 0);
});

test('expo app.config.js: writes app.json when the config spreads it, otherwise prints a snippet', () => {
  const base = {
    'package.json': { name: 'ExpoApp', dependencies: { expo: '52.0.0', 'lib-a': '1.0.0' } },
    'app.json': { expo: { name: 'ExpoApp' } },
    'node_modules/expo/package.json': { name: 'expo', version: '52.0.0' },
    'node_modules/lib-a/package.json': { name: 'lib-a', version: '1.0.0' },
    'node_modules/lib-a/ios/A.swift': 'UserDefaults.standard.set(1, forKey: "k")',
  };

  const spreads = fixture('expo-spread');
  write(spreads, { ...base, 'app.config.js': 'module.exports = ({ config }) => ({ ...config, name: "X" });' });
  const r1 = run(spreads, 'ios', '--write');
  assert.equal(r1.status, 0, r1.stderr);
  assert.match(r1.stdout, /spreads the app\.json config/);
  assert.ok(JSON.parse(fs.readFileSync(path.join(spreads, 'app.json'), 'utf8')).expo.ios.privacyManifests);
  assert.equal(run(spreads, 'check').status, 0);

  const standalone = fixture('expo-dynamic');
  write(standalone, { ...base, 'app.config.js': 'module.exports = { name: "X", ios: { privacyManifests: {} } };' });
  const r2 = run(standalone, 'ios', '--write');
  assert.match(r2.stdout, /cannot edit it/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(standalone, 'app.json'), 'utf8')).expo.ios, undefined, 'app.json untouched');
  const check = run(standalone, 'check');
  assert.equal(check.status, 1);
  assert.match(check.stderr, /cannot read/);
});

test('report groups conditionally linked data as linked', () => {
  const dir = fixture('report');
  write(dir, {
    'package.json': { name: 'App', dependencies: { '@sentry/react-native': '6.0.0' } },
    'node_modules/@sentry/react-native/package.json': { name: '@sentry/react-native', version: '6.0.0' },
  });
  const scan = scanProject(dir);
  const md = formatMarkdown(scan, analyze(scan));
  const linked = md.split('### Data linked to you')[1]?.split('###')[0] ?? '';
  assert.match(linked, /User ID .*@sentry\/react-native\*/);
  assert.match(md, /Google Play Console: Data safety/);
});

test('--help and unknown command', () => {
  assert.match(execFileSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' }), /Commands/);
  assert.equal(run(os.tmpdir(), 'nope').status, 2);
});
