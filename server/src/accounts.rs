//! Connected Postman accounts: keys added in the admin panel (AES-256-GCM under
//! SECRET_KEY, never returned by any endpoint) plus POSTMAN_API_KEY if set.
//! worker/src/index.js stores keys in the same format.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use rand::RngCore;
use sha2::{Digest, Sha256};

use crate::db;
use crate::{lock_db, AppState};

/// `account_id` of the key that comes from POSTMAN_API_KEY.
pub const ENV_ACCOUNT_ID: i64 = 0;
const KEY_AAD: &[u8] = b"dispatch-postman-key";

#[derive(Clone)]
pub struct Cred {
    pub id: i64,
    pub label: String,
    pub key: String,
    pub base: String,
}

fn cipher(secret: &str) -> Aes256Gcm {
    let digest = Sha256::digest(secret.as_bytes());
    Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&digest))
}

/// `v1.<hex iv>.<hex ciphertext+tag>`.
pub fn encrypt_key(secret: &str, plain: &str) -> Result<String, String> {
    let mut iv = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut iv);
    let sealed = cipher(secret)
        .encrypt(Nonce::from_slice(&iv), Payload { msg: plain.as_bytes(), aad: KEY_AAD })
        .map_err(|_| "Couldn't encrypt the key".to_string())?;
    Ok(format!("v1.{}.{}", hex::encode(iv), hex::encode(sealed)))
}

pub fn decrypt_key(secret: &str, stored: &str) -> Option<String> {
    let mut parts = stored.split('.');
    if parts.next()? != "v1" {
        return None;
    }
    let iv = hex::decode(parts.next()?).ok()?;
    let sealed = hex::decode(parts.next()?).ok()?;
    if iv.len() != 12 {
        return None;
    }
    let plain = cipher(secret)
        .decrypt(Nonce::from_slice(&iv), Payload { msg: &sealed, aad: KEY_AAD })
        .ok()?;
    String::from_utf8(plain).ok()
}

pub fn env_cred(state: &AppState) -> Option<Cred> {
    state.config.postman_api_key.as_ref().map(|key| Cred {
        id: ENV_ACCOUNT_ID,
        label: "Server environment key".to_string(),
        key: key.clone(),
        base: state.config.postman_base_for(&state.config.postman_region),
    })
}

/// Every account the server can currently use. A key that can't be decrypted
/// (SECRET_KEY changed) is left out and reported in the admin panel.
pub fn connected(state: &AppState) -> Vec<Cred> {
    let mut creds: Vec<Cred> = env_cred(state).into_iter().collect();
    let rows = {
        let conn = lock_db(state);
        db::list_accounts(&conn).unwrap_or_default()
    };
    for row in rows {
        if let Some(key) = decrypt_key(&state.config.secret_key, &row.key_ciphertext) {
            creds.push(Cred {
                id: row.id,
                label: row.label,
                key,
                base: state.config.postman_base_for(&row.region),
            });
        }
    }
    creds
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_round_trip_and_stay_private() {
        let stored = encrypt_key("a-secret-of-at-least-32-characters!", "PMAK-abc").unwrap();
        assert!(stored.starts_with("v1."));
        assert!(!stored.contains("PMAK"));
        assert_eq!(decrypt_key("a-secret-of-at-least-32-characters!", &stored).unwrap(), "PMAK-abc");
        assert!(decrypt_key("a-different-secret-of-32-characters", &stored).is_none());
        assert!(decrypt_key("a-secret-of-at-least-32-characters!", "plain").is_none());
    }
}
