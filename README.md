# rn-privacy

[![npm](https://img.shields.io/npm/v/rn-privacy)](https://www.npmjs.com/package/rn-privacy)
[![test](https://github.com/yogesh2902/rn-privacy/actions/workflows/test.yml/badge.svg)](https://github.com/yogesh2902/rn-privacy/actions/workflows/test.yml)
[![license](https://img.shields.io/npm/l/rn-privacy)](LICENSE)

**Privacy manifest and store privacy forms for React Native and Expo apps, generated from your dependencies.**

Every iOS release needs a correct `PrivacyInfo.xcprivacy`, and both stores ask what data your app collects
(App Store Connect **App Privacy**, Google Play **Data safety**). Most of that data is collected by your
libraries (Firebase, Sentry, AdMob...), not by your own code. `rn-privacy` scans them and tells you what to declare.

```bash
npx rn-privacy            # what your libraries collect and which Apple APIs they use
npx rn-privacy ios --write  # update PrivacyInfo.xcprivacy (bare) or app.json (Expo)
npx rn-privacy report -o store-privacy.md  # answers for both store forms
npx rn-privacy check      # for CI: fails if the manifest is missing something
```

## What it does

- **Finds Apple "required reason" APIs** (User defaults, File timestamps, System boot time, Disk space,
  Active keyboards) by scanning the iOS source code of every native dependency, and by reading the
  privacy manifests libraries ship. Missing these gets your upload rejected (`ITMS-91053`).
- **Knows what popular SDKs collect** (Firebase, Sentry, AdMob, Meta, Mixpanel, Amplitude, PostHog,
  Segment, RevenueCat, OneSignal, AppsFlyer, Branch, BugSnag, Datadog...) and maps it to both Apple's
  and Google's categories.
- **Reads `ios/Pods`** after `pod install`, so the native SDKs that CocoaPods downloads are covered too.
- **Merges, never overwrites.** Existing entries in your manifest are kept; it only adds what is missing.
  Dry run by default.
- **Works with Expo.** In a managed project it updates `expo.ios.privacyManifests` in `app.json`
  (or prints the snippet if you use `app.config.js`).

## Example

```
$ npx rn-privacy
rn-privacy scan  (bare, 12 packages, 10 with iOS native code)

Required reason APIs (Apple privacy manifest)
  User defaults      CA92.1
                     used by @react-native-firebase/app, react-native, react-native-device-info
  File timestamps    3B52.1, C617.1
                     used by @react-native-async-storage/async-storage, react-native, react-native-fs
  Disk space         85F4.1
                     used by react-native-device-info, react-native-fs

Data collected by your libraries
  Device ID              Analytics, Third-party advertising (tracking)
                         by @react-native-firebase/analytics, react-native-google-mobile-ads
  Crash data             App functionality, Analytics
                         by @sentry/react-native, react-native-google-mobile-ads
  User ID                App functionality (linked to user)
                         @sentry/react-native: Only if you call Sentry.setUser()

Sensitive data your app can read
  Declare it only if your app sends it off the device.
  Photos or videos       via react-native-image-picker
```

## Commands

| Command | What it does |
| --- | --- |
| `scan` (default) | Prints required reason APIs, collected data, sensitive device access and warnings. `--format json` for machines. |
| `ios` | Shows what it would add to your manifest. `--write` saves it. `--include-conditional` also declares data that is only collected in some setups (e.g. after `Sentry.setUser()`). |
| `report` | Markdown (or `--format json`) with tables for App Store Connect and Google Play. `-o file.md` to save. |
| `check` | Exit code 1 if a required reason API category is missing from your manifest. Warns about undeclared data. In an Expo project with an `ios` folder, it checks both `app.json` and the generated `PrivacyInfo.xcprivacy`, so a stale prebuild is caught too. |

All commands accept `--project <dir>` (default: current folder).

### Use it in CI

```yaml
- run: npm ci
- run: npx rn-privacy check
```

Adding a new library that needs a declaration now fails the build instead of the App Store upload.

**Expo with prebuild:** the privacy manifest in `app.json` only reaches the app when `expo prebuild` writes it
into `ios/`. Run `check` after prebuild in CI to verify what actually ships:

```yaml
- run: npx expo prebuild --platform ios --no-install
- run: npx rn-privacy check
```

## How it works

1. Reads the `dependencies` in your `package.json` (not `devDependencies`), plus native packages they pull in
   (Expo autolinking links transitive modules too).
2. For each package with iOS native code, scans `.m`, `.mm`, `.swift` and `.h` files (skipping `example/`,
   tests and Android code) for the symbols Apple lists, and parses any `PrivacyInfo.xcprivacy` it ships.
3. Looks the package up in the [rules database](src/rules.ts) for the data it collects, using the rule for
   the installed version when a library's data collection changed between versions.
4. Merges everything into one result.

When a library uses an API but gives no reason, rn-privacy suggests the reason most React Native apps use
(the same ones React Native's own template uses) and marks it **suggested**. Review those: the right reason
depends on what your app does. Reasons Apple only allows for SDKs (`C56D.1`, `0A2A.1`) are never copied
into your app's manifest.

## Limits (please read)

- **It is a starting point, not legal advice.** You are responsible for what you declare.
- It only knows the data collection of libraries in its rules database. Libraries without a rule are still
  scanned for required reason APIs, but their data collection is not known.
- It cannot see what **your own code or backend** does with data (for example, sending the user's email
  to your server). Add that yourself.
- What an SDK collects depends on its version and your configuration. Every rule links to the vendor's
  disclosure page: `rn-privacy report` lists them at the end. Check them.
- `NSPrivacyTracking` and `NSPrivacyTrackingDomains` are never switched on automatically. If you use ad or
  attribution SDKs, set them yourself together with App Tracking Transparency.
- Prebuilt binary frameworks inside `node_modules` cannot be scanned. You get a warning when one ships
  without a privacy manifest.

## Contributing rules

The rules database is the most valuable part of this project. To add or fix a library, edit
[`src/rules.ts`](src/rules.ts), link the vendor's official disclosure page in `sources`, and run `npm test`.

Required reason APIs are never taken from rules: they come from scanning the installed code, so they always
match the version you have. Rules only describe **data collection**. If that changed between versions of a
library, add one rule per range with `versions` (a semver range such as `">=6.0.0"` or `"^5.2.0 || ^6.0.0"`).
The first rule whose range matches the installed version is used, and a rule without `versions` is the fallback.

## License

MIT
