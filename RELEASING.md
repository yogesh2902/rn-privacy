# Releasing

Releases are published to npm by the [`release` workflow](.github/workflows/release.yml) when a GitHub release
is published. It uses [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/): no npm token is
stored anywhere, nobody needs to run `npm login`, and npm adds a provenance statement that links each version
to the commit and workflow that built it.

## One-time setup (on npmjs.com)

1. Open https://www.npmjs.com/package/rn-privacy/access (package **Settings**).
2. Under **Trusted publishing**, choose **GitHub Actions** and fill in:
   - Organization or user: `yogesh2902`
   - Repository: `rn-privacy`
   - Workflow filename: `release.yml`
   - Environment: leave empty
3. Save. Optional but recommended: under **Publishing access**, choose
   "Require two-factor authentication and disallow tokens", so the workflow is the only way to publish.

## Each release

1. In a pull request, bump `version` in `package.json` (and `package-lock.json` with
   `npm version <x.y.z> --no-git-tag-version`), and add the changes to `CHANGELOG.md`.
   If the GitHub Action docs mention a version (`@vX.Y.Z` in README.md and the CLI help), update them too.
2. Merge it once CI passes.
3. Create a GitHub release for tag `vX.Y.Z` on `main`, with the changelog section as the notes.
   Tick "Publish this Action to the GitHub Marketplace".
4. The `release` workflow checks that the tag matches `package.json`, runs the tests and publishes.
   Watch it under **Actions**; the new version appears on npm a few minutes later.
