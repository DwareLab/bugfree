# Build from the repository root: docker build -f packages/docker-agent/Dockerfile .
FROM node:24-slim AS build
WORKDIR /repo
COPY . .
RUN npm ci --no-audit --no-fund && npm run build -w @dwarelab/bugfree-core && npm run build -w @dwarelab/bugfree-docker-agent

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production BUGFREE_STATE_DIR=/data
COPY --from=build /repo/packages/docker-agent/dist/index.js ./index.js
# Runs as root: reading /var/run/docker.sock needs it (or point DOCKER_HOST at a read-only socket proxy).
VOLUME /data
CMD ["node", "index.js"]
