# Built from the repository root, once scripts/monorepo.sh and
# scripts/vendor-client.sh have packed the client into vendor/:
#
#   docker build -f template/Dockerfile --build-arg CONNECTOR=<name> -t <name> .
#
# The image runs one connector as a long-lived process. Its state directory
# needs no volume: losing the state costs a full read and never a duplicate.
FROM node:22-slim AS build
ARG CONNECTOR
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm build \
  && pnpm --filter "${CONNECTOR}" deploy --prod --legacy /out

FROM node:22-slim
WORKDIR /connector
COPY --from=build /out .
RUN mkdir /state && chown node /state
ENV MARFA_STATE_DIR=/state
USER node
ENTRYPOINT ["node", "dist/main.js"]
CMD ["--every", "15m"]
