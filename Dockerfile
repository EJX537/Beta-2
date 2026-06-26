# ---- Build stage ----
FROM node:24-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- Production stage ----
FROM node:24-alpine AS production
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

USER app
EXPOSE 8080
ENV NODE_ENV=production
CMD ["node", "--enable-source-maps", "dist/index.js"]
