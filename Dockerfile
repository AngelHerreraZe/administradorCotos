# syntax=docker/dockerfile:1
# Una imagen por servicio:  docker build --build-arg APP=api -t admcotos-api .
#                           docker build --build-arg APP=worker -t admcotos-worker .
# Node 26 ejecuta TypeScript directamente (type stripping): no hay paso de build.
ARG NODE_VERSION=26.13.1

FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /repo
RUN npm install -g npm@12.2.3
COPY package.json package-lock.json .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY packages/db/package.json packages/db/
COPY packages/security/package.json packages/security/
COPY packages/shared/package.json packages/shared/
COPY packages/whatsapp/package.json packages/whatsapp/
RUN npm ci
COPY packages/db/prisma packages/db/prisma
COPY packages/db/prisma.config.ts packages/db/
RUN npm run db:generate && npm prune --omit=dev

FROM node:${NODE_VERSION}-alpine AS runtime
ARG APP
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=deps --chown=node:node /repo/node_modules node_modules
COPY --from=deps --chown=node:node /repo/packages/db/src/generated packages/db/src/generated
COPY --chown=node:node package.json ./
COPY --chown=node:node packages packages
COPY --chown=node:node apps/${APP} apps/${APP}
# Sin root, sin shell de build, sin código de otros servicios.
USER node
WORKDIR /repo/apps/${APP}
# node como PID 1: recibe SIGTERM directo y hace el apagado ordenado de main.ts.
CMD ["node", "--import", "./src/instrument.ts", "src/main.ts"]
