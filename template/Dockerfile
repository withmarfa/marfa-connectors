# Build from the repository root, after scripts/monorepo.sh and
# scripts/vendor-client.sh have packed the client into vendor/:
#   docker build -f template/Dockerfile --build-arg CONNECTOR=<name> -t <name> .
# Only the manifests, the packed client and the kit's and the connector's
# sources are copied, so no other file in the checkout, such as one of
# secrets, reaches the build.
FROM node:22-slim AS build
ARG CONNECTOR
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY vendor/withmarfa-client.tar vendor/
COPY kit/package.json kit/tsconfig.json kit/
COPY kit/src kit/src
COPY connectors/${CONNECTOR}/package.json connectors/${CONNECTOR}/tsconfig.json connectors/${CONNECTOR}/
COPY connectors/${CONNECTOR}/src connectors/${CONNECTOR}/src
RUN pnpm install --frozen-lockfile --filter "${CONNECTOR}..." --filter marfa-connectors \
  && pnpm exec tsc -b "connectors/${CONNECTOR}" \
  && pnpm --filter "${CONNECTOR}" deploy --prod --legacy /out

FROM node:22-slim
WORKDIR /connector
COPY --from=build /out .
USER node
ENTRYPOINT ["node", "dist/main.js"]
CMD ["--every", "15m"]
