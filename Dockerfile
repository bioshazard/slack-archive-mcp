FROM oven/bun:1.4.0 AS build
WORKDIR /build
COPY package.json bun.lock ./
RUN --mount=type=cache,id=slack-archive-mcp-bun,target=/root/.bun/install/cache bun install --frozen-lockfile --production --network-concurrency=8
COPY src ./src
RUN bun build src/cli.ts --target=bun --outdir=/out --minify

FROM oven/bun:1.4.0-slim
WORKDIR /workspace
ENV ARCHIVE_DIR=/output
COPY --from=build --chown=bun:bun /out/cli.js /app/cli.js
USER bun
ENTRYPOINT ["bun", "/app/cli.js"]
CMD ["--help"]
