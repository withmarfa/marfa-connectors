#!/usr/bin/env bash
# Hands the monorepo's read-only deploy key to every later step's git,
# through GIT_SSH_COMMAND. The key file lives in the job's own temporary
# directory, which the runner empties when the job ends.
set -euo pipefail

: "${MONOREPO_DEPLOY_KEY:?the MONOREPO_DEPLOY_KEY secret is not set}"
key="${RUNNER_TEMP}/monorepo-deploy-key"
known="${RUNNER_TEMP}/github-known-hosts"
printf '%s\n' "${MONOREPO_DEPLOY_KEY}" >"${key}"
chmod 600 "${key}"
# GitHub's published host key, so the connection is verified without
# trusting whatever answers first.
echo "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl" >"${known}"
echo "GIT_SSH_COMMAND=ssh -i ${key} -o IdentitiesOnly=yes -o UserKnownHostsFile=${known} -o StrictHostKeyChecking=yes" >>"${GITHUB_ENV}"
