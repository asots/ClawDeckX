# Stage 1: Build frontend
FROM node:22-alpine AS frontend
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
COPY templates/ /app/templates/
ARG BUILD_NUMBER=0
RUN echo "${BUILD_NUMBER}" > ../build.txt
RUN npm run build

# Stage 2: Build backend
FROM golang:1.24-alpine AS backend
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=frontend /app/internal/web/dist ./internal/web/dist
ARG VERSION=0.0.1
ARG BUILD_NUMBER=0
RUN COMPAT=$(grep -o '"openclawCompat"[[:space:]]*:[[:space:]]*"[^"]*"' web/package.json | cut -d'"' -f4) && \
    CGO_ENABLED=0 GOOS=linux go build \
    -ldflags="-s -w -X ClawDeckX/internal/version.Version=${VERSION} -X ClawDeckX/internal/version.Build=${BUILD_NUMBER} -X 'ClawDeckX/internal/version.OpenClawCompat=${COMPAT}'" \
    -o /clawdeckx ./cmd/clawdeckx

# Stage 3: Install OpenClaw with native modules (build tools needed)
FROM ubuntu:22.04 AS openclaw-builder
ENV DEBIAN_FRONTEND=noninteractive
ARG OPENCLAW_VERSION=latest
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ca-certificates curl git gnupg python3 make g++ && \
    mkdir -p /etc/apt/keyrings && \
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
        | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg && \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
        > /etc/apt/sources.list.d/nodesource.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/*
RUN npm install -g "openclaw@${OPENCLAW_VERSION}" && \
    OPENCLAW_SOURCE="$(npm root -g)/openclaw" && \
    test -f "${OPENCLAW_SOURCE}/openclaw.mjs" && \
    mkdir -p /opt && \
    cp -a "${OPENCLAW_SOURCE}" /opt/openclaw && \
    OPENCLAW_TARGET=/opt/openclaw/openclaw.mjs && \
    printf '%s\n' '#!/bin/sh' "exec ${OPENCLAW_TARGET} \"\$@\"" > /usr/local/bin/openclaw && \
    chmod +x /usr/local/bin/openclaw && \
    /usr/local/bin/openclaw --version > /tmp/openclaw-version && \
    find /opt/openclaw -name '*.map' -print | xargs rm -f 2>/dev/null || true

# Stage 4: Runtime (no build tools)
FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl git gnupg && \
    mkdir -p /etc/apt/keyrings && \
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
        | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg && \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
        > /etc/apt/sources.list.d/nodesource.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
        nodejs python3 make tzdata tini wget jq ripgrep procps lsof ffmpeg golang && \
    rm -rf /var/lib/apt/lists/* && \
    # Install uv via official standalone installer (no pip needed)
    curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh

ARG BUILD_VERSION=0.0.0
ARG BUILD_REVISION=unknown
ARG BUILD_DATE=unknown
ARG OPENCLAW_VERSION=latest
ARG BUILD_NUMBER=0
ARG VERSION=0.0.1
ARG OPENCLAW_COMPAT=unknown
LABEL org.opencontainers.image.title="ClawDeckX" \
      org.opencontainers.image.description="Desktop management dashboard for OpenClaw AI gateway" \
      org.opencontainers.image.version="${BUILD_VERSION}" \
      org.opencontainers.image.revision="${BUILD_REVISION}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.url="https://github.com/ClawDeckX/ClawDeckX" \
      org.opencontainers.image.documentation="https://github.com/ClawDeckX/ClawDeckX#readme" \
      org.opencontainers.image.source="https://github.com/ClawDeckX/ClawDeckX" \
      org.opencontainers.image.licenses="MIT" \
      ai.clawdeckx.openclaw.version="${OPENCLAW_VERSION}" \
      ai.clawdeckx.openclaw.compat="${OPENCLAW_COMPAT}"

WORKDIR /app
COPY --from=openclaw-builder /opt/openclaw /opt/openclaw
COPY --from=openclaw-builder /usr/local/bin/openclaw /usr/local/bin/openclaw
COPY --from=backend /clawdeckx ./clawdeckx
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN mkdir -p /data/clawdeckx /data/openclaw/npm /data/openclaw/state /data/openclaw/logs /data/openclaw/bootstrap /data/runtime/clawdeckx /data/runtime/openclaw && \
    chmod +x ./clawdeckx /app/docker-entrypoint.sh && \
    ln -sf /app/clawdeckx /usr/local/bin/clawdeckx
VOLUME ["/data"]
EXPOSE 18788 18789
ENV OCD_DB_SQLITE_PATH=/data/clawdeckx/ClawDeckX.db \
    OCD_LOG_FILE=/data/clawdeckx/ClawDeckX.log \
    OPENCLAW_HOME=/data/openclaw/home \
    OPENCLAW_STATE_DIR=/data/openclaw/state \
    OPENCLAW_CONFIG_PATH=/data/openclaw/state/openclaw.json \
    NPM_CONFIG_PREFIX=/data/openclaw/npm \
    OCD_GATEWAY_LOG=/data/openclaw/logs/gateway.log \
    OCD_SETUP_INSTALL_LOG=/data/openclaw/logs/install.log \
    OCD_SETUP_DOCTOR_LOG=/data/openclaw/logs/doctor.log \
    PATH=/data/openclaw/npm/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    OCD_RUNTIME_DIR=/data/runtime \
    OCD_BIND=0.0.0.0 \
    OCD_PORT=18788 \
    TZ=UTC
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -sf http://localhost:${OCD_PORT:-18788}/api/v1/health || exit 1
ENTRYPOINT ["/usr/bin/tini", "-s", "--"]
CMD ["/app/docker-entrypoint.sh"]
