# syntax=docker/dockerfile:1
# Self-host web image. Build from the repo root (the prebuild packs ../plugins): docker build -f web/Dockerfile .
FROM node:22-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS build
WORKDIR /repo/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --ignore-scripts
COPY plugins /repo/plugins
COPY web ./
ENV NEXT_OUTPUT=standalone NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build /repo/web/.next/standalone ./
COPY --from=build /repo/web/.next/static ./.next/static
COPY --from=build /repo/web/public ./public
USER node
EXPOSE 3000
CMD ["node", "server.js"]
