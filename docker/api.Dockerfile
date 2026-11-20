FROM node:22-alpine AS build
WORKDIR /app
COPY backend/package*.json ./backend/
RUN cd backend && npm ci --omit=dev
COPY backend/ ./backend/

FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache ffmpeg \
    && mkdir -p /app/storage /app/tmp \
    && chown -R node:node /app
COPY --chown=node:node --from=build /app/backend/node_modules ./node_modules
COPY --chown=node:node --from=build /app/backend/package.json ./
COPY --chown=node:node --from=build /app/backend/server.js ./
COPY --chown=node:node --from=build /app/backend/src ./src
USER node
ENV NODE_ENV=production
EXPOSE 3001
CMD ["node", "server.js"]
