ARG BUILD_FROM
FROM node:20-alpine AS builder

WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY src/ ./src/
COPY index.html vite.config.js ./
RUN npm run build

FROM ${BUILD_FROM}

RUN apk add --no-cache nodejs npm

WORKDIR /app

COPY server/package.json ./server/
RUN cd server && npm install --production

COPY server/ ./server/
COPY --from=builder /build/dist ./dist/
COPY addon/run.sh /run.sh
RUN chmod +x /run.sh

CMD ["/run.sh"]
