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

/// A client builder whose TLS backend works on every platform. The caller
/// layers its own user agent, timeouts and redirect policy on top.
pub(crate) fn builder() -> reqwest::ClientBuilder {
    let builder = reqwest::Client::builder();
    #[cfg(target_os = "android")]
    let builder = builder.tls_backend_preconfigured(android_tls_config());
    builder
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
