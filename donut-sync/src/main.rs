#[tokio::main]
async fn main() {
  std::process::exit(donut_sync::run().await);
}
