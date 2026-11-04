//! Environment-driven configuration, read once at boot.

use std::env;
use std::fs;
use std::io::Write;

use crate::auth::random_hex;

pub struct Config {
    /// An optional Postman API key from the environment, used alongside the
    /// accounts added in the admin panel.
    pub postman_api_key: Option<String>,
    /// The region of `postman_api_key`.
    pub postman_region: String,
    /// POSTMAN_API_BASE: replaces the region-derived base URL (no trailing slash).
    pub postman_base_override: Option<String>,
    /// Encrypts the Postman keys stored in the database: SECRET_KEY, or a random
    /// value kept in `<DB_PATH>.secret`.
    pub secret_key: String,
    pub listen_addr: String,
    pub db_path: String,
    /// true = register/login with Bearer tokens; false = open proxy plus
    /// POST /auth/admin-login against ADMIN_PASSWORD.
    pub require_auth: bool,
    /// Only meaningful when `require_auth` is false: the env-provided admin
    /// password, or a fresh random one that was printed at boot.
    pub admin_password: Option<String>,
}

impl Config {
    pub fn from_env() -> Result<Config, String> {
        let postman_api_key = env::var("POSTMAN_API_KEY").ok().filter(|v| !v.is_empty());

        let postman_base_override = env::var("POSTMAN_API_BASE")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .map(|base| base.trim().trim_end_matches('/').to_string());
        let postman_region = match env::var("POSTMAN_REGION").ok().filter(|v| !v.is_empty()).as_deref() {
            None | Some("us") => "us".to_string(),
            Some("eu") => "eu".to_string(),
            Some(other) => {
                return Err(format!("POSTMAN_REGION must be \"us\" or \"eu\" (got \"{other}\")"))
            }
        };

        let listen_addr = match env::var("LISTEN_ADDR").ok().filter(|v| !v.trim().is_empty()) {
            Some(addr) => addr,
            None => match env::var("PORT").ok().filter(|v| !v.trim().is_empty()) {
                // Render/Railway-style PaaS: bind all interfaces on the
                // platform-assigned port. Local runs keep the loopback default.
                Some(p) => format!("0.0.0.0:{p}"),
                None => "127.0.0.1:8383".into(),
            },
        };

        let db_path = env::var("DB_PATH")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| "./dispatch-server.db".into());

        let secret_key = load_secret_key(&db_path)?;

        let require_auth = match env::var("REQUIRE_AUTH").ok().filter(|v| !v.is_empty()).as_deref() {
            None | Some("true") => true,
            Some("false") => false,
            Some(other) => {
                return Err(format!("REQUIRE_AUTH must be \"true\" or \"false\" (got \"{other}\")"))
            }
        };

        let admin_password = if require_auth {
            None
        } else {
            match env::var("ADMIN_PASSWORD").ok().filter(|v| !v.is_empty()) {
                Some(set) => Some(set),
                None => {
                    let generated = random_hex(16);
                    println!(
                        "dispatch-server: REQUIRE_AUTH is off and ADMIN_PASSWORD is unset — \
                         generated admin password (this is its only appearance): {generated}"
                    );
                    Some(generated)
                }
            }
        };

        Ok(Config {
            postman_api_key,
            postman_region,
            postman_base_override,
            secret_key,
            listen_addr,
            db_path,
            require_auth,
            admin_password,
        })
    }
}

impl Config {
    pub fn postman_base_for(&self, region: &str) -> String {
        match &self.postman_base_override {
            Some(base) => base.clone(),
            None if region == "eu" => "https://api.eu.postman.com".to_string(),
            None => "https://api.postman.com".to_string(),
        }
    }
}

/// SECRET_KEY if set, else the value in `<db_path>.secret`, created on first run
/// and readable only by this user. Losing it means re-entering stored keys.
fn load_secret_key(db_path: &str) -> Result<String, String> {
    if let Some(secret) = env::var("SECRET_KEY").ok().filter(|v| !v.trim().is_empty()) {
        let secret = secret.trim().to_string();
        if secret.len() < 32 {
            return Err("SECRET_KEY must be at least 32 characters".to_string());
        }
        return Ok(secret);
    }
    let path = format!("{db_path}.secret");
    if let Ok(existing) = fs::read_to_string(&path) {
        let existing = existing.trim().to_string();
        if existing.len() >= 32 {
            return Ok(existing);
        }
        return Err(format!("{path} must hold at least 32 characters"));
    }
    let generated = random_hex(32);
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&path)
        .map_err(|e| format!("Couldn't create {path}: {e}"))?;
    file.write_all(generated.as_bytes())
        .map_err(|e| format!("Couldn't write {path}: {e}"))?;
    Ok(generated)
}
