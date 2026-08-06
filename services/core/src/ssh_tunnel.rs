//! SSH local port-forwarding via russh.
//!
//! Opens an SSH connection to a bastion host, then binds a random localhost
//! port. Each TCP connection accepted on that port is forwarded through a
//! fresh `direct-tcpip` SSH channel to the configured target host:port.
//!
//! Drivers consume a tunnel by reading `local_port()` and connecting their
//! pool to `127.0.0.1:<local_port>` instead of the real DB host. The tunnel
//! stays open until the `Tunnel` value is dropped — at that point the
//! background task that accepts connections shuts down.
//!
//! ## Host-key verification (TOFU)
//!
//! Every connection requires a SHA256 fingerprint pinned on the profile.
//! `discover_fingerprint()` performs a handshake-only connection (no auth,
//! no port binding) so the UI can show the user the bastion's key the first
//! time they configure a profile; the user then saves the profile to pin it.
//!
//! Subsequent `open()` calls reject any server whose key doesn't match the
//! pinned fingerprint, *before* the password / private key is sent — so a
//! MITM never sees credentials.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use russh::client::{self, Handle};
use russh::keys::key::{KeyPair, PublicKey};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tracing::{debug, warn};

use crate::error::{DbError, Result};

/// Authentication to the bastion host.
#[derive(Debug, Clone)]
pub enum BastionAuth {
    Password(String),
    /// Path to an OpenSSH-format private key, plus an optional passphrase.
    Key {
        path: PathBuf,
        passphrase: Option<String>,
    },
}

#[derive(Debug, Clone)]
pub struct SshTunnelConfig {
    pub bastion_host: String,
    pub bastion_port: u16,
    pub username: String,
    pub auth: BastionAuth,
    pub target_host: String,
    pub target_port: u16,
    /// Pinned SHA256 fingerprint of the bastion's host key, in OpenSSH
    /// format (`SHA256:<base64-no-pad>`). The connection is refused if the
    /// server presents a different key. `None` is rejected outright — the
    /// UI must run `discover_fingerprint` first.
    pub expected_fingerprint: Option<String>,
}

/// A running tunnel. Drop to shut it down.
pub struct Tunnel {
    local_addr: SocketAddr,
    // Held to keep the connection alive; dropped on tunnel shutdown.
    _shutdown: oneshot::Sender<()>,
}

impl Tunnel {
    pub fn local_port(&self) -> u16 {
        self.local_addr.port()
    }
}

/// Host-key verifier. `check_server_key` runs during the SSH key exchange,
/// *before* any credentials are sent. Captures the presented fingerprint
/// either way so callers can read it back; rejects (returns `Ok(false)`)
/// when the captured value differs from the pinned one.
struct HostKeyVerifier {
    expected: Option<String>,
    captured: Arc<Mutex<Option<String>>>,
}

impl HostKeyVerifier {
    fn new(expected: Option<String>) -> (Self, Arc<Mutex<Option<String>>>) {
        let captured = Arc::new(Mutex::new(None));
        (
            HostKeyVerifier {
                expected,
                captured: captured.clone(),
            },
            captured,
        )
    }
}

#[async_trait::async_trait]
impl client::Handler for HostKeyVerifier {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> std::result::Result<bool, Self::Error> {
        let actual = format_fingerprint(server_public_key);
        if let Ok(mut slot) = self.captured.lock() {
            *slot = Some(actual.clone());
        }
        match &self.expected {
            Some(expected) => {
                let ok = expected == &actual;
                debug!(expected = %expected, actual = %actual, accepted = ok, "ssh host key check");
                Ok(ok)
            }
            None => {
                // Discovery mode: accept so the caller can read `captured`.
                debug!(actual = %actual, "ssh host key discovered (no pin set)");
                Ok(true)
            }
        }
    }
}

/// OpenSSH-style fingerprint: `SHA256:<base64-no-pad>`. Matches the format
/// `ssh-keygen -lf` and the first-connect prompt of the `ssh` client print,
/// so users can cross-check against what they see in their own terminal.
fn format_fingerprint(key: &PublicKey) -> String {
    format!("SHA256:{}", key.fingerprint())
}

/// Discover the bastion's host-key fingerprint without authenticating.
///
/// Opens an SSH connection just far enough to complete the key exchange
/// (`check_server_key` runs during the handshake, before user auth), reads
/// the fingerprint, then drops the session.
pub async fn discover_fingerprint(host: &str, port: u16) -> Result<String> {
    let (verifier, captured) = HostKeyVerifier::new(None);
    let cfg = Arc::new(client::Config::default());
    let _session = client::connect(cfg, (host, port), verifier)
        .await
        .map_err(|e| DbError::SshTunnel(format!("connect bastion: {e}")))?;
    let fp = captured
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .ok_or_else(|| DbError::Internal("server did not present a host key".into()))?;
    Ok(fp)
}

/// Open the tunnel. Blocks until the SSH connection is established,
/// host-key-verified, and authenticated; then returns immediately with a
/// `Tunnel` handle. The accept loop runs as a background task.
pub async fn open(config: SshTunnelConfig) -> Result<Tunnel> {
    let expected = config
        .expected_fingerprint
        .clone()
        .ok_or(DbError::HostKeyMissing)?;
    let (verifier, captured) = HostKeyVerifier::new(Some(expected.clone()));

    let cfg = Arc::new(client::Config::default());
    let mut session = match client::connect(
        cfg,
        (config.bastion_host.as_str(), config.bastion_port),
        verifier,
    )
    .await
    {
        Ok(s) => s,
        Err(e) => {
            // russh returns its "key exchange failed" error when our verifier
            // rejected; map that to a precise mismatch error so the UI can
            // offer a re-pin flow distinct from a real network failure.
            if let Some(actual) = captured.lock().ok().and_then(|g| g.clone()) {
                if actual != expected {
                    return Err(DbError::HostKeyMismatch { expected, actual });
                }
            }
            return Err(DbError::SshTunnel(format!("connect bastion: {e}")));
        }
    };

    let authed = match &config.auth {
        BastionAuth::Password(pw) => {
            debug!(user = %config.username, "ssh: attempting password auth");
            session
                .authenticate_password(&config.username, pw)
                .await
                .map_err(|e| DbError::SshTunnel(format!("password auth: {e}")))?
        }
        BastionAuth::Key { path, passphrase } => {
            debug!(user = %config.username, key = %path.display(), "ssh: attempting key auth");
            let bytes = tokio::fs::read(path).await.map_err(DbError::Io)?;
            let key: KeyPair = russh::keys::decode_secret_key(
                std::str::from_utf8(&bytes)
                    .map_err(|_| DbError::SshTunnel("key file is not UTF-8".into()))?,
                passphrase.as_deref(),
            )
            .map_err(|e| DbError::SshTunnel(format!("key decode: {e}")))?;
            debug!(algo = %key.name(), "ssh: key decoded, sending authenticate_publickey");
            session
                .authenticate_publickey(&config.username, Arc::new(key))
                .await
                .map_err(|e| DbError::SshTunnel(format!("key auth: {e}")))?
        }
    };

    debug!(authed = authed, "ssh: auth result");

    if !authed {
        return Err(DbError::AuthFailed(
            "ssh bastion rejected credentials".into(),
        ));
    }

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(DbError::Io)?;
    let local_addr = listener.local_addr().map_err(DbError::Io)?;

    let (shutdown_tx, mut shutdown_rx) = oneshot::channel::<()>();
    let session = Arc::new(session);
    let target_host = config.target_host.clone();
    let target_port = config.target_port;

    tokio::spawn(async move {
        debug!(local = %local_addr, target = %format!("{}:{}", target_host, target_port), "ssh tunnel up");
        loop {
            tokio::select! {
                _ = &mut shutdown_rx => break,
                accept = listener.accept() => {
                    let (local_stream, _peer) = match accept {
                        Ok(v) => v,
                        Err(e) => { warn!(?e, "tunnel accept error"); break; }
                    };
                    let session = session.clone();
                    let target_host = target_host.clone();
                    tokio::spawn(async move {
                        forward_one(session, target_host, target_port, local_stream).await;
                    });
                }
            }
        }
        debug!("ssh tunnel down");
    });

    Ok(Tunnel {
        local_addr,
        _shutdown: shutdown_tx,
    })
}

async fn forward_one(
    session: Arc<Handle<HostKeyVerifier>>,
    target_host: String,
    target_port: u16,
    mut local_stream: tokio::net::TcpStream,
) {
    let channel = match session
        .channel_open_direct_tcpip(target_host, target_port.into(), "127.0.0.1", 0)
        .await
    {
        Ok(c) => c,
        Err(e) => {
            warn!(?e, "ssh tunnel open channel failed");
            return;
        }
    };
    let mut channel_stream = channel.into_stream();
    if let Err(e) = tokio::io::copy_bidirectional(&mut local_stream, &mut channel_stream).await {
        debug!(?e, "ssh tunnel forward ended");
    }
}
