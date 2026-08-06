//! Local encrypted secrets store.
//!
//! Replaces the previous OS-keychain backend. The keychain works on signed
//! production builds but fails on unsigned dev builds (each Rust rebuild
//! produces a binary with a different code signature, and macOS treats the
//! keychain item ACL as "owning app only").
//!
//! Design:
//! - One JSON file at `<app_data_dir>/secrets.enc`
//! - One master key file at `<app_data_dir>/master.key` (256 random bits)
//! - Both files are `chmod 600` so only the OS user can read them
//! - Values are encrypted with ChaCha20-Poly1305 (AEAD) — 96-bit random nonce
//!   per value, included as the "n" field next to the ciphertext "c"
//!
//! Future hardening: wrap the master key with an OS-protected secret
//! (DPAPI on Windows, signed-build keychain on macOS) so the on-disk file
//! is meaningless without the OS user's authentication. Out of scope for
//! Phase 4 — the current setup matches what tools like git-credentials-store
//! ship by default.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use base64::Engine;
use chacha20poly1305::aead::{Aead, AeadCore, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;
use tracing::debug;
use uuid::Uuid;

use crate::error::{DbError, Result};

const STORE_FILE: &str = "secrets.enc";
const KEY_FILE: &str = "master.key";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum Slot {
    Password,
    SshPassphrase,
    SshTunnelPassphrase,
    SshTunnelPassword,
}

impl Slot {
    fn as_str(self) -> &'static str {
        match self {
            Slot::Password => "password",
            Slot::SshPassphrase => "ssh_passphrase",
            Slot::SshTunnelPassphrase => "ssh_tunnel_passphrase",
            Slot::SshTunnelPassword => "ssh_tunnel_password",
        }
    }

    pub fn all() -> impl Iterator<Item = Slot> {
        [
            Slot::Password,
            Slot::SshPassphrase,
            Slot::SshTunnelPassphrase,
            Slot::SshTunnelPassword,
        ]
        .into_iter()
    }
}

fn account(profile_id: Uuid, slot: Slot) -> String {
    format!("{}:{}", slot.as_str(), profile_id)
}

// --- on-disk format --------------------------------------------------------

#[derive(Debug, Default, Serialize, Deserialize)]
struct StoreFile {
    version: u32,
    /// keyed by `slot:profile_id`
    items: std::collections::BTreeMap<String, Encrypted>,
}

#[derive(Debug, Serialize, Deserialize)]
struct Encrypted {
    /// base64(URL_NO_PAD) nonce — 12 bytes
    n: String,
    /// base64(URL_NO_PAD) ciphertext + tag
    c: String,
}

// --- store -----------------------------------------------------------------

struct SecretsStore {
    cipher: ChaCha20Poly1305,
    file_path: PathBuf,
    /// In-memory mirror of the on-disk store. We re-read on every operation
    /// to be safe across processes, but keep this for in-process speed.
    cache: RwLock<StoreFile>,
}

static STORE: OnceLock<SecretsStore> = OnceLock::new();

/// Initialize the secrets store. Call once, early in app startup.
/// Idempotent — repeated calls are no-ops.
pub fn init(app_data_dir: &Path) -> Result<()> {
    if STORE.get().is_some() {
        return Ok(());
    }
    std::fs::create_dir_all(app_data_dir)
        .map_err(|e| DbError::Internal(format!("create app data dir: {e}")))?;
    set_dir_permissions(app_data_dir)?;

    let key_path = app_data_dir.join(KEY_FILE);
    let key_bytes = load_or_generate_master_key(&key_path)?;
    let cipher = ChaCha20Poly1305::new(Key::from_slice(&key_bytes));

    let file_path = app_data_dir.join(STORE_FILE);
    let cache = read_store_file(&file_path)?;

    let store = SecretsStore {
        cipher,
        file_path,
        cache: RwLock::new(cache),
    };
    STORE
        .set(store)
        .map_err(|_| DbError::Internal("secrets store already initialized (race)".to_string()))?;
    Ok(())
}

fn store() -> Result<&'static SecretsStore> {
    STORE.get().ok_or_else(|| {
        DbError::Internal("secrets store not initialized — call secrets::init() at startup".into())
    })
}

pub async fn set(profile_id: Uuid, slot: Slot, value: String) -> Result<()> {
    let s = store()?;
    let account = account(profile_id, slot);
    debug!(profile = %profile_id, slot = ?slot, len = value.len(), "secrets set");
    let nonce = ChaCha20Poly1305::generate_nonce(&mut rand::thread_rng());
    let ct = s
        .cipher
        .encrypt(&nonce, value.as_bytes())
        .map_err(|e| DbError::Internal(format!("encrypt: {e}")))?;
    let item = Encrypted {
        n: base64_encode(nonce.as_slice()),
        c: base64_encode(&ct),
    };

    let mut cache = s.cache.write().await;
    cache.items.insert(account, item);
    write_store_file(&s.file_path, &cache)?;
    Ok(())
}

pub async fn get(profile_id: Uuid, slot: Slot) -> Result<Option<String>> {
    let s = store()?;
    let account = account(profile_id, slot);
    let cache = s.cache.read().await;
    let item = match cache.items.get(&account) {
        Some(i) => i,
        None => {
            debug!(profile = %profile_id, slot = ?slot, present = false, "secrets get");
            return Ok(None);
        }
    };
    let nonce_bytes = base64_decode(&item.n)?;
    let ct = base64_decode(&item.c)?;
    let nonce = Nonce::from_slice(&nonce_bytes);
    let pt = s
        .cipher
        .decrypt(nonce, ct.as_ref())
        .map_err(|e| DbError::Internal(format!("decrypt: {e}")))?;
    let s =
        String::from_utf8(pt).map_err(|e| DbError::Internal(format!("secret not utf8: {e}")))?;
    debug!(profile = %profile_id, slot = ?slot, present = true, len = s.len(), "secrets get");
    Ok(Some(s))
}

pub async fn has(profile_id: Uuid, slot: Slot) -> Result<bool> {
    Ok(get(profile_id, slot).await?.is_some())
}

pub async fn delete(profile_id: Uuid, slot: Slot) -> Result<()> {
    let s = store()?;
    let account = account(profile_id, slot);
    let mut cache = s.cache.write().await;
    if cache.items.remove(&account).is_some() {
        write_store_file(&s.file_path, &cache)?;
    }
    Ok(())
}

pub async fn delete_all(profile_id: Uuid) -> Result<()> {
    for slot in Slot::all() {
        delete(profile_id, slot).await?;
    }
    Ok(())
}

// --- helpers ---------------------------------------------------------------

fn base64_encode(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn base64_decode(s: &str) -> Result<Vec<u8>> {
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(s)
        .map_err(|e| DbError::Internal(format!("base64 decode: {e}")))
}

fn load_or_generate_master_key(path: &Path) -> Result<[u8; 32]> {
    if path.exists() {
        let bytes =
            std::fs::read(path).map_err(|e| DbError::Internal(format!("read master key: {e}")))?;
        if bytes.len() != 32 {
            return Err(DbError::Internal(format!(
                "master key corrupted (expected 32 bytes, got {})",
                bytes.len()
            )));
        }
        let mut out = [0u8; 32];
        out.copy_from_slice(&bytes);
        Ok(out)
    } else {
        let mut bytes = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut bytes);
        std::fs::write(path, bytes)
            .map_err(|e| DbError::Internal(format!("write master key: {e}")))?;
        set_file_permissions(path)?;
        Ok(bytes)
    }
}

fn read_store_file(path: &Path) -> Result<StoreFile> {
    if !path.exists() {
        return Ok(StoreFile {
            version: 1,
            items: Default::default(),
        });
    }
    let bytes =
        std::fs::read(path).map_err(|e| DbError::Internal(format!("read secrets file: {e}")))?;
    serde_json::from_slice(&bytes)
        .map_err(|e| DbError::Internal(format!("parse secrets file: {e}")))
}

fn write_store_file(path: &Path, store: &StoreFile) -> Result<()> {
    // Atomic-ish: write to temp then rename.
    let tmp = path.with_extension("enc.tmp");
    let bytes = serde_json::to_vec_pretty(store)
        .map_err(|e| DbError::Internal(format!("serialize secrets: {e}")))?;
    std::fs::write(&tmp, bytes)
        .map_err(|e| DbError::Internal(format!("write secrets tmp: {e}")))?;
    set_file_permissions(&tmp)?;
    std::fs::rename(&tmp, path).map_err(|e| DbError::Internal(format!("rename secrets: {e}")))?;
    Ok(())
}

#[cfg(unix)]
fn set_file_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = std::fs::metadata(path)
        .map_err(|e| DbError::Internal(format!("stat: {e}")))?
        .permissions();
    perms.set_mode(0o600);
    std::fs::set_permissions(path, perms)
        .map_err(|e| DbError::Internal(format!("chmod 600: {e}")))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_file_permissions(_path: &Path) -> Result<()> {
    // Windows: rely on NTFS user ACL — the file is created by the current
    // user in their %APPDATA%, which is already user-private by default.
    Ok(())
}

#[cfg(unix)]
fn set_dir_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = std::fs::metadata(path)
        .map_err(|e| DbError::Internal(format!("stat dir: {e}")))?
        .permissions();
    perms.set_mode(0o700);
    std::fs::set_permissions(path, perms)
        .map_err(|e| DbError::Internal(format!("chmod 700: {e}")))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_dir_permissions(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn round_trip() {
        let dir = tempfile::tempdir().unwrap();
        init(dir.path()).unwrap();
        let id = Uuid::new_v4();
        set(id, Slot::Password, "secret-value".into())
            .await
            .unwrap();
        let got = get(id, Slot::Password).await.unwrap();
        assert_eq!(got.as_deref(), Some("secret-value"));
        let exists = has(id, Slot::Password).await.unwrap();
        assert!(exists);
        delete(id, Slot::Password).await.unwrap();
        assert!(!has(id, Slot::Password).await.unwrap());
    }
}
