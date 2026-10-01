#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
commit="$(tr -d '[:space:]' <"${root}/scripts/monorepo.commit")"
dir="${root}/vendor/marfa"
# Checked on the directory's own .git: an empty or half-made directory
# would otherwise answer with the enclosing checkout's HEAD.
if [[ ! -e "${dir}/.git" || "$(git -C "${dir}" rev-parse HEAD)" != "${commit}" ]]; then
  rm -rf "${dir}"
  mkdir -p "${dir}"
  git -C "${dir}" init --quiet
  # GitHub serves a commit by its hash, so the pin needs no branch or tag.
  git -C "${dir}" fetch --quiet --depth 1 https://github.com/withmarfa/marfa.git "${commit}"
  git -C "${dir}" checkout --quiet --detach FETCH_HEAD
fi

cd "${dir}"
pnpm install --frozen-lockfile
