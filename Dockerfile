# Single service: the Express process serves the API and the frontend.
FROM node:22-slim

WORKDIR /app

# sqlite3 ships prebuilt binaries for this base image, so no build toolchain
# is needed here.
COPY backend/package*.json ./backend/
RUN cd backend && npm ci --omit=dev

COPY backend ./backend
COPY frontend ./frontend

ENV NODE_ENV=production
ENV PORT=3000
# JWT_SECRET is deliberately not defaulted. The server exits rather than boot
# with a guessable signing key.

EXPOSE 3000

# The default DATABASE_FILE is relative to the working directory. Mount a
# volume here for anything with real users: an ephemeral filesystem loses the
# database on every restart.
WORKDIR /app/backend

CMD ["node", "server.js"]
