#!/usr/bin/env bash
# Builds and packs @withmarfa/client from the checkout scripts/monorepo.sh
# made, into vendor/withmarfa-client.tar, the file the override in
# pnpm-workspace.yaml names. Once the client is on the registry, the
# override names its version, and this script goes with the CI steps that
# run it.
#
# Unzipped, because the packed files are the same on every machine but the
# gzip stream around them differs with the Node version that wrote it, and
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
