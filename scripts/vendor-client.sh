#!/usr/bin/env bash
# Builds and packs @withmarfa/client from the checkout scripts/monorepo.sh
# made, and unpacks the tarball into vendor/withmarfa-client, the directory
# the override in pnpm-workspace.yaml names. Once the client is on the
# registry, the override names its version and this script goes.
#
# The dependency is the tarball's contents rather than the tarball: the
# packed files are the same on every machine, but the gzip stream around
# them differs with the Node version that wrote it, and pnpm would lock the
# stream's checksum.
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
target="${root}/vendor/withmarfa-client"
rm -rf "${target}"
mkdir -p "${target}"
tar -xzf "${out}"/withmarfa-client-*.tgz -C "${target}" --strip-components 1
