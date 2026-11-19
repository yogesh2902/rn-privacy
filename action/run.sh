#!/usr/bin/env bash
# Runs `rn-privacy check` for the GitHub Action: annotations, job summary, and the exit code.
set -uo pipefail

spec="${INPUT_VERSION:-latest}"
case "$spec" in
  */* | *.tgz) ;;                    # a local path or tarball (used to test the action itself)
  *) spec="rn-privacy@$spec" ;;
esac

cd "${INPUT_PROJECT:-.}" || { echo "::error title=rn-privacy::Folder not found: ${INPUT_PROJECT}"; exit 1; }

out="$(npx --yes --package "$spec" rn-privacy check 2>&1)"
code=$?
echo "$out"

if [ "$code" -eq 0 ]; then result=pass; else result=fail; fi
echo "result=$result" >> "${GITHUB_OUTPUT:-/dev/null}"

# Annotations show up on the pull request's Checks tab.
[ "${INPUT_ANNOTATIONS:-true}" = "true" ] && while IFS= read -r line; do
  msg="$(echo "$line" | sed -E 's/^[[:space:]]+//')"
  case "$msg" in
    "✗ "*) echo "::error title=rn-privacy::${msg#✗ }" ;;
    "! "*) echo "::warning title=rn-privacy::${msg#! }" ;;
  esac
done <<< "$out"

# Privacy changes since the committed snapshot (privacy-snapshot.json), when the project has one.
diff_out=""
privacy_changes=false
if [ -f privacy-snapshot.json ]; then
  diff_out="$(npx --yes --package "$spec" rn-privacy diff 2>&1)"
  if ! echo "$diff_out" | grep -q "No privacy changes\|no privacy changes"; then
    privacy_changes=true
    [ "${INPUT_ANNOTATIONS:-true}" = "true" ] && echo "::warning title=rn-privacy::Privacy changes are not in privacy-snapshot.json. Review them, then run npx rn-privacy snapshot and commit it."
  fi
fi
echo "privacy-changes=$privacy_changes" >> "${GITHUB_OUTPUT:-/dev/null}"

# One comment per app on the pull request, updated on every push. A hidden marker finds it again.
if [ "${INPUT_COMMENT:-true}" = "true" ] && [ -n "${PR_NUMBER:-}" ] && [ -n "${GH_TOKEN:-}" ]; then
  label="${INPUT_PROJECT_LABEL:-.}"
  marker="<!-- rn-privacy-comment:${label} -->"
  existing="$(gh api "repos/$REPO/issues/$PR_NUMBER/comments" --paginate --jq ".[] | select(.body | contains(\"$marker\")) | .id" 2>/dev/null | head -n 1)"
  # Comment when there is something to say, or to turn an earlier comment green.
  if [ "$result" = fail ] || [ "$privacy_changes" = true ] || [ -n "$existing" ]; then
    where=""
    [ "$label" != "." ] && where=" (\`$label\`)"
    body_file="$(mktemp)"
    {
      echo "$marker"
      if [ "$result" = pass ]; then
        echo "### ✅ rn-privacy: privacy manifest OK$where"
      else
        echo "### ❌ rn-privacy: privacy manifest needs attention$where"
        echo
        echo "Run \`npx rn-privacy ios --write\` to add what is missing. Invalid entries must be fixed by hand."
      fi
      echo
      echo '```'
      echo "$out" | head -c 20000
      echo '```'
      if [ "$privacy_changes" = true ]; then
        echo
        echo "#### Privacy changes in this pull request"
        echo
        echo '```'
        echo "$diff_out" | head -c 20000
        echo '```'
        echo
        echo "Review them, update your App Store and Google Play answers if needed, then run \`npx rn-privacy snapshot\` and commit \`privacy-snapshot.json\`."
      fi
      echo
      echo "<sub>[rn-privacy](https://github.com/yogesh2902/rn-privacy) · updated on every push · a starting point, not legal advice</sub>"
    } > "$body_file"
    if [ -n "$existing" ]; then
      comment_id="$(gh api -X PATCH "repos/$REPO/issues/comments/$existing" -F "body=@$body_file" --jq .id 2>/dev/null)"
    else
      comment_id="$(gh api "repos/$REPO/issues/$PR_NUMBER/comments" -F "body=@$body_file" --jq .id 2>/dev/null)"
    fi
    rm -f "$body_file"
    if [ -n "$comment_id" ]; then
      echo "comment-id=$comment_id" >> "${GITHUB_OUTPUT:-/dev/null}"
    else
      echo "::warning title=rn-privacy::Could not comment on the pull request. Add 'permissions: pull-requests: write' to the job. Pull requests from forks get a read-only token, so they cannot be commented on."
    fi
  fi
fi

if [ "${INPUT_SUMMARY:-true}" = "true" ] && [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    if [ "$result" = pass ]; then
      echo "## ✅ rn-privacy: privacy manifest OK"
    else
      echo "## ❌ rn-privacy: privacy manifest needs attention"
      echo
      echo "Run \`npx rn-privacy ios --write\` locally to add what is missing. Invalid entries must be fixed by hand."
    fi
    echo
    echo '```'
    echo "$out"
    echo '```'
    echo
    if [ -n "$diff_out" ]; then
      echo "### Privacy changes since privacy-snapshot.json"
      echo
      echo '```'
      echo "$diff_out"
      echo '```'
      echo
    fi
    echo "<details><summary>Library audit: privacy manifests your libraries ship</summary>"
    echo
    echo '```'
    npx --yes --package "$spec" rn-privacy audit 2>/dev/null || echo "Could not run the audit."
    echo '```'
    echo
    echo "</details>"
    echo
    echo "<details><summary>Store privacy answers (App Store Connect and Google Play)</summary>"
    echo
    npx --yes --package "$spec" rn-privacy report 2>/dev/null || echo "_Could not build the report._"
    echo
    echo "</details>"
    echo
    echo "<sub>Generated by [rn-privacy](https://github.com/yogesh2902/rn-privacy). A starting point, not legal advice.</sub>"
  } >> "$GITHUB_STEP_SUMMARY"
fi

if [ "$result" = fail ] && [ "${INPUT_FAIL:-true}" = "true" ]; then
  exit 1
fi
exit 0
