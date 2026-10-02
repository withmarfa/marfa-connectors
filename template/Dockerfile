# Build from the repository root, after scripts/monorepo.sh and
# scripts/vendor-client.sh have packed the client into vendor/:
#   docker build -f template/Dockerfile --build-arg CONNECTOR=<name> -t <name> .
# CONNECTOR_DIR names the folder when it is not connectors/<name>.
# Only the manifests, the packed client and the kit's and the connector's
# sources are copied, so no other file in the checkout, such as one of
# secrets, reaches the build.
FROM node:26-slim@sha256:ec7758ee051e457b468b32bde57b0879010b325bb9862718e9615225ce4aaae1 AS build
ARG CONNECTOR
ARG CONNECTOR_DIR=connectors/${CONNECTOR}
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY vendor/withmarfa-client.tar vendor/
COPY kit/package.json kit/tsconfig.json kit/
COPY kit/src kit/src
COPY ${CONNECTOR_DIR}/package.json ${CONNECTOR_DIR}/tsconfig.json ${CONNECTOR_DIR}/
COPY ${CONNECTOR_DIR}/src ${CONNECTOR_DIR}/src
RUN pnpm install --frozen-lockfile --filter "${CONNECTOR}..." --filter marfa-connectors \
  && pnpm exec tsc -b "${CONNECTOR_DIR}" \
  && pnpm --filter "${CONNECTOR}" deploy --prod --legacy /out

FROM node:26-slim@sha256:ec7758ee051e457b468b32bde57b0879010b325bb9862718e9615225ce4aaae1
WORKDIR /connector
COPY --from=build /out .
USER node
ENTRYPOINT ["node", "dist/main.js"]
CMD ["--every", "15m"]
