//! Shared HTTP plumbing for the networked features (model downloads, update
//! check and install): the one place the TLS backend is decided.
//!
//! reqwest's `rustls` feature verifies against the OS trust store through
//! rustls-platform-verifier, whose Android verifier is a Kotlin component the
//! app must initialize with the JVM context before the first HTTPS call. BioCN
//! has no such init, and opening settings (model status + update check) is the
//! app's first network request: the verifier panicked with "Expect
//! rustls-platform-verifier to be initialized" and, release builds aborting on
//! panic, the whole app died. Android therefore gets rustls pointed at the
//! bundled webpki roots instead — every host BioCN talks to (ModelScope,
//! GitHub Pages, GitHub Releases) chains to a public CA, and the roots refresh
//! with each app release. Desktop keeps the platform verifier: corporate
//! proxies and user-installed CAs keep working there.

use std::sync::OnceLock;
use std::time::Duration;

/// A client builder whose TLS backend works on every platform. The caller
/// layers its own user agent, timeouts and redirect policy on top.
pub(crate) fn builder() -> reqwest::ClientBuilder {
    let builder = reqwest::Client::builder();
    #[cfg(target_os = "android")]
    let builder = builder.tls_backend_preconfigured(android_tls_config());
    builder
}

/// Shared pooled HTTP client for ModelScope manifest and weight transfers.
pub(crate) fn model_client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(c) = CLIENT.get() {
        return Ok(c);
    }
    let built = builder()
        .user_agent(concat!("biocn/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(20))
        // A CDN that accepts the connection and then stops sending would
        // otherwise hold a download open forever.
        .read_timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    Ok(CLIENT.get_or_init(|| built))
}

/// Shared pooled HTTP client for GitHub Pages update metadata (no redirects).
pub(crate) fn update_check_client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(c) = CLIENT.get() {
        return Ok(c);
    }
    let built = builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("BioCN-Update-Check")
        .build()
        .map_err(|e| format!("无法发起更新检查：{e}"))?;
    Ok(CLIENT.get_or_init(|| built))
}

/// Shared pooled HTTP client for streaming installer downloads.
pub(crate) fn update_download_client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(c) = CLIENT.get() {
        return Ok(c);
    }
    let built = builder()
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(60))
        .user_agent("BioCN-Update-Download")
        .build()
        .map_err(|e| format!("无法发起下载：{e}"))?;
    Ok(CLIENT.get_or_init(|| built))
}

/// Bundled-roots rustls config for Android, handed to reqwest as a
/// preconfigured backend so its platform-verifier path is never reached.
/// The provider and protocol versions are static, so failure here would be a
/// build-time bug, not a runtime condition.
#[cfg(target_os = "android")]
fn android_tls_config() -> rustls::ClientConfig {
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let mut config = rustls::ClientConfig::builder_with_provider(
            rustls::crypto::aws_lc_rs::default_provider().into(),
        )
        .with_safe_default_protocol_versions()
        .expect("the aws-lc-rs provider supports the default protocol versions")
        .with_root_certificates(roots)
        .with_no_client_auth();
    // The ALPN set reqwest itself offers with the http2 feature (its own
    // preconfigured-backend path leaves the field empty, which would pin
    // every request down to HTTP/1.1).
    config.alpn_protocols = vec!["h2".into(), "http/1.1".into()];
    config
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shared builder turns into a client on every platform: this is the
    /// fixture both networked features go through.
    #[test]
    fn the_shared_builder_builds() {
        builder()
            .user_agent("biocn-test")
            .build()
            .expect("client");
    }
}
