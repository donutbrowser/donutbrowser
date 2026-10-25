# syntax=docker/dockerfile:1
# Build context: this directory (donut-sync/).
FROM --platform=$BUILDPLATFORM tonistiigi/xx:1.6.1 AS xx

# Cross-compiles on the build machine's own architecture: emulating the other
# one is many times slower.
FROM --platform=$BUILDPLATFORM rust:1-alpine AS builder
COPY --from=xx / /
RUN apk add --no-cache clang lld
ARG TARGETPLATFORM
RUN xx-apk add --no-cache musl-dev gcc
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
# Dependencies first, in a layer of their own that a source change keeps.
RUN mkdir src && echo 'fn main() {}' > src/main.rs && touch src/lib.rs \
  && xx-cargo build --release --locked \
  && rm -rf src
COPY src/ src/
RUN touch src/main.rs src/lib.rs \
  && xx-cargo build --release --locked \
  && xx-verify --static target/$(xx-cargo --print-target-triple)/release/donut-sync \
  && cp target/$(xx-cargo --print-target-triple)/release/donut-sync /donut-sync

# Alpine keeps a shell and wget for health checks people may have written.
FROM alpine:3.22
RUN apk add --no-cache ca-certificates \
  && addgroup -g 1000 donut \
  && adduser -D -u 1000 -G donut donut
COPY --from=builder /donut-sync /usr/local/bin/donut-sync
# A .env here is read at startup, as before.
WORKDIR /app
EXPOSE 12342
USER donut
CMD ["donut-sync"]
