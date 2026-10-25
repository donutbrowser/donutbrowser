# Donut Sync

The server behind [sync in Donut Browser](https://donutbrowser.com/docs/sync). It
authenticates devices, gives each account its own part of one S3-compatible
bucket, and signs short-lived URLs, so profile files go directly between each
device and storage.

To run your own server, use the Docker image `donutbrowser/donut-sync`. The
[self-hosting guide](https://donutbrowser.com/docs/self-hosting) has the
compose file and every environment variable.

## Build and run

```bash
cargo build --release
SYNC_TOKEN=... S3_ENDPOINT=... S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... \
  S3_BUCKET=... ./target/release/donut-sync
```

`.env.example` lists the variables. A `.env` file in the working directory is
also read.

## Test

The end-to-end tests run the binary against the S3 server in
`docker-compose.yml`:

```bash
docker compose -f docker-compose.yml up -d --wait
cargo test
docker compose -f docker-compose.yml down -v
```
