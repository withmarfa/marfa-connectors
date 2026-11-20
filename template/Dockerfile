# Build from the repository root using the published client:
#   docker build -f template/Dockerfile --build-arg CONNECTOR=<name> -t <name> .
# CONNECTOR_DIR names the folder when it is not connectors/<name>.
# Only the manifests and the kit's, the shared packages' and the
# connector's sources are copied: `COPY shared shared` takes each shared
# package's package.json, tsconfig.json and src, since .dockerignore leaves
# out everything else under shared/, so no other file in the checkout, such
# as one of secrets, reaches the build.
FROM node:22-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS build
ARG CONNECTOR
ARG CONNECTOR_DIR=connectors/${CONNECTOR}
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY kit/package.json kit/tsconfig.json kit/
COPY kit/src kit/src
COPY shared shared
COPY ${CONNECTOR_DIR}/package.json ${CONNECTOR_DIR}/tsconfig.json ${CONNECTOR_DIR}/
COPY ${CONNECTOR_DIR}/src ${CONNECTOR_DIR}/src
RUN pnpm install --frozen-lockfile --filter "${CONNECTOR}..." --filter marfa-connectors \
  && pnpm exec tsc -b "${CONNECTOR_DIR}" \
  && pnpm --filter "${CONNECTOR}" deploy --prod --legacy /out

FROM node:22-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
WORKDIR /connector
COPY --from=build /out .
USER node
ENTRYPOINT ["node", "dist/main.js"]
CMD ["--every", "15m"]
