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
# /app/data holds the operator panel's settings, so it has to exist in the image
# for the volume to inherit node's ownership.
RUN mkdir -p /app/threads /app/data && chown -R node:node /app

USER node

EXPOSE 8787 8443

# Probes loopback, so it follows TLS when TLS_CERT/TLS_KEY are set and does not
# care that the mounted certificate is for the public name, not 127.0.0.1.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; const p = process.env.PORT || 8787; const s = process.env.TLS_CERT ? 'https' : 'http'; fetch(s + '://127.0.0.1:' + p + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.mjs"]
