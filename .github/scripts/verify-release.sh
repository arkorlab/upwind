#!/usr/bin/env bash
set -euo pipefail

# This script and the signer policy come from the default-branch checkout, before any release code.
: "${TAG:?TAG is required}" "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}" "${RUNNER_TEMP:?RUNNER_TEMP is required}"
case "$TAG" in
  *$'\r'* | *$'\n'*) echo '::error::release tag must be a single line' >&2; exit 1 ;;
esac
git check-ref-format "refs/tags/${TAG}"
policy_commit="$(git rev-parse --verify 'HEAD^{commit}')"
# A fully qualified ref cannot select a same-named branch. Freeze the object before verifying it.
git fetch --no-tags --quiet origin "+refs/tags/${TAG}:refs/tags/${TAG}"
if ! tag_object="$(git rev-parse --verify "refs/tags/${TAG}^{tag}")"; then
  echo '::error::release requires an annotated tag object' >&2
  exit 1
fi
commit="$(git rev-parse --verify "${tag_object}^{commit}")"

GNUPGHOME="$(mktemp -d "${RUNNER_TEMP}/release-keys.XXXXXXXX")"
export GNUPGHOME
trap 'gpgconf --kill gpg-agent >/dev/null 2>&1 || true; rm -rf -- "$GNUPGHOME"' EXIT
git show "${policy_commit}:.github/release-signers.asc" >"${GNUPGHOME}/signers.asc"
gpg --batch --quiet --import "${GNUPGHOME}/signers.asc"
if ! git -c gpg.program=gpg -c gpg.format=openpgp verify-tag --raw "$tag_object"; then
  echo '::error::release tag signature is not trusted' >&2
  exit 1
fi
# A signed tag object can be reused under another ref; bind the requested name to its signed header.
# Read the entire object so pipefail cannot turn an early reader exit into a SIGPIPE failure.
signed_tag="$(git cat-file tag "$tag_object" | awk '
  /^$/ { in_message = 1 }
  !in_message && /^tag / { tags += 1; name = substr($0, 5) }
  END { if (tags == 1) print name }
')"
if [ "$signed_tag" != "$TAG" ]; then
  echo '::error::signed tag name does not match requested release tag' >&2
  exit 1
fi
if ! git merge-base --is-ancestor "$commit" "$policy_commit"; then
  echo '::error::release tag is outside the trusted branch history' >&2
  exit 1
fi
# Every subsequent package check uses the exact tree that passed both checks.
git checkout --quiet --detach "$commit"
test "$(git rev-parse HEAD)" = "$commit"
printf 'commit=%s\ntag-object=%s\n' "$commit" "$tag_object" >>"$GITHUB_OUTPUT"
