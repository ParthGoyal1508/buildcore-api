FROM node:20-slim AS builder

# node:*-slim ships without OpenSSL, which the Prisma query engine needs both to
# detect the right binary target at `generate` time and to dlopen at runtime.
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# A wildcard is used to ensure both package.json AND package-lock.json are copied
COPY package*.json ./
COPY prisma ./prisma/

# Install app dependencies.
#
# ONNXRUNTIME_NODE_INSTALL=skip: on linux/x64, onnxruntime-node's postinstall otherwise downloads
# its CUDA 12 GPU provider — a large download this CPU-only instance never loads. The CPU build the
# face matcher uses ships inside the package itself.
#
# The prune drops the macOS and Windows binaries the same package bundles (~220 MB of the image).
ENV ONNXRUNTIME_NODE_INSTALL=skip
RUN npm install \
  && find node_modules/onnxruntime-node/bin/napi-v6 -mindepth 1 -maxdepth 1 ! -name linux -exec rm -rf {} +

COPY . .

RUN npm run build

FROM node:20-slim

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/dist ./dist
# The migrations and schema must exist in the runtime image too — `migrate deploy`
# below reads them from disk, and without this the container starts against
# whatever schema the database happens to already have.
COPY --from=builder /app/prisma ./prisma

EXPOSE 3000
# Apply any pending migrations before the app accepts traffic. `migrate deploy` is
# the non-interactive, production-safe command: it only replays already-committed
# migration files and never generates, resets, or drops anything. If it fails the
# container exits rather than serving against a schema the code doesn't match.
CMD [ "npm", "run", "start:migrate:prod" ]