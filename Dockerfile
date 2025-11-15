# --- Client build stage ---
FROM node:20-alpine AS client-build
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# --- Server production deps ---
FROM node:20-alpine AS server-deps
WORKDIR /app
COPY package.json ./
RUN npm install --production --no-audit --no-fund

# --- Final runtime image ---
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

# Install server production deps
COPY --from=server-deps /app/node_modules ./node_modules
COPY package*.json ./

# App source
COPY server/ ./server/
COPY public/ ./public/
COPY scripts/ ./scripts/

# Built client assets
COPY --from=client-build /app/client/dist ./client/dist

EXPOSE 3000
CMD ["node", "server/index.js"]
