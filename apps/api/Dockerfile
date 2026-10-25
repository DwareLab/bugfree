FROM node:24-slim AS build
WORKDIR /repo
COPY . .
RUN npm ci --no-audit --no-fund && npm run build -w @bugfree/api

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production PORT=4100
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/api/migrations ./migrations
USER node
EXPOSE 4100
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
