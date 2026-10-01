#!/usr/bin/env bash
# Unzipped: the gzip stream differs with the Node version that wrote it, and
# pnpm locks the checksum of the bytes it is given.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
dir="${root}/vendor/marfa"
if [[ ! -e "${dir}/.git" ]]; then
  echo "vendor-client: no monorepo checkout; run scripts/monorepo.sh first" >&2
  exit 1
fi

out="$(mktemp -d)"
trap 'rm -rf "${out}"' EXIT
(
  cd "${dir}"
  pnpm --filter @withmarfa/client build
  pnpm --filter @withmarfa/client pack --pack-destination "${out}"
)
gzip -dc "${out}"/withmarfa-client-*.tgz >"${root}/vendor/withmarfa-client.tar"
