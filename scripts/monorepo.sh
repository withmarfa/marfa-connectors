#!/usr/bin/env bash
# Fetches the monorepo at the commit in scripts/monorepo.commit into
# vendor/marfa and installs it. The client and the proof's server both come
# from that checkout.
#
# MONOREPO_URL names where to fetch from. CI reaches the private monorepo
# through a read-only deploy key, handed to git in GIT_SSH_COMMAND.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
commit="$(tr -d '[:space:]' <"${root}/scripts/monorepo.commit")"
url="${MONOREPO_URL:-git@github.com:withmarfa/marfa.git}"
dir="${root}/vendor/marfa"

# Checked on the directory's own .git: an empty or half-made directory
# would otherwise answer with the enclosing checkout's HEAD.
if [[ ! -e "${dir}/.git" || "$(git -C "${dir}" rev-parse HEAD)" != "${commit}" ]]; then
  rm -rf "${dir}"
  mkdir -p "${dir}"
  git -C "${dir}" init --quiet
  # GitHub serves a commit by its hash, so the pin needs no branch or tag.
  git -C "${dir}" fetch --quiet --depth 1 "${url}" "${commit}"
  git -C "${dir}" checkout --quiet --detach FETCH_HEAD
fi

cd "${dir}"
pnpm install --frozen-lockfile
