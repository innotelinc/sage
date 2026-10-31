# syntax=docker/dockerfile:1
# SAGE — course-taking agent by Innotel Labs (https://innotel.us)
# No runtime dependencies: the image is Node plus the source, nothing to npm install.
FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=8787

WORKDIR /app

COPY package.json ./
COPY server.mjs worker.mjs ./
COPY src ./src
COPY public ./public

# Transcripts live under /app/threads; the relay keeps frames in memory only.
RUN mkdir -p /app/threads && chown -R node:node /app

USER node

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.mjs"]
