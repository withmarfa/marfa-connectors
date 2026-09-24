#!/usr/bin/env bash
# Builds and packs @withmarfa/client from the checkout scripts/monorepo.sh
# made, into vendor/withmarfa-client.tgz, the file the workspace catalog
# names. Once the client is on the registry, the catalog names its version
# and this script goes.
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
# Renamed so no file here carries the placeholder version the tarball's own
# name does.
mv "${out}"/withmarfa-client-*.tgz "${root}/vendor/withmarfa-client.tgz"
