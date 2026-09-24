#!/usr/bin/env bash
# Fetches the monorepo at the commit in scripts/monorepo.commit into
# vendor/marfa and installs it. The client and the proof's server both come
# from that checkout.
#
# The monorepo is private. By hand, the fetch uses whatever SSH identity
# reaches GitHub. CI hands the repository's read-only deploy key in
# MONOREPO_DEPLOY_KEY, which serves the fetch alone: it is out of the
# environment and off the disk before the install runs anyone's scripts.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
commit="$(tr -d '[:space:]' <"${root}/scripts/monorepo.commit")"
dir="${root}/vendor/marfa"
deploy_key="${MONOREPO_DEPLOY_KEY:-}"
unset MONOREPO_DEPLOY_KEY

key_dir=""
forget_key() {
  if [[ -n "${key_dir}" ]]; then rm -rf "${key_dir}"; fi
  key_dir=""
  unset GIT_SSH_COMMAND
}
trap forget_key EXIT

# Checked on the directory's own .git: an empty or half-made directory
# would otherwise answer with the enclosing checkout's HEAD.
if [[ ! -e "${dir}/.git" || "$(git -C "${dir}" rev-parse HEAD)" != "${commit}" ]]; then
  if [[ -n "${deploy_key}" ]]; then
    key_dir="$(mktemp -d)"
    (umask 077 && printf '%s\n' "${deploy_key}" >"${key_dir}/key")
    # GitHub's published host key, so the connection is verified without
    # trusting whatever answers first.
    echo "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl" >"${key_dir}/known_hosts"
    export GIT_SSH_COMMAND="ssh -i ${key_dir}/key -o IdentitiesOnly=yes -o UserKnownHostsFile=${key_dir}/known_hosts -o StrictHostKeyChecking=yes"
  fi
  rm -rf "${dir}"
  mkdir -p "${dir}"
  git -C "${dir}" init --quiet
  # GitHub serves a commit by its hash, so the pin needs no branch or tag.
  git -C "${dir}" fetch --quiet --depth 1 git@github.com:withmarfa/marfa.git "${commit}"
  git -C "${dir}" checkout --quiet --detach FETCH_HEAD
  forget_key
fi
deploy_key=""

cd "${dir}"
pnpm install --frozen-lockfile
