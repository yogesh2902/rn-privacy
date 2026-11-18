# Changelog

## 0.3.0
- **`rn-privacy audit`:** checks the privacy manifests your libraries ship. It finds invalid manifests (made-up
  data types, empty purposes, unreadable files), libraries that use required reason APIs without a manifest,
  and manifests that miss categories the code uses, with a link to each library's issue tracker. `--strict`
  exits with code 1 on a problem. `scan` and `report` summarize it, and the GitHub Action adds it to the job summary.
- **Tracking domains:** rn-privacy reads `NSPrivacyTracking` and `NSPrivacyTrackingDomains` from your libraries'
  manifests (CocoaPods SDKs included) and lists them in `scan` and `report`. `ios --write --tracking` (or the
  Expo plugin's `{ "tracking": true }`) sets `NSPrivacyTracking` and declares those domains. Tracking is still
  never turned on without asking. `check` warns when tracking is on but a library's domain is missing.
- Library manifests are validated as SDK manifests, so the SDK-only reasons (`C56D.1`, `0A2A.1`) are allowed there.

## 0.2.0
- **Expo config plugin:** add `"plugins": ["rn-privacy"]` and every prebuild merges what your libraries need
  into `expo.ios.privacyManifests`, so the generated manifest is always current. `check` recognizes the plugin.
  Tested with Expo SDK 52, 54 and 58.
- **GitHub Action:** `uses: yogesh2902/rn-privacy@v0.2.0` runs `check`, annotates the pull request, and writes
  the result and store privacy answers to the job summary.
- Rules: Branch and Segment now follow the privacy manifests those SDKs ship and their current docs. Branch no
  longer claims approximate location, and its device ID is linked and used for tracking. Segment's device ID is
  linked, and advertising data is listed when you use its IDFA plugin. Dead vendor links were replaced.
- `--help` mentions the Expo plugin and the GitHub Action.
- The package is now compiled to CommonJS so the Expo plugin loads on every Node version. `import` and
  `require` both keep working.
- New `play` command: fills in the Google Play Data safety CSV exported from Play Console. It selects the data
  types your libraries collect, marks them as collected, adds purposes, never turns an answer off, keeps the
  file's format, and lists what you still need to answer.
- `check` now validates the manifest against Apple's lists and fails on what App Store Connect rejects with
  ITMS-91056: unknown reason codes, SDK-only reasons (`C56D.1`, `0A2A.1`) in an app, invalid data types or
  purposes, wrong value types, and files that are not valid property lists. Likely mistakes (unknown keys,
  duplicates, tracking domains without `NSPrivacyTracking`) are warnings.
- `ios` refuses to edit an invalid manifest and explains what to fix.

## 0.1.2
- `check` now verifies every manifest your app ships. In an Expo project with an `ios` folder it checks both
  `app.json` and the generated `ios/<App>/PrivacyInfo.xcprivacy`, and tells you when the ios folder is out of
  date and needs `expo prebuild`.
- Rules can target package versions with a semver range (`versions`). The rule that matches the installed
  version is used. Reports show the installed version next to each vendor link.

## 0.1.1
- Add GitHub repository links and more search keywords.

## 0.1.0
- First release: `scan`, `ios`, `report` and `check` commands.
