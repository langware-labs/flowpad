//! The deferred-cleanup state (FLOWPAD-2250, plan §7): what was left for a later run to finish.
//!
//! The file is untrusted input. It names no paths — only roots from a fixed set, each pinned by
//! the file identity it had — and it never authorizes anything: every root is re-resolved by code
//! and re-proven from evidence on disk before anything is deleted. It is integrity-protected with
//! HMAC-SHA256 under a random key kept OUTSIDE the file (in the user's credential store), with a
//! nonce and an expiry; the key is deleted when a run finishes, so an old copy cannot be replayed.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const SCHEMA: u32 = 1;
pub const MAX_BYTES: usize = 16 * 1024;
pub const MAX_ENTRIES: usize = 16;
pub const LIFETIME_SECS: u64 = 14 * 24 * 3600;

/// The only places a deferred cleanup may act on. Each is resolved from known folders by code.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RootId {
    Venv,
    RuntimePython,
    RuntimeDownloads,
    Bootstrap,
    Updater,
    AppData,
    InstanceProd,
    /// `flowpad.pre-repair`: the engine a runtime repair set aside, proven the desktop's.
    PreRepair,
    /// A `flowpad.corrupt-<time>` copy the desktop quarantined, removed with the engine it belonged to.
    CorruptCopy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entry {
    pub root: RootId,
    pub volume: u32,
    pub file_id: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Body {
    pub schema: u32,
    pub nonce: String,
    pub created_at: u64,
    pub expires_at: u64,
    pub entries: Vec<Entry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Signed {
    pub body: Body,
    pub mac: String,
}

/// The secret kept outside the state file: the HMAC key and the nonce it was issued for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Secret {
    pub key: [u8; 32],
    pub nonce: String,
}

impl Secret {
    pub fn encode(&self) -> String {
        format!("{}:{}", hex(&self.key), self.nonce)
    }

    pub fn decode(text: &str) -> Option<Secret> {
        let (k, nonce) = text.split_once(':')?;
        let bytes = unhex(k)?;
        let key: [u8; 32] = bytes.try_into().ok()?;
        if nonce.len() != 32 || !nonce.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        Some(Secret { key, nonce: nonce.to_string() })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Rejected {
    TooLarge,
    Malformed(String),
    Schema,
    TooManyEntries,
    DuplicateRoot,
    NoSecret,
    BadMac,
    NonceMismatch,
    Expired,
    FromTheFuture,
}

impl std::fmt::Display for Rejected {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            Rejected::TooLarge => "the state file is too large".to_string(),
            Rejected::Malformed(e) => format!("the state file is malformed: {e}"),
            Rejected::Schema => "the state file has an unknown schema".to_string(),
            Rejected::TooManyEntries => "the state file lists too many roots".to_string(),
            Rejected::DuplicateRoot => "the state file lists a root twice".to_string(),
            Rejected::NoSecret => "no cleanup is pending (its key is gone)".to_string(),
            Rejected::BadMac => "the state file was modified".to_string(),
            Rejected::NonceMismatch => "the state file belongs to another cleanup".to_string(),
            Rejected::Expired => "the pending cleanup expired".to_string(),
            Rejected::FromTheFuture => "the state file is dated in the future".to_string(),
        };
        f.write_str(&s)
    }
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok()).collect()
}

pub fn hmac_sha256(key: &[u8], msg: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut k = [0u8; BLOCK];
    if key.len() > BLOCK {
        k[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha256::new();
    inner.update(k.map(|b| b ^ 0x36));
    inner.update(msg);
    let mut outer = Sha256::new();
    outer.update(k.map(|b| b ^ 0x5c));
    outer.update(inner.finalize());
    outer.finalize().into()
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// The exact bytes the MAC covers: the body serialized by this code (field order fixed).
fn canonical(body: &Body) -> Vec<u8> {
    serde_json::to_vec(body).expect("the body serializes")
}

pub fn sign(body: Body, secret: &Secret) -> Signed {
    let mac = hex(&hmac_sha256(&secret.key, &canonical(&body)));
    Signed { body, mac }
}

pub fn to_text(signed: &Signed) -> String {
    serde_json::to_string_pretty(signed).expect("the state serializes")
}

/// Parse and authenticate a state file. `secret` is what the credential store holds (None when
/// there is no pending cleanup); `now` is seconds since the Unix epoch.
pub fn verify(text: &str, secret: Option<&Secret>, now: u64) -> Result<Body, Rejected> {
    if text.len() > MAX_BYTES {
        return Err(Rejected::TooLarge);
    }
    let signed: Signed = serde_json::from_str(text).map_err(|e| Rejected::Malformed(e.to_string()))?;
    let body = signed.body;
    if body.schema != SCHEMA {
        return Err(Rejected::Schema);
    }
    if body.entries.len() > MAX_ENTRIES {
        return Err(Rejected::TooManyEntries);
    }
    // The same object twice is a duplicate; two of a kind are not (two quarantined
    // `flowpad.corrupt-*` copies, two runtime folders): each is pinned by its own identity.
    let mut roots: Vec<(RootId, u32, u64)> = body.entries.iter().map(|e| (e.root, e.volume, e.file_id)).collect();
    roots.sort();
    if roots.windows(2).any(|w| w[0] == w[1]) {
        return Err(Rejected::DuplicateRoot);
    }
    let secret = secret.ok_or(Rejected::NoSecret)?;
    let expected = hmac_sha256(&secret.key, &canonical(&body));
    let given = unhex(&signed.mac).ok_or(Rejected::BadMac)?;
    if !constant_time_eq(&expected, &given) {
        return Err(Rejected::BadMac);
    }
    if body.nonce != secret.nonce {
        return Err(Rejected::NonceMismatch);
    }
    if body.created_at > now + 300 {
        return Err(Rejected::FromTheFuture);
    }
    if now >= body.expires_at || body.expires_at > body.created_at + LIFETIME_SECS {
        return Err(Rejected::Expired);
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secret() -> Secret {
        Secret { key: [7u8; 32], nonce: "0123456789abcdef0123456789abcdef".into() }
    }

    fn body() -> Body {
        Body {
            schema: SCHEMA,
            nonce: secret().nonce,
            created_at: 1_000,
            expires_at: 1_000 + LIFETIME_SECS,
            entries: vec![Entry { root: RootId::Venv, volume: 1, file_id: 42 }],
        }
    }

    #[test]
    fn hmac_matches_rfc_4231_test_case_2() {
        let mac = hmac_sha256(b"Jefe", b"what do ya want for nothing?");
        assert_eq!(hex(&mac), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
    }

    #[test]
    fn a_signed_state_round_trips() {
        let text = to_text(&sign(body(), &secret()));
        assert_eq!(verify(&text, Some(&secret()), 2_000), Ok(body()));
    }

    #[test]
    fn tampering_with_any_field_is_detected() {
        let signed = sign(body(), &secret());
        let mut b = signed.clone();
        b.body.entries[0].file_id = 43;
        assert_eq!(verify(&to_text(&b), Some(&secret()), 2_000), Err(Rejected::BadMac));
        let mut b = signed.clone();
        b.body.entries.push(Entry { root: RootId::AppData, volume: 1, file_id: 1 });
        assert_eq!(verify(&to_text(&b), Some(&secret()), 2_000), Err(Rejected::BadMac));
        let mut b = signed;
        b.body.expires_at += 1;
        assert_eq!(verify(&to_text(&b), Some(&secret()), 2_000), Err(Rejected::BadMac));
    }

    #[test]
    fn without_the_key_nothing_is_accepted() {
        let text = to_text(&sign(body(), &secret()));
        assert_eq!(verify(&text, None, 2_000), Err(Rejected::NoSecret), "the key is deleted after a run: no replay");
        let other = Secret { key: [8u8; 32], ..secret() };
        assert_eq!(verify(&text, Some(&other), 2_000), Err(Rejected::BadMac));
    }

    #[test]
    fn a_state_signed_for_another_cleanup_is_refused() {
        let other = Secret { nonce: "ffffffffffffffffffffffffffffffff".into(), ..secret() };
        let text = to_text(&sign(Body { nonce: other.nonce.clone(), ..body() }, &secret()));
        assert_eq!(verify(&text, Some(&secret()), 2_000), Err(Rejected::NonceMismatch));
    }

    #[test]
    fn expiry_and_clock_checks() {
        let text = to_text(&sign(body(), &secret()));
        assert_eq!(verify(&text, Some(&secret()), 1_000 + LIFETIME_SECS), Err(Rejected::Expired));
        assert_eq!(verify(&text, Some(&secret()), 100), Err(Rejected::FromTheFuture));
        let long = to_text(&sign(Body { expires_at: 1_000 + LIFETIME_SECS + 1, ..body() }, &secret()));
        assert_eq!(verify(&long, Some(&secret()), 2_000), Err(Rejected::Expired), "a lifetime longer than allowed");
    }

    #[test]
    fn schema_shape_and_size_are_enforced() {
        let s = secret();
        assert!(matches!(verify("{ not json", Some(&s), 2_000), Err(Rejected::Malformed(_))));
        let with_path = r#"{"body":{"schema":1,"nonce":"x","createdAt":1,"expiresAt":2,"entries":[{"root":"venv","volume":1,"fileId":1,"path":"C:\\"}]},"mac":"00"}"#;
        assert!(matches!(verify(with_path, Some(&s), 2_000), Err(Rejected::Malformed(_))), "unknown fields (a path) are rejected");
        let unknown_root = r#"{"body":{"schema":1,"nonce":"x","createdAt":1,"expiresAt":2,"entries":[{"root":"windows","volume":1,"fileId":1}]},"mac":"00"}"#;
        assert!(matches!(verify(unknown_root, Some(&s), 2_000), Err(Rejected::Malformed(_))), "only the fixed roots exist");
        assert_eq!(verify(&"x".repeat(MAX_BYTES + 1), Some(&s), 2_000), Err(Rejected::TooLarge));
        let two = to_text(&sign(Body { entries: vec![body().entries[0].clone(), body().entries[0].clone()], ..body() }, &s));
        assert_eq!(verify(&two, Some(&s), 2_000), Err(Rejected::DuplicateRoot));
        // Two of a kind, each its own object (two quarantined engine copies): accepted.
        let copy = |file_id| Entry { root: RootId::CorruptCopy, volume: 1, file_id };
        let pair = to_text(&sign(Body { entries: vec![copy(7), copy(8)], ..body() }, &s));
        assert!(verify(&pair, Some(&s), 2_000).is_ok(), "two copies with their own identities are not a duplicate");
        let wrong_schema = to_text(&sign(Body { schema: 2, ..body() }, &s));
        assert_eq!(verify(&wrong_schema, Some(&s), 2_000), Err(Rejected::Schema));
    }

    #[test]
    fn the_secret_encoding_is_strict() {
        let s = secret();
        assert_eq!(Secret::decode(&s.encode()), Some(s));
        assert_eq!(Secret::decode("zz:0123456789abcdef0123456789abcdef"), None);
        assert_eq!(Secret::decode(&format!("{}:short", hex(&[1u8; 32]))), None);
        assert_eq!(Secret::decode("no-colon"), None);
    }
}
