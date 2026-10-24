# NFR-19: image backend ChatOTT (build tu THU MUC GOC du an: docker build -f backend/Dockerfile .)
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY backend ./backend
COPY db ./db
COPY schema.cql ./schema.cql
RUN mkdir -p storage/uploads && chown -R node:node /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "backend/src/app.js"]
