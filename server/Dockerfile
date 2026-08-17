#stage 1
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci

COPY server.ts tsconfig.json ./

RUN npx tsc

#stage2
FROM node:20-alpine

WORKDIR /app


COPY package.json package-lock.json ./

RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist


EXPOSE 8000

CMD ["node", "dist/server.js"]
