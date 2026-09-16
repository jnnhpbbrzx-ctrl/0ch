FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backend/package.json ./backend/
RUN cd backend && npm install --omit=dev

COPY frontend/package.json ./frontend/
RUN cd frontend && npm install

COPY frontend ./frontend
RUN cd frontend && npm run build

COPY backend ./backend
RUN mkdir -p /app/backend/data /app/uploads

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/app/backend/data/messenger.db

EXPOSE 3000
CMD ["node", "backend/server.js"]
