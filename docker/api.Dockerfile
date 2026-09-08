FROM node:22-alpine AS build
WORKDIR /app
COPY backend/package*.json ./backend/
RUN cd backend && npm ci --production=false
COPY backend/ ./backend/
RUN cd backend && npm run build 2>/dev/null || true

FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache ffmpeg
COPY --from=build /app/backend/node_modules ./node_modules
COPY --from=build /app/backend/package.json ./
COPY --from=build /app/backend/server.js ./
COPY --from=build /app/backend/src ./src
ENV NODE_ENV=production
EXPOSE 3001
CMD ["node", "server.js"]
