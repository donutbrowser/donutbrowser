//! Environment variables. An empty value counts as unset, as it did before.

#[derive(Clone, Debug, Default)]
pub struct Config {
  pub sync_token: Option<String>,
  pub sync_public_url: Option<String>,
  pub jwt_public_key: Option<String>,
  pub donut_api_url: Option<String>,
  pub backend_internal_url: Option<String>,
  pub backend_internal_key: Option<String>,
  pub internal_key: Option<String>,
  pub s3_endpoint: Option<String>,
  pub s3_region: Option<String>,
  pub s3_access_key_id: Option<String>,
  pub s3_secret_access_key: Option<String>,
  pub s3_bucket: Option<String>,
  pub s3_force_path_style: Option<String>,
  pub s3_public_endpoint: Option<String>,
  pub port: Option<String>,
}

fn env(name: &str) -> Option<String> {
  std::env::var(name).ok().filter(|value| !value.is_empty())
}

impl Config {
  pub fn from_env() -> Self {
    Self {
      sync_token: env("SYNC_TOKEN"),
      sync_public_url: env("SYNC_PUBLIC_URL"),
      jwt_public_key: env("SYNC_JWT_PUBLIC_KEY"),
      donut_api_url: env("DONUT_API_URL"),
      backend_internal_url: env("BACKEND_INTERNAL_URL"),
      backend_internal_key: env("BACKEND_INTERNAL_KEY"),
      internal_key: env("INTERNAL_KEY"),
      s3_endpoint: env("S3_ENDPOINT"),
      s3_region: env("S3_REGION"),
      s3_access_key_id: env("S3_ACCESS_KEY_ID"),
      s3_secret_access_key: env("S3_SECRET_ACCESS_KEY"),
      s3_bucket: env("S3_BUCKET"),
      s3_force_path_style: env("S3_FORCE_PATH_STYLE"),
      s3_public_endpoint: env("S3_PUBLIC_ENDPOINT"),
      port: env("PORT"),
    }
  }

  /// Both backend settings, or neither.
  pub fn backend(&self) -> Option<(String, String)> {
    Some((
      self.backend_internal_url.clone()?,
      self.backend_internal_key.clone()?,
    ))
  }
}
