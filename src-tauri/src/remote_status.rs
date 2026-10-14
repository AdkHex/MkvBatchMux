//! Remote status ("Work is in progress") and the access password, the core:
//! the status document, what lock it implies, the saved copy that makes it
//! sticky, and the password check. src/service.rs connects this to the app
//! (polling, stopping and resuming work, the lock screen's commands). See
//! docs/REMOTE-STATUS.md.
//!
//! The switch is fail-open and sticky: a document that cannot be fetched or
//! parsed changes nothing, and the last good one is saved, so a lock survives
//! restarts and offline periods until a good `ok` arrives. The password is
//! fail-closed only for a copy that has never fetched a document at all, and
//! only in a build with `requireAccess`.
//!
//! The password itself never reaches this app's storage: the document carries a
//! salted PBKDF2-SHA256 hash, and an unlock stores only the hash's short id in
//! the OS credential store, which is per OS user.

use std::fs;
use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use hmac::Hmac;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

/// Larger responses are no information.
pub const MAX_BYTES: usize = 64 * 1024;
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(10);
pub const DEFAULT_CHECK_MINUTES: u32 = 5;
/// What a refused command answers during maintenance or "update required".
pub const PAUSED_ERROR: &str = "MKVBatchMux is paused: work is in progress";
/// What a refused command answers until the access password is entered.
pub const LOCKED_ERROR: &str = "MKVBatchMux is locked";
pub const WRONG_PASSWORD: &str = "Wrong password";
/// The only key-derivation scheme a document may name.
pub const ACCESS_ALG: &str = "pbkdf2-sha256";
/// The credential store entry: service is the bundle identifier, this account.
pub const ACCESS_ACCOUNT: &str = "access";
/// Fewer rounds than this would make the published hash cheap to guess; more
/// than this would keep the unlock button busy for minutes.
const MIN_ITERATIONS: u32 = 100_000;
const MAX_ITERATIONS: u32 = 10_000_000;
/// Wrong passwords allowed before the screen makes you wait.
const MAX_ATTEMPTS: u32 = 5;
const ATTEMPT_WAIT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum RemoteState {
    #[default]
    Ok,
    Maintenance,
}

/// The `access` block: a salted PBKDF2-HMAC-SHA256 hash of the password, kept
/// as published (base64) so the saved document reads back through `parse`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Access {
    pub alg: String,
    pub iterations: u32,
    pub salt: String,
    pub hash: String,
    /// First 16 hex characters of sha256(salt || hash): what an unlock stores.
    pub id: String,
}

/// The remote document after validation. Serializes back to the published
/// shape, which is how it is saved.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StatusDoc {
    pub status: RemoteState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub update_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub check_minutes: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access: Option<Access>,
}

impl StatusDoc {
    pub fn interval(&self) -> Duration {
        let minutes = self.check_minutes.unwrap_or(DEFAULT_CHECK_MINUTES).clamp(1, 60);
        Duration::from_secs(minutes as u64 * 60)
    }
}

/// Why the app is locked. The order is the priority: maintenance wins over
/// everything, and the password screen only shows when nothing else does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LockReason {
    /// The document says "maintenance".
    Maintenance,
    /// This build is older than `minVersion`.
    Update,
    /// The document has an `access` block this OS user has not unlocked.
    Access,
    /// `requireAccess` and no document was ever fetched.
    Connect,
}

/// What the lock screen shows (`service-lock-changed`, `service_lock`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ServiceLock {
    pub locked: bool,
    pub reason: Option<LockReason>,
    pub title: Option<String>,
    pub message: Option<String>,
    pub update_url: Option<String>,
    pub min_version: Option<String>,
    pub app_version: String,
    /// A status URL is configured (the switch is on).
    pub enabled: bool,
    /// Unix ms of the last good fetch, this run or an earlier one.
    pub checked_at: Option<i64>,
    /// Why the last fetch failed; cleared by the next good one.
    pub last_error: Option<String>,
}

// ------------------------------------------------------------------ parsing

fn clean_text(v: Option<&Value>, max_chars: usize) -> Option<String> {
    let s = v?.as_str()?.trim();
    if s.is_empty() {
        return None;
    }
    Some(s.chars().take(max_chars).collect())
}

fn b64(s: &str) -> Option<Vec<u8>> {
    base64::engine::general_purpose::STANDARD.decode(s.trim()).ok()
}

/// First 16 hex characters of sha256(salt || hash).
pub fn access_id(salt: &[u8], hash: &[u8]) -> String {
    let digest = Sha256::new().chain_update(salt).chain_update(hash).finalize();
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// A usable `access` block, or None. Every field has to check out, including
/// the id against the salt and hash it names.
fn parse_access(v: &Value) -> Option<Access> {
    let o = v.as_object()?;
    if o.get("alg")?.as_str()? != ACCESS_ALG {
        return None;
    }
    let iterations = u32::try_from(o.get("iterations")?.as_u64()?).ok()?;
    if !(MIN_ITERATIONS..=MAX_ITERATIONS).contains(&iterations) {
        return None;
    }
    let salt = o.get("salt")?.as_str()?.trim().to_string();
    let hash = o.get("hash")?.as_str()?.trim().to_string();
    let salt_bytes = b64(&salt)?;
    let hash_bytes = b64(&hash)?;
    if !(16..=64).contains(&salt_bytes.len()) || hash_bytes.len() != 32 {
        return None;
    }
    let id = access_id(&salt_bytes, &hash_bytes);
    if o.get("id")?.as_str()?.trim().to_ascii_lowercase() != id {
        return None;
    }
    Some(Access { alg: ACCESS_ALG.to_string(), iterations, salt, hash, id })
}

/// Parse the document. `None` = no information (too large, not JSON, not an
/// object, no valid `status`, or an `access` block that does not check out):
/// the caller keeps the last known state. A broken `access` block must not
/// switch the password off, so it spoils the whole document rather than being
/// dropped. Unknown fields are ignored; other invalid optional fields are dropped.
pub fn parse(bytes: &[u8]) -> Option<StatusDoc> {
    if bytes.len() > MAX_BYTES {
        return None;
    }
    let v: Value = serde_json::from_slice(bytes).ok()?;
    let o = v.as_object()?;
    let status = match o.get("status")?.as_str()?.trim().to_ascii_lowercase().as_str() {
        "ok" => RemoteState::Ok,
        "maintenance" => RemoteState::Maintenance,
        _ => return None,
    };
    let access = match o.get("access") {
        None | Some(Value::Null) => None,
        Some(a) => Some(parse_access(a)?),
    };
    let update_url = clean_text(o.get("updateUrl"), 2000).filter(|u| {
        url::Url::parse(u).map(|p| matches!(p.scheme(), "https" | "http")).unwrap_or(false)
    });
    let min_version = clean_text(o.get("minVersion"), 64).filter(|v| parse_version(v).is_some());
    let check_minutes = o
        .get("checkMinutes")
        .and_then(Value::as_f64)
        .filter(|x| x.is_finite())
        .map(|x| x.round().clamp(1.0, 60.0) as u32);
    Some(StatusDoc {
        status,
        title: clean_text(o.get("title"), 200),
        message: clean_text(o.get("message"), 2000),
        min_version,
        update_url,
        check_minutes,
        access,
    })
}

/// "1.2.3", "v1.2", "1.0.0-beta.2" → numeric parts (pre-release and build
/// suffixes are ignored). None when the first part is not a number.
pub fn parse_version(v: &str) -> Option<Vec<u64>> {
    let v = v.trim().trim_start_matches(['v', 'V']);
    let core = v.split(['-', '+']).next().unwrap_or("");
    let mut out = Vec::new();
    for (i, part) in core.split('.').enumerate() {
        let digits: String = part.chars().take_while(|c| c.is_ascii_digit()).collect();
        match digits.parse::<u64>() {
            Ok(n) => out.push(n),
            Err(_) if i == 0 => return None,
            Err(_) => out.push(0),
        }
    }
    Some(out)
}

/// True when `app` is older than `min`. Unparsable versions never count as older.
pub fn version_older(app: &str, min: &str) -> bool {
    let (Some(mut a), Some(mut b)) = (parse_version(app), parse_version(min)) else {
        return false;
    };
    let n = a.len().max(b.len());
    a.resize(n, 0);
    b.resize(n, 0);
    a < b
}

/// The lock for this build and OS user. `granted` is the access id this user
/// unlocked last; `require_access` is the build's fail-closed first run.
pub fn lock_reason(
    doc: Option<&StatusDoc>,
    app_version: &str,
    require_access: bool,
    granted: Option<&str>,
) -> Option<LockReason> {
    let Some(doc) = doc else {
        return require_access.then_some(LockReason::Connect);
    };
    if doc.status == RemoteState::Maintenance {
        return Some(LockReason::Maintenance);
    }
    if let Some(min) = &doc.min_version {
        if version_older(app_version, min) {
            return Some(LockReason::Update);
        }
    }
    match &doc.access {
        Some(access) if granted != Some(access.id.as_str()) => Some(LockReason::Access),
        _ => None,
    }
}

/// Status URLs must be https; plain http only for a local test server, and
/// only when allowed.
pub fn validate_url(raw: &str, allow_local_http: bool) -> Result<String, String> {
    let u = url::Url::parse(raw.trim()).map_err(|e| format!("invalid status URL: {e}"))?;
    match u.scheme() {
        "https" => Ok(u.to_string()),
        "http" if allow_local_http && is_loopback(&u) => Ok(u.to_string()),
        "http" => Err("the status URL must use https:// (http:// only for 127.0.0.1 / localhost in tests)".into()),
        s => Err(format!("unsupported status URL scheme {s}://")),
    }
}

fn is_loopback(u: &url::Url) -> bool {
    match u.host() {
        Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

// ------------------------------------------------------------------ password

/// PBKDF2-HMAC-SHA256 of the password, compared with the published hash in
/// constant time. Slow on purpose (`iterations` rounds): run it off the UI thread.
pub fn verify_password(password: &str, access: &Access) -> bool {
    let (Some(salt), Some(hash)) = (b64(&access.salt), b64(&access.hash)) else {
        return false;
    };
    let mut derived = [0u8; 32];
    pbkdf2::pbkdf2::<Hmac<Sha256>>(password.as_bytes(), &salt, access.iterations, &mut derived);
    derived.ct_eq(hash.as_slice()).into()
}

/// After `MAX_ATTEMPTS` wrong passwords in a row, the next try has to wait
/// `ATTEMPT_WAIT`. Slows guessing at the screen; the published hash is what
/// PBKDF2's rounds protect.
#[derive(Debug, Default)]
struct Throttle {
    failures: u32,
    until: Option<Instant>,
}

impl Throttle {
    fn wait(&self, now: Instant) -> Option<Duration> {
        self.until.filter(|until| *until > now).map(|until| until - now)
    }

    fn fail(&mut self, now: Instant) {
        self.failures += 1;
        if self.failures >= MAX_ATTEMPTS {
            self.failures = 0;
            self.until = Some(now + ATTEMPT_WAIT);
        }
    }

    fn reset(&mut self) {
        *self = Self::default();
    }
}

/// Where an unlock is remembered: the OS credential store, which is per OS
/// user. Behind a trait so tests never touch the real one.
pub trait AccessStore: Send + Sync {
    /// The access id this OS user unlocked last, if any.
    fn load(&self) -> Result<Option<String>, String>;
    fn save(&self, id: &str) -> Result<(), String>;
}

/// Windows Credential Manager / macOS Keychain, entry `<service>` / "access".
pub struct KeyringStore {
    service: String,
}

impl KeyringStore {
    pub fn new(service: &str) -> Self {
        Self { service: service.to_string() }
    }

    fn entry(&self) -> Result<keyring::Entry, String> {
        keyring::Entry::new(&self.service, ACCESS_ACCOUNT).map_err(|e| format!("credential store: {e}"))
    }
}

impl AccessStore for KeyringStore {
    fn load(&self) -> Result<Option<String>, String> {
        match self.entry()?.get_password() {
            Ok(id) => Ok(Some(id)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("credential store: {e}")),
        }
    }

    fn save(&self, id: &str) -> Result<(), String> {
        self.entry()?.set_password(id).map_err(|e| format!("credential store: {e}"))
    }
}

// ------------------------------------------------------------------ fetching

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// GET the document: cache-busting query, no cookies, https-only redirects,
/// 64 KB cap. `Ok(None)` = fetched but unusable (no information).
pub fn fetch(url: &str, app_version: &str) -> Result<Option<StatusDoc>, String> {
    let mut u = url::Url::parse(url).map_err(|e| e.to_string())?;
    u.query_pairs_mut().append_pair("_hs", &now_ms().to_string());
    let policy = reqwest::redirect::Policy::custom(|attempt| {
        // Never downgrade: redirects stay on https (or a loopback test server).
        if attempt.previous().len() >= 5 {
            attempt.error("too many redirects")
        } else if attempt.url().scheme() == "https" || is_loopback(attempt.url()) {
            attempt.follow()
        } else {
            attempt.error("redirect to a non-https address")
        }
    });
    let mut builder = reqwest::blocking::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .connect_timeout(FETCH_TIMEOUT)
        .redirect(policy)
        .user_agent(format!("MKVBatchMux/{app_version}"));
    if is_loopback(&u) {
        // A local test server; a system proxy would not reach it.
        builder = builder.no_proxy();
    }
    let client = builder.build().map_err(|e| format!("cannot create HTTP client: {e}"))?;
    let resp = client
        .get(u)
        .header(reqwest::header::CACHE_CONTROL, "no-cache")
        .header(reqwest::header::PRAGMA, "no-cache")
        .header(reqwest::header::ACCEPT, "application/json, text/plain, */*")
        .send()
        // Without the URL: these show on the lock screen, and the URL is the secret gist's.
        .map_err(|e| format!("cannot reach the status server: {}", e.without_url()))?;
    if !resp.status().is_success() {
        return Err(format!("status server answered {}", resp.status()));
    }
    if resp.content_length().is_some_and(|n| n as usize > MAX_BYTES) {
        return Ok(None);
    }
    let mut body = Vec::new();
    resp.take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut body)
        .map_err(|e| format!("status download failed ({:?})", e.kind()))?;
    if body.len() > MAX_BYTES {
        return Ok(None);
    }
    Ok(parse(&body))
}

// ------------------------------------------------------------------ state

/// How this build is set up (src/service.rs fills it in).
pub struct Config {
    /// Already validated; None = the switch is off in this build.
    pub url: Option<String>,
    pub require_access: bool,
    pub app_version: String,
    /// The saved last good document (in the app's data folder).
    pub state_file: PathBuf,
    /// Poll interval instead of the document's `checkMinutes` (debug builds).
    pub poll_every: Option<Duration>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Saved {
    fetched_at: i64,
    doc: Value,
}

/// What a change means for the app around it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Change {
    /// Work has to stop now.
    Locked,
    /// Work stopped by the lock may carry on.
    Unlocked,
    /// Still locked or still unlocked, but the screen has something new to show.
    Updated,
    Unchanged,
}

#[derive(Default)]
struct State {
    doc: Option<StatusDoc>,
    fetched_at: Option<i64>,
    last_error: Option<String>,
    /// The credential store's access id, read the first time a document asks.
    granted: Option<String>,
    granted_loaded: bool,
    reason: Option<LockReason>,
    throttle: Throttle,
}

/// The lock. `is_locked` is the fast flag every command and worker checks.
pub struct Service {
    config: Config,
    store: Box<dyn AccessStore>,
    state: Mutex<State>,
    locked: AtomicBool,
    /// Serializes fetch + apply (the poll thread and "Check again").
    fetching: Mutex<()>,
}

fn guard<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Service {
    /// Restore the saved document and decide the lock before anything runs. A
    /// build without a status URL forgets any saved state: a lock must never
    /// outlive the switch.
    pub fn new(config: Config, store: Box<dyn AccessStore>) -> Self {
        let mut state = State::default();
        if config.url.is_some() {
            let saved = fs::read(&config.state_file).ok().and_then(|b| serde_json::from_slice::<Saved>(&b).ok());
            if let Some(saved) = saved.filter(|s| s.fetched_at > 0) {
                let doc = serde_json::to_vec(&saved.doc).ok().and_then(|b| parse(&b));
                if doc.is_some() {
                    state.doc = doc;
                    state.fetched_at = Some(saved.fetched_at);
                }
            }
        } else {
            let _ = fs::remove_file(&config.state_file);
        }
        let service = Self {
            config,
            store,
            state: Mutex::new(state),
            locked: AtomicBool::new(false),
            fetching: Mutex::new(()),
        };
        service.load_granted();
        {
            let mut st = guard(&service.state);
            let reason = service.reason(&st);
            st.reason = reason;
            service.locked.store(reason.is_some(), Ordering::SeqCst);
        }
        service
    }

    /// A switch that is off, never locked (tests elsewhere in the app).
    #[cfg(test)]
    pub fn disabled() -> Self {
        struct NoStore;
        impl AccessStore for NoStore {
            fn load(&self) -> Result<Option<String>, String> {
                Ok(None)
            }
            fn save(&self, _: &str) -> Result<(), String> {
                Ok(())
            }
        }
        let config = Config {
            url: None,
            require_access: false,
            app_version: "0.0.0".into(),
            state_file: std::env::temp_dir().join("mkvbatchmux-test-switch-off.json"),
            poll_every: None,
        };
        Self::new(config, Box::new(NoStore))
    }

    pub fn enabled(&self) -> bool {
        self.config.url.is_some()
    }

    pub fn is_locked(&self) -> bool {
        self.locked.load(Ordering::SeqCst)
    }

    /// `Err` with the refusal text while locked. Every command that starts work calls this.
    pub fn ensure_unlocked(&self) -> Result<(), String> {
        if !self.is_locked() {
            return Ok(());
        }
        match guard(&self.state).reason {
            Some(LockReason::Access | LockReason::Connect) => Err(LOCKED_ERROR.into()),
            _ => Err(PAUSED_ERROR.into()),
        }
    }

    pub fn lock_state(&self) -> ServiceLock {
        let st = guard(&self.state);
        let doc = st.doc.clone().unwrap_or_default();
        ServiceLock {
            locked: self.is_locked(),
            reason: st.reason,
            title: doc.title,
            message: doc.message,
            update_url: doc.update_url,
            min_version: doc.min_version,
            app_version: self.config.app_version.clone(),
            enabled: self.enabled(),
            checked_at: st.fetched_at,
            last_error: st.last_error.clone(),
        }
    }

    /// How long until the next poll.
    pub fn interval(&self) -> Duration {
        self.config.poll_every.unwrap_or_else(|| {
            guard(&self.state)
                .doc
                .as_ref()
                .map(StatusDoc::interval)
                .unwrap_or(Duration::from_secs(DEFAULT_CHECK_MINUTES as u64 * 60))
        })
    }

    fn reason(&self, st: &State) -> Option<LockReason> {
        self.config.url.as_ref()?;
        lock_reason(st.doc.as_ref(), &self.config.app_version, self.config.require_access, st.granted.as_deref())
    }

    /// Read this OS user's unlock from the credential store, the first time a
    /// document asks for a password. Never under the state lock: the store can
    /// wait on a system prompt (the macOS Keychain after an update), and that
    /// lock is what every command checks. A failed read is tried again at the
    /// next check rather than remembered as "never unlocked".
    fn load_granted(&self) {
        let needed = {
            let st = guard(&self.state);
            !st.granted_loaded && st.doc.as_ref().is_some_and(|d| d.access.is_some())
        };
        if !needed {
            return;
        }
        match self.store.load() {
            Ok(id) => {
                let mut st = guard(&self.state);
                // An unlock that landed meanwhile is newer than what was read.
                if !st.granted_loaded {
                    st.granted = id;
                    st.granted_loaded = true;
                }
            }
            Err(e) => eprintln!("remote status: {e}"),
        }
    }

    /// Recompute the lock after `st` changed; `shown_changed` = the screen's
    /// content changed even if the lock did not.
    fn settle(&self, st: &mut State, shown_changed: bool) -> Change {
        let reason = self.reason(st);
        let reason_changed = st.reason != reason;
        st.reason = reason;
        let want = reason.is_some();
        let was = self.locked.swap(want, Ordering::SeqCst);
        match (was, want) {
            (false, true) => Change::Locked,
            (true, false) => Change::Unlocked,
            _ if reason_changed || shown_changed => Change::Updated,
            _ => Change::Unchanged,
        }
    }

    /// Apply a freshly fetched document: save it, then lock, unlock or refresh.
    pub fn apply(&self, doc: StatusDoc) -> Change {
        let now = now_ms();
        self.save(&doc, now);
        let shown_changed = {
            let mut st = guard(&self.state);
            let changed = st.doc.as_ref() != Some(&doc) || st.last_error.is_some();
            st.doc = Some(doc);
            st.fetched_at = Some(now);
            st.last_error = None;
            changed
        };
        self.load_granted();
        let mut st = guard(&self.state);
        self.settle(&mut st, shown_changed)
    }

    /// A failed fetch: remembered for the screen, the lock does not change
    /// (fail-open, sticky).
    pub fn note_error(&self, error: String) -> Change {
        eprintln!("remote status: {error}");
        self.load_granted();
        let mut st = guard(&self.state);
        let shown_changed = st.last_error.as_deref() != Some(error.as_str());
        st.last_error = Some(error);
        self.settle(&mut st, shown_changed)
    }

    fn save(&self, doc: &StatusDoc, fetched_at: i64) {
        let Ok(doc) = serde_json::to_value(doc) else { return };
        let Ok(bytes) = serde_json::to_vec_pretty(&Saved { fetched_at, doc }) else { return };
        // Written beside and renamed over, so a crash never leaves half a file.
        let tmp = self.config.state_file.with_extension("json.tmp");
        if fs::write(&tmp, bytes).is_ok() && fs::rename(&tmp, &self.config.state_file).is_err() {
            let _ = fs::remove_file(&tmp);
        }
    }

    /// Fetch now and apply the result.
    pub fn check_now(&self) -> Change {
        let Some(url) = self.config.url.clone() else { return Change::Unchanged };
        let _serial = guard(&self.fetching);
        match fetch(&url, &self.config.app_version) {
            Ok(Some(doc)) => self.apply(doc),
            Ok(None) => self.note_error("the status document is not valid; keeping the last known state".into()),
            Err(e) => self.note_error(e),
        }
    }

    /// Check the password against the saved document's hash. On a match the id
    /// goes to the credential store, so this OS user is not asked again until
    /// the password changes. Slow on purpose: run it off the UI thread.
    pub fn unlock(&self, password: &str) -> Result<Change, String> {
        let access = {
            let st = guard(&self.state);
            if let Some(wait) = st.throttle.wait(Instant::now()) {
                return Err(format!("Too many wrong passwords. Try again in {} s.", wait.as_secs().max(1)));
            }
            match st.doc.as_ref().and_then(|d| d.access.clone()) {
                Some(access) => access,
                None => return Ok(Change::Unchanged),
            }
        };
        if !verify_password(password, &access) {
            guard(&self.state).throttle.fail(Instant::now());
            return Err(WRONG_PASSWORD.into());
        }
        // Outside the state lock, like `load_granted`.
        if let Err(e) = self.store.save(&access.id) {
            // Unlocked for this run anyway; the next start asks again.
            eprintln!("remote status: could not remember the unlock: {e}");
        }
        let mut st = guard(&self.state);
        st.throttle.reset();
        st.granted = Some(access.id);
        st.granted_loaded = true;
        Ok(self.settle(&mut st, false))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpListener;
    use std::sync::Arc;

    // Produced by the switch CLI's own code (Node's crypto.pbkdf2Sync):
    //   salt = Buffer.alloc(16, 7); pbkdf2Sync("correct horse battery staple", salt, ITER, 32, "sha256")
    const NODE_SALT: &str = "BwcHBwcHBwcHBwcHBwcHBw==";
    const NODE_HASH_100K: &str = "L1U+q2ApcN8+qcNIEQqmbdBSgeOo/XF8vufu6pzUxWU=";
    const NODE_ID_100K: &str = "c4137bd2b4cdf0a2";
    const NODE_HASH_600K: &str = "NTnqEmB3QbiHxffwBXqqEr6mTtZ9uusnzbe392HM5Og=";
    const NODE_ID_600K: &str = "a68c44ed87e9555a";
    const PASSWORD: &str = "correct horse battery staple";

    fn access_json(hash: &str, id: &str, iterations: u32) -> String {
        format!(r#"{{"alg":"pbkdf2-sha256","iterations":{iterations},"salt":"{NODE_SALT}","hash":"{hash}","id":"{id}"}}"#)
    }

    fn access_100k() -> Access {
        let doc = format!(r#"{{"status":"ok","access":{}}}"#, access_json(NODE_HASH_100K, NODE_ID_100K, 100_000));
        parse(doc.as_bytes()).unwrap().access.unwrap()
    }

    #[test]
    fn parses_ok_and_maintenance() {
        let d = parse(br#"{"status":"ok"}"#).unwrap();
        assert_eq!(d.status, RemoteState::Ok);
        assert_eq!(d.interval(), Duration::from_secs(300));
        assert_eq!(d.access, None);
        let d = parse(
            br#"{"status":"Maintenance","title":"  Work is in progress ","message":"Back soon","minVersion":"1.2.0",
                "updateUrl":"https://example.com/mkvbatchmux","checkMinutes":2,"extra":{"ignored":true}}"#,
        )
        .unwrap();
        assert_eq!(d.status, RemoteState::Maintenance);
        assert_eq!(d.title.as_deref(), Some("Work is in progress"));
        assert_eq!(d.message.as_deref(), Some("Back soon"));
        assert_eq!(d.min_version.as_deref(), Some("1.2.0"));
        assert_eq!(d.update_url.as_deref(), Some("https://example.com/mkvbatchmux"));
        assert_eq!(d.interval(), Duration::from_secs(120));
    }

    #[test]
    fn garbage_is_no_information() {
        for bad in [&b""[..], b"null", b"[]", b"<html>503</html>", br#"{"status":"locked"}"#, br#"{"status":1}"#, br#"{"title":"x"}"#] {
            assert_eq!(parse(bad), None, "{}", String::from_utf8_lossy(bad));
        }
        // invalid optional fields are dropped, the document stays usable
        let d = parse(br#"{"status":"ok","updateUrl":"javascript:alert(1)","minVersion":"latest","checkMinutes":999,"title":""}"#).unwrap();
        assert_eq!((&d.update_url, &d.min_version, &d.title), (&None, &None, &None));
        assert_eq!(d.interval(), Duration::from_secs(3600));
        assert_eq!(parse(br#"{"status":"ok","checkMinutes":0}"#).unwrap().interval(), Duration::from_secs(60));
    }

    #[test]
    fn oversize_is_rejected() {
        let mut big = br#"{"status":"maintenance","message":""#.to_vec();
        big.extend(std::iter::repeat_n(b'a', MAX_BYTES));
        big.extend_from_slice(br#""}"#);
        assert_eq!(parse(&big), None);
        // long fields are cut, not rejected
        let long = format!(r#"{{"status":"maintenance","title":"{}"}}"#, "t".repeat(1000));
        assert_eq!(parse(long.as_bytes()).unwrap().title.unwrap().chars().count(), 200);
    }

    #[test]
    fn access_block_must_check_out_or_spoil_the_document() {
        let good = access_json(NODE_HASH_100K, NODE_ID_100K, 100_000);
        let doc = format!(r#"{{"status":"ok","access":{good}}}"#);
        let access = parse(doc.as_bytes()).unwrap().access.unwrap();
        assert_eq!(access.id, NODE_ID_100K);
        assert_eq!(access.iterations, 100_000);
        // an explicit null is "no password"
        assert_eq!(parse(br#"{"status":"ok","access":null}"#).unwrap().access, None);

        let wrong_id = access_json(NODE_HASH_100K, "0000000000000000", 100_000);
        let weak = access_json(NODE_HASH_100K, NODE_ID_100K, 1000);
        let short_hash = access_json("AAAA", NODE_ID_100K, 100_000);
        let not_b64 = access_json("not base64!", NODE_ID_100K, 100_000);
        let other_alg = good.replace("pbkdf2-sha256", "md5");
        let no_salt = good.replace(&format!(r#""salt":"{NODE_SALT}","#), "");
        for bad in [wrong_id, weak, short_hash, not_b64, other_alg, no_salt, r#""on""#.to_string(), "{}".to_string()] {
            let doc = format!(r#"{{"status":"ok","access":{bad}}}"#);
            assert_eq!(parse(doc.as_bytes()), None, "{bad}");
        }
    }

    #[test]
    fn saved_document_reads_back_unchanged() {
        let doc = format!(
            r#"{{"status":"maintenance","title":"T","message":"M","minVersion":"1.2.0","updateUrl":"https://e.com/x","checkMinutes":3,"access":{}}}"#,
            access_json(NODE_HASH_100K, NODE_ID_100K, 100_000)
        );
        let parsed = parse(doc.as_bytes()).unwrap();
        let again = parse(&serde_json::to_vec(&parsed).unwrap()).unwrap();
        assert_eq!(parsed, again);
    }

    #[test]
    fn id_matches_the_cli() {
        let salt = b64(NODE_SALT).unwrap();
        assert_eq!(access_id(&salt, &b64(NODE_HASH_100K).unwrap()), NODE_ID_100K);
        assert_eq!(access_id(&salt, &b64(NODE_HASH_600K).unwrap()), NODE_ID_600K);
    }

    #[test]
    fn password_checks_against_the_cli_hash() {
        let access = access_100k();
        assert!(verify_password(PASSWORD, &access));
        assert!(!verify_password("correct horse battery stapler", &access));
        assert!(!verify_password("", &access));
        assert!(!verify_password("Correct horse battery staple", &access));
    }

    /// The CLI's real setting: 600 000 rounds.
    #[test]
    fn password_checks_at_the_cli_default_rounds() {
        let doc = format!(r#"{{"status":"ok","access":{}}}"#, access_json(NODE_HASH_600K, NODE_ID_600K, 600_000));
        let access = parse(doc.as_bytes()).unwrap().access.unwrap();
        let started = Instant::now();
        assert!(verify_password(PASSWORD, &access));
        assert!(!verify_password("wrong", &access));
        eprintln!("two 600k-round checks took {:?}", started.elapsed());
    }

    #[test]
    fn throttle_after_five_wrong() {
        let t0 = Instant::now();
        let mut t = Throttle::default();
        for _ in 0..4 {
            t.fail(t0);
            assert_eq!(t.wait(t0), None);
        }
        t.fail(t0);
        assert_eq!(t.wait(t0), Some(ATTEMPT_WAIT));
        assert_eq!(t.wait(t0 + Duration::from_secs(10)), Some(Duration::from_secs(20)));
        assert_eq!(t.wait(t0 + ATTEMPT_WAIT), None);
        // after the wait, another five are allowed before the next one
        let t1 = t0 + ATTEMPT_WAIT;
        for _ in 0..4 {
            t.fail(t1);
        }
        assert_eq!(t.wait(t1), None);
        t.reset();
        t.fail(t1);
        assert_eq!(t.wait(t1), None);
    }

    #[test]
    fn version_compare() {
        assert!(version_older("1.0.0", "1.0.10"));
        assert!(version_older("1.0.9", "1.0.10"));
        assert!(!version_older("1.0.10", "1.0.9"));
        assert!(!version_older("1.0.0", "1.0.0"));
        assert!(!version_older("1.0", "1.0.0"));
        assert!(version_older("1.0", "1.0.1"));
        assert!(version_older("0.9.9", "1"));
        assert!(!version_older("v2.0.0", "1.99.99"));
        assert!(!version_older("1.0.0-beta.1", "1.0.0"));
        assert!(!version_older("test", "9.9.9"));
        assert!(!version_older("1.0.0", "garbage"));
    }

    #[test]
    fn lock_reasons_and_priority() {
        let access = access_100k();
        let mut d = StatusDoc::default();
        assert_eq!(lock_reason(Some(&d), "1.0.0", true, None), None);
        assert_eq!(lock_reason(None, "1.0.0", false, None), None);
        assert_eq!(lock_reason(None, "1.0.0", true, None), Some(LockReason::Connect));
        d.access = Some(access.clone());
        assert_eq!(lock_reason(Some(&d), "1.0.0", false, None), Some(LockReason::Access));
        assert_eq!(lock_reason(Some(&d), "1.0.0", false, Some("someoldid0000000")), Some(LockReason::Access));
        assert_eq!(lock_reason(Some(&d), "1.0.0", false, Some(NODE_ID_100K)), None);
        d.min_version = Some("1.0.1".into());
        assert_eq!(lock_reason(Some(&d), "1.0.0", false, Some(NODE_ID_100K)), Some(LockReason::Update));
        assert_eq!(lock_reason(Some(&d), "1.0.0", false, None), Some(LockReason::Update));
        d.status = RemoteState::Maintenance;
        assert_eq!(lock_reason(Some(&d), "1.0.1", false, None), Some(LockReason::Maintenance));
    }

    #[test]
    fn url_rules() {
        assert!(validate_url("https://gist.githubusercontent.com/a/b/raw/s.json", false).is_ok());
        assert!(validate_url("http://example.com/s.json", false).is_err());
        assert!(validate_url("http://example.com/s.json", true).is_err());
        assert!(validate_url("http://127.0.0.1:8799/status.json", false).is_err());
        assert!(validate_url("http://127.0.0.1:8799/status.json", true).is_ok());
        assert!(validate_url("http://localhost:8799/status.json", true).is_ok());
        assert!(validate_url("file:///etc/passwd", true).is_err());
        assert!(validate_url("", true).is_err());
    }

    // ---------------------------------------------------------- against a server

    /// A local status server: answers every request with the current
    /// (code, body); `stop` makes it refuse connections, like being offline.
    struct Server {
        url: String,
        reply: Arc<Mutex<(u16, Vec<u8>)>>,
        stop: Arc<AtomicBool>,
    }

    impl Server {
        fn start(code: u16, body: &str) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}/status.json", listener.local_addr().unwrap());
            let reply = Arc::new(Mutex::new((code, body.as_bytes().to_vec())));
            let stop = Arc::new(AtomicBool::new(false));
            let (r, s) = (reply.clone(), stop.clone());
            std::thread::spawn(move || {
                for conn in listener.incoming() {
                    let Ok(mut conn) = conn else { continue };
                    if s.load(Ordering::SeqCst) {
                        break; // dropping the listener refuses everything after
                    }
                    let mut buf = [0u8; 4096];
                    let _ = conn.read(&mut buf);
                    let (code, body) = r.lock().unwrap().clone();
                    let head = format!("HTTP/1.1 {code} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                    let _ = conn.write_all(head.as_bytes());
                    let _ = conn.write_all(&body);
                }
            });
            Server { url, reply, stop }
        }

        fn serve(&self, code: u16, body: &str) {
            *self.reply.lock().unwrap() = (code, body.as_bytes().to_vec());
        }

        fn kill(&self) {
            self.stop.store(true, Ordering::SeqCst);
            // wake the accept loop so it sees the flag and drops the listener
            let _ = std::net::TcpStream::connect(self.url.trim_start_matches("http://").trim_end_matches("/status.json"));
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// The credential store as a shared cell: one OS user across "restarts".
    #[derive(Clone, Default)]
    struct MemoryStore(Arc<Mutex<Option<String>>>);

    impl AccessStore for MemoryStore {
        fn load(&self) -> Result<Option<String>, String> {
            Ok(self.0.lock().unwrap().clone())
        }
        fn save(&self, id: &str) -> Result<(), String> {
            *self.0.lock().unwrap() = Some(id.to_string());
            Ok(())
        }
    }

    fn service(url: Option<&str>, dir: &std::path::Path, store: &MemoryStore, require_access: bool) -> Service {
        Service::new(
            Config {
                url: url.map(str::to_string),
                require_access,
                app_version: "1.70.0".into(),
                state_file: dir.join("remote-status.json"),
                poll_every: None,
            },
            Box::new(store.clone()),
        )
    }

    fn with_access(status: &str) -> String {
        format!(r#"{{"status":"{status}","access":{}}}"#, access_json(NODE_HASH_100K, NODE_ID_100K, 100_000))
    }

    #[test]
    fn maintenance_locks_and_ok_unlocks() {
        let dir = tempfile::tempdir().unwrap();
        let store = MemoryStore::default();
        let server = Server::start(200, r#"{"status":"ok"}"#);
        let svc = service(Some(&server.url), dir.path(), &store, false);
        assert!(!svc.is_locked());
        assert_eq!(svc.check_now(), Change::Updated); // first document: something to show
        assert!(svc.ensure_unlocked().is_ok());

        server.serve(200, r#"{"status":"maintenance","message":"Back soon"}"#);
        assert_eq!(svc.check_now(), Change::Locked);
        assert_eq!(svc.ensure_unlocked(), Err(PAUSED_ERROR.to_string()));
        let shown = svc.lock_state();
        assert_eq!((shown.locked, shown.reason, shown.message.as_deref()), (true, Some(LockReason::Maintenance), Some("Back soon")));
        assert_eq!(svc.check_now(), Change::Unchanged);

        server.serve(200, r#"{"status":"ok"}"#);
        assert_eq!(svc.check_now(), Change::Unlocked);
        assert!(svc.ensure_unlocked().is_ok());
    }

    #[test]
    fn lock_is_sticky_across_restarts_and_outages() {
        let dir = tempfile::tempdir().unwrap();
        let store = MemoryStore::default();
        let server = Server::start(200, r#"{"status":"maintenance"}"#);
        let url = server.url.clone();
        {
            let svc = service(Some(&url), dir.path(), &store, false);
            assert_eq!(svc.check_now(), Change::Locked);
        }
        server.kill();
        let svc = service(Some(&url), dir.path(), &store, false);
        assert!(svc.is_locked(), "the saved maintenance applies before any fetch");
        assert_eq!(svc.check_now(), Change::Updated); // only the error is new
        assert!(svc.is_locked());
        let error = svc.lock_state().last_error.unwrap();
        assert!(error.contains("cannot reach"), "{error}");
        assert!(!error.contains("127.0.0.1") && !error.contains("status.json"), "the screen must not show the URL: {error}");
    }

    #[test]
    fn garbage_errors_and_oversize_never_change_the_lock() {
        let dir = tempfile::tempdir().unwrap();
        let store = MemoryStore::default();
        let server = Server::start(200, r#"{"status":"maintenance"}"#);
        let svc = service(Some(&server.url), dir.path(), &store, false);
        assert_eq!(svc.check_now(), Change::Locked);
        let huge = format!(r#"{{"status":"ok","message":"{}"}}"#, "a".repeat(MAX_BYTES));
        for (code, body) in [(200, "<html>oops</html>"), (500, r#"{"status":"ok"}"#), (404, ""), (200, huge.as_str())] {
            server.serve(code, body);
            svc.check_now();
            assert!(svc.is_locked(), "{code} {}", &body[..body.len().min(30)]);
        }
        server.serve(200, r#"{"status":"ok"}"#);
        assert_eq!(svc.check_now(), Change::Unlocked);
        for (code, body) in [(200, "garbage"), (503, "")] {
            server.serve(code, body);
            svc.check_now();
            assert!(!svc.is_locked(), "garbage never locks");
        }
    }

    #[test]
    fn password_flow() {
        let dir = tempfile::tempdir().unwrap();
        let store = MemoryStore::default();
        let server = Server::start(200, &with_access("ok"));
        let svc = service(Some(&server.url), dir.path(), &store, true);
        assert_eq!(svc.lock_state().reason, Some(LockReason::Connect), "fresh install, nothing fetched yet");
        assert_eq!(svc.check_now(), Change::Updated); // still locked, now for the password
        assert_eq!(svc.lock_state().reason, Some(LockReason::Access));
        assert_eq!(svc.ensure_unlocked(), Err(LOCKED_ERROR.to_string()));

        assert_eq!(svc.unlock("wrong"), Err(WRONG_PASSWORD.to_string()));
        assert!(svc.is_locked());
        assert_eq!(svc.unlock(PASSWORD), Ok(Change::Unlocked));
        assert_eq!(store.load().unwrap().as_deref(), Some(NODE_ID_100K), "only the id is stored");
        assert!(svc.ensure_unlocked().is_ok());
        drop(svc);

        // restart: remembered, no prompt, even before the first fetch and offline
        server.kill();
        let svc = service(Some(&server.url), dir.path(), &store, true);
        assert!(!svc.is_locked());
        svc.check_now();
        assert!(!svc.is_locked());
    }

    #[test]
    fn changed_password_asks_again_and_removing_it_unlocks() {
        let dir = tempfile::tempdir().unwrap();
        let store = MemoryStore::default();
        *store.0.lock().unwrap() = Some(NODE_ID_600K.to_string()); // this user unlocked the old password
        let old = format!(r#"{{"status":"ok","access":{}}}"#, access_json(NODE_HASH_600K, NODE_ID_600K, 600_000));
        let server = Server::start(200, &old);
        let svc = service(Some(&server.url), dir.path(), &store, true);
        assert_eq!(svc.check_now(), Change::Unlocked, "the old password is remembered");

        server.serve(200, &with_access("ok")); // `password` again: new salt and hash
        assert_eq!(svc.check_now(), Change::Locked, "asked again while running");
        assert_eq!(svc.lock_state().reason, Some(LockReason::Access));
        assert_eq!(svc.unlock(PASSWORD), Ok(Change::Unlocked));
        assert_eq!(store.load().unwrap().as_deref(), Some(NODE_ID_100K));

        server.serve(200, r#"{"status":"ok"}"#); // password --off
        svc.check_now();
        assert!(!svc.is_locked());
        *store.0.lock().unwrap() = None;
        let svc = service(Some(&server.url), dir.path(), &store, true);
        assert!(!svc.is_locked(), "no access block, nothing to ask");
    }

    #[test]
    fn maintenance_wins_over_the_password() {
        let dir = tempfile::tempdir().unwrap();
        let store = MemoryStore::default();
        let server = Server::start(200, &with_access("maintenance"));
        let svc = service(Some(&server.url), dir.path(), &store, false);
        assert_eq!(svc.check_now(), Change::Locked);
        assert_eq!(svc.lock_state().reason, Some(LockReason::Maintenance));
        assert_eq!(svc.ensure_unlocked(), Err(PAUSED_ERROR.to_string()));
        // the password can be entered meanwhile; maintenance still holds
        assert_eq!(svc.unlock(PASSWORD), Ok(Change::Unchanged));
        server.serve(200, &with_access("ok"));
        assert_eq!(svc.check_now(), Change::Unlocked);
    }

    /// A credential store whose first reads fail (a Keychain prompt dismissed, say).
    struct FlakyStore {
        fails_left: Mutex<u32>,
        inner: MemoryStore,
    }

    impl AccessStore for FlakyStore {
        fn load(&self) -> Result<Option<String>, String> {
            let mut left = self.fails_left.lock().unwrap();
            if *left > 0 {
                *left -= 1;
                return Err("credential store: user canceled".into());
            }
            self.inner.load()
        }
        fn save(&self, id: &str) -> Result<(), String> {
            self.inner.save(id)
        }
    }

    #[test]
    fn a_failed_store_read_is_tried_again() {
        let dir = tempfile::tempdir().unwrap();
        let unlocked = MemoryStore::default();
        unlocked.save(NODE_ID_100K).unwrap(); // this user entered the password before
        let server = Server::start(200, &with_access("ok"));
        let svc = Service::new(
            Config {
                url: Some(server.url.clone()),
                require_access: false,
                app_version: "1.70.0".into(),
                state_file: dir.path().join("remote-status.json"),
                poll_every: None,
            },
            Box::new(FlakyStore { fails_left: Mutex::new(1), inner: unlocked }),
        );
        assert_eq!(svc.check_now(), Change::Locked, "the read failed: asked for now");
        assert_eq!(svc.check_now(), Change::Unlocked, "read again at the next check, and remembered");
    }

    #[test]
    fn five_wrong_passwords_wait() {
        let dir = tempfile::tempdir().unwrap();
        let store = MemoryStore::default();
        let server = Server::start(200, &with_access("ok"));
        let svc = service(Some(&server.url), dir.path(), &store, false);
        svc.check_now();
        for _ in 0..5 {
            assert_eq!(svc.unlock("nope"), Err(WRONG_PASSWORD.to_string()));
        }
        let refused = svc.unlock(PASSWORD).unwrap_err();
        assert!(refused.starts_with("Too many wrong passwords"), "{refused}");
        assert!(svc.is_locked());
    }

    #[test]
    fn require_access_offline_first_run_waits_for_the_internet() {
        let dir = tempfile::tempdir().unwrap();
        let store = MemoryStore::default();
        let server = Server::start(200, r#"{"status":"ok"}"#);
        let url = server.url.clone();
        server.kill();
        let svc = service(Some(&url), dir.path(), &store, true);
        assert_eq!(svc.lock_state().reason, Some(LockReason::Connect));
        svc.check_now();
        assert_eq!(svc.lock_state().reason, Some(LockReason::Connect));
        assert_eq!(svc.ensure_unlocked(), Err(LOCKED_ERROR.to_string()));

        // without requireAccess a fresh offline copy just runs
        let other = tempfile::tempdir().unwrap();
        assert!(!service(Some(&url), other.path(), &store, false).is_locked());

        // once a document arrives (no password in it), the app opens
        let server = Server::start(200, r#"{"status":"ok"}"#);
        let svc = service(Some(&server.url), dir.path(), &store, true);
        assert_eq!(svc.check_now(), Change::Unlocked);
    }

    #[test]
    fn a_build_without_url_forgets_saved_state() {
        let dir = tempfile::tempdir().unwrap();
        let store = MemoryStore::default();
        let server = Server::start(200, r#"{"status":"maintenance"}"#);
        assert_eq!(service(Some(&server.url), dir.path(), &store, false).check_now(), Change::Locked);
        assert!(dir.path().join("remote-status.json").exists());
        let svc = service(None, dir.path(), &store, true);
        assert!(!svc.is_locked());
        assert!(!svc.enabled());
        assert!(!dir.path().join("remote-status.json").exists());
    }
}
