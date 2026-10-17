# Development image of the edge (apps/static) for running it inside the k3d tenant cluster.
# Production images are built in phase 8; this one runs the TypeScript sources with tsx.
FROM node:22-slim
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter static... && chown -R 1000:1000 /repo
USER 1000:1000
WORKDIR /repo/apps/static
EXPOSE 8090
CMD ["node", "--import", "tsx", "src/main.ts"]
