# Changelog

## 0.2.0
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
