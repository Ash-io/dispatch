//! Published documentation: sites built by the desktop app and served here,
//! each on its own verified domain or subdomain.
//!
//! The desktop app builds every file; this module stores versions, checks
//! domains and serves files. A request whose Host is a documentation domain
//! never reaches the API or the admin panel, so public pages and the API never
//! share an origin. A site with no verified domain can't be reached at all.

use std::sync::Arc;
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::auth::{random_hex, rank, AuthUser};
use crate::db;
use crate::hosted::new_id;
use crate::proxy::{resolve_principal, Principal};
use crate::{error, json, lock_db, AppState};

const WELL_KNOWN: &str = "/.well-known/dispatch-docs/";
const MAX_FILE_BYTES: usize = 1024 * 1024;
const MAX_VERSION_BYTES: usize = 20 * 1024 * 1024;
const MAX_FILES: usize = 1000;
const CONTENT_TYPES: [&str; 9] = [
    "text/html; charset=utf-8",
    "text/css; charset=utf-8",
    "text/javascript; charset=utf-8",
    "application/json",
    "text/markdown; charset=utf-8",
    "text/plain; charset=utf-8",
    "image/svg+xml",
    "application/yaml",
    "application/xml",
];
/// Pages may load their own CSS, script and images, and nothing else. Fonts
/// may also be `data:` URLs, because sites carry their web fonts inline.
const CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

pub struct Site {
    pub id: String,
    pub workspace_id: String,
    pub collection_uid: String,
    pub name: String,
    pub hostname: Option<String>,
    pub domain_status: String,
    pub verify_token: Option<String>,
    pub verified_at: Option<String>,
    pub checked_at: Option<String>,
    pub check_message: Option<String>,
    pub online: bool,
    pub current_version: Option<i64>,
    pub created_by: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

const SITE_COLUMNS: &str = "id, workspace_id, collection_uid, name, hostname, domain_status, verify_token, verified_at, checked_at, check_message, online, current_version, created_by, created_at, updated_at";

fn site_from_row(row: &rusqlite::Row) -> rusqlite::Result<Site> {
    Ok(Site {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        collection_uid: row.get(2)?,
        name: row.get(3)?,
        hostname: row.get(4)?,
        domain_status: row.get(5)?,
        verify_token: row.get(6)?,
        verified_at: row.get(7)?,
        checked_at: row.get(8)?,
        check_message: row.get(9)?,
        online: row.get::<_, i64>(10)? != 0,
        current_version: row.get(11)?,
        created_by: row.get(12)?,
        created_at: row.get(13)?,
        updated_at: row.get(14)?,
    })
}

fn find_site(conn: &Connection, id: &str) -> rusqlite::Result<Option<Site>> {
    conn.query_row(&format!("SELECT {SITE_COLUMNS} FROM docs_sites WHERE id = ?1"), params![id], site_from_row).optional()
}

fn site_by_host(conn: &Connection, host: &str) -> rusqlite::Result<Option<Site>> {
    conn.query_row(&format!("SELECT {SITE_COLUMNS} FROM docs_sites WHERE hostname = ?1"), params![host], site_from_row).optional()
}

fn all_sites(conn: &Connection) -> rusqlite::Result<Vec<Site>> {
    let mut stmt = conn.prepare(&format!("SELECT {SITE_COLUMNS} FROM docs_sites ORDER BY name COLLATE NOCASE"))?;
    let rows = stmt.query_map([], site_from_row)?;
    rows.collect()
}

/// Whether the site is being served right now.
fn live(site: &Site) -> bool {
    site.online && site.domain_status == "verified" && site.current_version.is_some()
}

fn site_json(site: &Site, with_token: bool, allow_http: bool) -> Value {
    let mut v = json!({
        "id": site.id,
        "workspace_id": site.workspace_id,
        "collection_uid": site.collection_uid,
        "name": site.name,
        "hostname": site.hostname,
        "domain_status": site.domain_status,
        "verified_at": site.verified_at,
        "checked_at": site.checked_at,
        "check_message": site.check_message,
        "online": site.online,
        "live": live(site),
        "current_version": site.current_version,
        "created_by": site.created_by,
        "created_at": site.created_at,
        "updated_at": site.updated_at,
        "url": site.hostname.as_ref().map(|h| format!("{}://{h}/", if allow_http { "http" } else { "https" })),
    });
    if with_token {
        v["verify_token"] = json!(site.verify_token);
    }
    v
}

// ----- hostnames ------------------------------------------------------------

/// The host a request was sent to: lowercase, no trailing dot, and no port
/// unless DOCS_ALLOW_HTTP is on (local tests run several hosts on one machine).
pub fn request_host(headers: &HeaderMap, uri: &axum::http::Uri, allow_http: bool) -> Option<String> {
    let raw = headers.get(header::HOST).and_then(|v| v.to_str().ok()).map(str::to_string).or_else(|| uri.authority().map(|a| a.to_string()))?;
    let host = raw.trim().trim_end_matches('.').to_ascii_lowercase();
    if allow_http {
        return Some(host);
    }
    Some(if let Some(rest) = host.strip_prefix('[') {
        format!("[{}]", rest.split(']').next().unwrap_or(rest))
    } else {
        match host.rsplit_once(':') {
            Some((h, port)) if port.chars().all(|c| c.is_ascii_digit()) => h.to_string(),
            _ => host,
        }
    })
}

/// A DNS name such as docs.example.com (with an optional :port in test mode).
pub fn normalize_hostname(raw: &str, allow_http: bool) -> Result<String, String> {
    let text = raw.trim().trim_end_matches('/').to_ascii_lowercase();
    let text = text.strip_prefix("https://").or_else(|| text.strip_prefix("http://")).unwrap_or(&text).trim_end_matches('.').to_string();
    let (name, port) = match text.rsplit_once(':') {
        Some((n, p)) if allow_http && !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()) => (n.to_string(), Some(p)),
        _ => (text.clone(), None),
    };
    let label_ok = |l: &str| !l.is_empty() && l.len() <= 63 && !l.starts_with('-') && !l.ends_with('-') && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    let labels: Vec<&str> = name.split('.').collect();
    let dns_ok = name.len() <= 253 && labels.iter().all(|l| label_ok(l)) && (labels.len() >= 2 || (allow_http && name == "localhost"));
    let not_ip = !labels.iter().all(|l| l.chars().all(|c| c.is_ascii_digit()));
    if !dns_ok || !not_ip {
        return Err(format!("\"{}\" isn't a domain name. Use a domain or subdomain such as docs.example.com.", raw.trim()));
    }
    Ok(match port {
        Some(p) => format!("{name}:{p}"),
        None => name,
    })
}

// ----- serving --------------------------------------------------------------

fn page(status: StatusCode, title: &str, message: &str) -> Response {
    let body = format!("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>{title}</title></head><body style=\"font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:15vh auto;padding:0 1.5rem;color:#333\"><h1 style=\"font-size:1.4rem\">{title}</h1><p>{message}</p></body></html>");
    let mut resp = (status, body).into_response();
    harden(&mut resp, "text/html; charset=utf-8");
    resp.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    resp
}

fn harden(resp: &mut Response, content_type: &str) {
    let h = resp.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_str(content_type).unwrap_or(HeaderValue::from_static("text/plain")));
    h.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(CSP));
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    h.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    h.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
}

fn find_file(conn: &Connection, site_id: &str, version: i64, path: &str) -> Option<(String, String)> {
    let path = path.trim_start_matches('/');
    let candidates: Vec<String> = if path.is_empty() || path.ends_with('/') {
        vec![format!("{path}index.html")]
    } else {
        vec![path.to_string(), format!("{path}.html"), format!("{path}/index.html")]
    };
    candidates.iter().find_map(|p| {
        conn.query_row("SELECT content_type, body FROM docs_files WHERE site_id = ?1 AND version = ?2 AND path = ?3", params![site_id, version, p], |row| Ok((row.get(0)?, row.get(1)?)))
            .optional()
            .ok()
            .flatten()
    })
}

fn file_response(found: Option<(String, String)>, method: &Method) -> Response {
    match found {
        Some((content_type, body)) => {
            let mut resp = if method == Method::HEAD { (StatusCode::OK, "").into_response() } else { (StatusCode::OK, body).into_response() };
            harden(&mut resp, &content_type);
            resp.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=60"));
            resp
        }
        None => page(StatusCode::NOT_FOUND, "Page not found", "There's no page at this address."),
    }
}

/// Runs before routing: documentation domains get documentation and nothing else.
pub async fn host_layer(State(state): State<Arc<AppState>>, request: Request, next: Next) -> Response {
    let allow_http = state.config.docs_allow_http;
    let Some(host) = request_host(request.headers(), request.uri(), allow_http) else { return next.run(request).await };
    let site = {
        let conn = lock_db(&state);
        site_by_host(&conn, &host).ok().flatten()
    };
    let Some(site) = site else { return next.run(request).await };
    let path = request.uri().path().to_string();
    if let Some(token) = path.strip_prefix(WELL_KNOWN) {
        return match &site.verify_token {
            Some(expected) if expected == token => {
                let mut resp = (StatusCode::OK, expected.clone()).into_response();
                harden(&mut resp, "text/plain; charset=utf-8");
                resp.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
                resp
            }
            _ => page(StatusCode::NOT_FOUND, "Page not found", "There's no page at this address."),
        };
    }
    if !matches!(*request.method(), Method::GET | Method::HEAD) {
        return page(StatusCode::METHOD_NOT_ALLOWED, "Not allowed", "Documentation pages can only be read.");
    }
    if !live(&site) {
        return page(StatusCode::NOT_FOUND, "Not published yet", "This documentation isn't published yet.");
    }
    let found = {
        let conn = lock_db(&state);
        find_file(&conn, &site.id, site.current_version.unwrap_or(0), &path)
    };
    file_response(found, request.method())
}

// ----- domain checks --------------------------------------------------------

/// Proves the domain reaches this server: the well-known URL returns the
/// site's token. A DNS TXT record at _dispatch-docs.<domain> also counts.
async fn check_domain(allow_http: bool, hostname: &str, token: &str) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!("dispatch-server/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?;
    let scheme = if allow_http { "http" } else { "https" };
    let url = format!("{scheme}://{hostname}{WELL_KNOWN}{token}");
    let http_problem = match client.get(&url).send().await {
        Ok(resp) if resp.status().is_success() => match resp.text().await {
            Ok(body) if body.trim() == token => return Ok(()),
            _ => format!("{url} answered, but not with this server's token"),
        },
        Ok(resp) => format!("{url} returned {}", resp.status().as_u16()),
        Err(e) if e.is_timeout() => format!("{url} didn't answer within 10 seconds"),
        Err(e) if e.is_connect() => format!("couldn't connect to {url}. Check the DNS record and that HTTPS is set up for the domain"),
        Err(e) => format!("{url} failed: {e}"),
    };
    let bare = hostname.split(':').next().unwrap_or(hostname);
    let doh = format!("https://cloudflare-dns.com/dns-query?name=_dispatch-docs.{bare}&type=TXT");
    if let Ok(resp) = client.get(&doh).header(header::ACCEPT, "application/dns-json").send().await {
        if let Ok(v) = resp.json::<Value>().await {
            let found = v["Answer"].as_array().is_some_and(|a| a.iter().any(|r| r["data"].as_str().is_some_and(|d| d.trim_matches('"') == token)));
            if found {
                return Ok(());
            }
        }
    }
    Err(format!("Not verified: {http_problem}, and there's no TXT record _dispatch-docs.{bare} with the token."))
}

// ----- API ------------------------------------------------------------------

fn parse_body(body: &Bytes) -> Result<Value, Response> {
    serde_json::from_slice(body).map_err(|_| error(StatusCode::BAD_REQUEST, "Body must be valid JSON"))
}

fn audit(state: &AppState, user_id: Option<i64>, email: Option<&str>, action: &str, method: &str, path: &str, response: Response) -> Response {
    let conn = lock_db(state);
    let _ = db::audit_insert(&conn, &db::now_iso(), user_id, email, action, method, path, response.status().as_u16() as i64);
    response
}

fn principal(state: &AppState, headers: &HeaderMap) -> Result<Principal, Response> {
    resolve_principal(state, headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()))
}

fn in_scope(p: &Principal, workspace: &str) -> bool {
    p.scope().map_or(true, |list| list.iter().any(|w| w == workspace))
}

/// The site, if this caller may see its workspace.
fn reachable_site(state: &AppState, p: &Principal, id: &str) -> Result<Site, Response> {
    let site = {
        let conn = lock_db(state);
        find_site(&conn, id).ok().flatten()
    };
    match site {
        Some(site) if in_scope(p, &site.workspace_id) => Ok(site),
        Some(_) => Err(error(StatusCode::FORBIDDEN, "You don't have access to this workspace")),
        None => Err(error(StatusCode::NOT_FOUND, "No such documentation site")),
    }
}

fn admin_only(user: &AuthUser) -> Result<(), Response> {
    if user.role == "admin" { Ok(()) } else { Err(error(StatusCode::FORBIDDEN, "Only admins can do this")) }
}

/// GET /docs-sites: the sites in workspaces this caller can reach.
pub async fn list(State(state): State<Arc<AppState>>, headers: HeaderMap, RawQuery(query): RawQuery) -> Response {
    let collection: Option<String> = query.as_deref().unwrap_or("").split('&').find_map(|pair| pair.strip_prefix("collection=")).map(|v| v.replace("%2D", "-"));
    let p = match principal(&state, &headers) {
        Ok(p) => p,
        Err(resp) => return resp,
    };
    let sites = {
        let conn = lock_db(&state);
        all_sites(&conn).unwrap_or_default()
    };
    let admin = p.role == "admin";
    let out: Vec<Value> = sites
        .iter()
        .filter(|s| in_scope(&p, &s.workspace_id))
        .filter(|s| collection.as_deref().map_or(true, |c| c == s.collection_uid))
        .map(|s| site_json(s, admin, state.config.docs_allow_http))
        .collect();
    json(StatusCode::OK, &json!({ "sites": out }))
}

fn text_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
}

/// POST /admin/docs-sites
pub async fn create(State(state): State<Arc<AppState>>, user: AuthUser, body: Bytes) -> Response {
    let resp = create_inner(&state, &user, &body);
    audit(&state, Some(user.user_id), Some(&user.email), "docs_site_create", "POST", "/admin/docs-sites", resp)
}

fn create_inner(state: &AppState, user: &AuthUser, body: &Bytes) -> Response {
    if let Err(resp) = admin_only(user) {
        return resp;
    }
    let value = match parse_body(body) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let (Some(workspace), Some(collection), Some(name)) = (text_field(&value, "workspace_id"), text_field(&value, "collection_uid"), text_field(&value, "name")) else {
        return error(StatusCode::BAD_REQUEST, "Send workspace_id, collection_uid and name");
    };
    if name.chars().count() > 120 {
        return error(StatusCode::BAD_REQUEST, "Keep the name under 120 characters");
    }
    let id = new_id();
    let now = db::now_iso();
    let conn = lock_db(state);
    let inserted = conn.execute(
        "INSERT INTO docs_sites (id, workspace_id, collection_uid, name, domain_status, online, created_by, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'none', 0, ?5, ?6, ?6)",
        params![id, workspace, collection, name, user.email, now],
    );
    match inserted {
        Ok(_) => match find_site(&conn, &id) {
            Ok(Some(site)) => json(StatusCode::CREATED, &site_json(&site, true, state.config.docs_allow_http)),
            _ => error(StatusCode::INTERNAL_SERVER_ERROR, "Couldn't create the site"),
        },
        Err(rusqlite::Error::SqliteFailure(e, _)) if e.code == rusqlite::ErrorCode::ConstraintViolation => {
            error(StatusCode::CONFLICT, "This collection already has a documentation site")
        }
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "Couldn't create the site"),
    }
}

/// PATCH /admin/docs-sites/{id}: name, hostname (null removes it), online.
pub async fn update(State(state): State<Arc<AppState>>, user: AuthUser, headers: HeaderMap, uri: axum::http::Uri, Path(id): Path<String>, body: Bytes) -> Response {
    let resp = update_inner(&state, &user, &headers, &uri, &id, &body);
    audit(&state, Some(user.user_id), Some(&user.email), "docs_site_update", "PATCH", &format!("/admin/docs-sites/{id}"), resp)
}

fn update_inner(state: &AppState, user: &AuthUser, headers: &HeaderMap, uri: &axum::http::Uri, id: &str, body: &Bytes) -> Response {
    if let Err(resp) = admin_only(user) {
        return resp;
    }
    let value = match parse_body(body) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let allow_http = state.config.docs_allow_http;
    let conn = lock_db(state);
    let Ok(Some(site)) = find_site(&conn, id) else {
        return error(StatusCode::NOT_FOUND, "No such documentation site");
    };
    let now = db::now_iso();
    if let Some(name) = value.get("name") {
        let Some(name) = name.as_str().map(str::trim).filter(|n| !n.is_empty() && n.chars().count() <= 120) else {
            return error(StatusCode::BAD_REQUEST, "The name can't be empty or longer than 120 characters");
        };
        let _ = conn.execute("UPDATE docs_sites SET name = ?1, updated_at = ?2 WHERE id = ?3", params![name, now, id]);
    }
    if let Some(hostname) = value.get("hostname") {
        let new_host = match hostname {
            Value::Null => None,
            Value::String(s) if s.trim().is_empty() => None,
            Value::String(s) => match normalize_hostname(s, allow_http) {
                Ok(h) => Some(h),
                Err(msg) => return error(StatusCode::BAD_REQUEST, msg),
            },
            _ => return error(StatusCode::BAD_REQUEST, "hostname must be a string or null"),
        };
        if new_host.is_some() && new_host == request_host(headers, uri, allow_http) {
            return error(StatusCode::BAD_REQUEST, "That's this server's own address. Use a separate domain or subdomain for the documentation, such as docs.example.com.");
        }
        if new_host != site.hostname {
            let (status, token) = if new_host.is_some() { ("pending", Some(random_hex(16))) } else { ("none", None) };
            let changed = conn.execute(
                "UPDATE docs_sites SET hostname = ?1, domain_status = ?2, verify_token = ?3, verified_at = NULL, checked_at = NULL, check_message = NULL, online = 0, updated_at = ?4 WHERE id = ?5",
                params![new_host, status, token, now, id],
            );
            if let Err(rusqlite::Error::SqliteFailure(e, _)) = &changed {
                if e.code == rusqlite::ErrorCode::ConstraintViolation {
                    return error(StatusCode::CONFLICT, "Another documentation site already uses that domain");
                }
            }
            if changed.is_err() {
                return error(StatusCode::INTERNAL_SERVER_ERROR, "Couldn't save the domain");
            }
        }
    }
    if let Some(online) = value.get("online") {
        let Some(online) = online.as_bool() else {
            return error(StatusCode::BAD_REQUEST, "online must be true or false");
        };
        let Ok(Some(now_site)) = find_site(&conn, id) else {
            return error(StatusCode::NOT_FOUND, "No such documentation site");
        };
        if online && now_site.domain_status != "verified" {
            return error(StatusCode::BAD_REQUEST, "Add and verify a domain before putting the site online");
        }
        if online && now_site.current_version.is_none() {
            return error(StatusCode::BAD_REQUEST, "Publish a version before putting the site online");
        }
        let _ = conn.execute("UPDATE docs_sites SET online = ?1, updated_at = ?2 WHERE id = ?3", params![online as i64, now, id]);
    }
    match find_site(&conn, id) {
        Ok(Some(site)) => json(StatusCode::OK, &site_json(&site, true, allow_http)),
        _ => error(StatusCode::INTERNAL_SERVER_ERROR, "Couldn't read the site back"),
    }
}

/// DELETE /admin/docs-sites/{id}: the site and every version.
pub async fn delete(State(state): State<Arc<AppState>>, user: AuthUser, Path(id): Path<String>) -> Response {
    let resp = if let Err(resp) = admin_only(&user) {
        resp
    } else {
        let conn = lock_db(&state);
        let _ = conn.execute("DELETE FROM docs_files WHERE site_id = ?1", params![id]);
        let _ = conn.execute("DELETE FROM docs_versions WHERE site_id = ?1", params![id]);
        match conn.execute("DELETE FROM docs_sites WHERE id = ?1", params![id]) {
            Ok(1) => (StatusCode::NO_CONTENT, "").into_response(),
            Ok(_) => error(StatusCode::NOT_FOUND, "No such documentation site"),
            Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "Couldn't delete the site"),
        }
    };
    audit(&state, Some(user.user_id), Some(&user.email), "docs_site_delete", "DELETE", &format!("/admin/docs-sites/{id}"), resp)
}

/// POST /admin/docs-sites/{id}/verify: checks the domain now.
pub async fn verify(State(state): State<Arc<AppState>>, user: AuthUser, Path(id): Path<String>) -> Response {
    let resp = verify_inner(&state, &user, &id).await;
    audit(&state, Some(user.user_id), Some(&user.email), "docs_domain_verify", "POST", &format!("/admin/docs-sites/{id}/verify"), resp)
}

async fn verify_inner(state: &AppState, user: &AuthUser, id: &str) -> Response {
    if let Err(resp) = admin_only(user) {
        return resp;
    }
    let site = {
        let conn = lock_db(state);
        find_site(&conn, id).ok().flatten()
    };
    let Some(site) = site else {
        return error(StatusCode::NOT_FOUND, "No such documentation site");
    };
    let (Some(host), Some(token)) = (site.hostname.clone(), site.verify_token.clone()) else {
        return error(StatusCode::BAD_REQUEST, "Add a domain first");
    };
    let result = check_domain(state.config.docs_allow_http, &host, &token).await;
    let now = db::now_iso();
    let conn = lock_db(state);
    match &result {
        Ok(()) => {
            let _ = conn.execute(
                "UPDATE docs_sites SET domain_status = 'verified', verified_at = ?1, checked_at = ?1, check_message = NULL, updated_at = ?1 WHERE id = ?2 AND hostname = ?3",
                params![now, id, host],
            );
        }
        Err(msg) => {
            let _ = conn.execute(
                "UPDATE docs_sites SET domain_status = 'failed', checked_at = ?1, check_message = ?2, updated_at = ?1 WHERE id = ?3 AND hostname = ?4",
                params![now, msg, id, host],
            );
        }
    }
    match find_site(&conn, id) {
        Ok(Some(site)) => json(StatusCode::OK, &site_json(&site, true, state.config.docs_allow_http)),
        _ => error(StatusCode::INTERNAL_SERVER_ERROR, "Couldn't read the site back"),
    }
}

/// POST /docs-sites/{id}/versions: a new version, which becomes current.
pub async fn publish(State(state): State<Arc<AppState>>, headers: HeaderMap, Path(id): Path<String>, body: Bytes) -> Response {
    let (resp, who) = match principal(&state, &headers) {
        Ok(p) => (publish_inner(&state, &p, &id, &body), (p.user_id, p.email)),
        Err(resp) => (resp, (None, None)),
    };
    audit(&state, who.0, who.1.as_deref(), "docs_publish", "POST", &format!("/docs-sites/{id}/versions"), resp)
}

pub fn valid_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 200
        && !path.starts_with('/')
        && !path.split('/').any(|seg| seg.is_empty() || seg == "." || seg == "..")
        && path.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/'))
}

fn publish_inner(state: &AppState, p: &Principal, id: &str, body: &Bytes) -> Response {
    if p.rank() < rank("editor") {
        return error(StatusCode::FORBIDDEN, "Viewers can't publish documentation");
    }
    let site = match reachable_site(state, p, id) {
        Ok(site) => site,
        Err(resp) => return resp,
    };
    let value = match parse_body(body) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let Some(files) = value.get("files").and_then(Value::as_array) else {
        return error(StatusCode::BAD_REQUEST, "Send files: [{ path, content_type, body }]");
    };
    if files.is_empty() || files.len() > MAX_FILES {
        return error(StatusCode::BAD_REQUEST, format!("A version needs between 1 and {MAX_FILES} files"));
    }
    let mut total = 0usize;
    let mut checked: Vec<(&str, &str, &str)> = Vec::with_capacity(files.len());
    for f in files {
        let (Some(path), Some(ct), Some(text)) = (f.get("path").and_then(Value::as_str), f.get("content_type").and_then(Value::as_str), f.get("body").and_then(Value::as_str)) else {
            return error(StatusCode::BAD_REQUEST, "Every file needs path, content_type and body");
        };
        if !valid_path(path) {
            return error(StatusCode::BAD_REQUEST, format!("\"{path}\" isn't an allowed file path"));
        }
        if !CONTENT_TYPES.contains(&ct) {
            return error(StatusCode::BAD_REQUEST, format!("{path}: content type \"{ct}\" isn't allowed"));
        }
        if text.len() > MAX_FILE_BYTES {
            return error(StatusCode::PAYLOAD_TOO_LARGE, format!("{path} is larger than 1 MB"));
        }
        if checked.iter().any(|(seen, _, _)| *seen == path) {
            return error(StatusCode::BAD_REQUEST, format!("{path} appears twice"));
        }
        total += text.len();
        checked.push((path, ct, text));
    }
    if total > MAX_VERSION_BYTES {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "A version can't be larger than 20 MB");
    }
    if !checked.iter().any(|(path, _, _)| *path == "index.html") {
        return error(StatusCode::BAD_REQUEST, "A version needs an index.html");
    }
    let changelog = value.get("changelog").and_then(Value::as_str).unwrap_or("").chars().take(20_000).collect::<String>();
    let now = db::now_iso();
    let mut conn = lock_db(state);
    let tx = match conn.transaction() {
        Ok(tx) => tx,
        Err(_) => return error(StatusCode::INTERNAL_SERVER_ERROR, "Couldn't save the version"),
    };
    let version: i64 = tx.query_row("SELECT COALESCE(MAX(version), 0) + 1 FROM docs_versions WHERE site_id = ?1", params![site.id], |r| r.get(0)).unwrap_or(1);
    let saved = (|| -> rusqlite::Result<()> {
        tx.execute(
            "INSERT INTO docs_versions (site_id, version, published_by, published_at, changelog, file_count, total_bytes) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![site.id, version, p.email.as_deref().unwrap_or("open mode"), now, changelog, checked.len() as i64, total as i64],
        )?;
        for (path, ct, text) in &checked {
            tx.execute("INSERT INTO docs_files (site_id, version, path, content_type, body) VALUES (?1, ?2, ?3, ?4, ?5)", params![site.id, version, path, ct, text])?;
        }
        tx.execute("UPDATE docs_sites SET current_version = ?1, updated_at = ?2 WHERE id = ?3", params![version, now, site.id])?;
        Ok(())
    })();
    if saved.is_err() || tx.commit().is_err() {
        return error(StatusCode::INTERNAL_SERVER_ERROR, "Couldn't save the version");
    }
    match find_site(&conn, &site.id) {
        Ok(Some(site)) => json(StatusCode::CREATED, &json!({ "version": version, "site": site_json(&site, p.role == "admin", state.config.docs_allow_http) })),
        _ => error(StatusCode::INTERNAL_SERVER_ERROR, "Couldn't read the site back"),
    }
}

/// GET /docs-sites/{id}/versions
pub async fn versions(State(state): State<Arc<AppState>>, headers: HeaderMap, Path(id): Path<String>) -> Response {
    let p = match principal(&state, &headers) {
        Ok(p) => p,
        Err(resp) => return resp,
    };
    let site = match reachable_site(&state, &p, &id) {
        Ok(site) => site,
        Err(resp) => return resp,
    };
    let conn = lock_db(&state);
    let mut stmt = match conn.prepare("SELECT version, published_by, published_at, changelog, file_count, total_bytes FROM docs_versions WHERE site_id = ?1 ORDER BY version DESC") {
        Ok(s) => s,
        Err(_) => return error(StatusCode::INTERNAL_SERVER_ERROR, "Couldn't list versions"),
    };
    let rows = stmt.query_map(params![site.id], |r| {
        let version: i64 = r.get(0)?;
        Ok(json!({
            "version": version,
            "published_by": r.get::<_, Option<String>>(1)?,
            "published_at": r.get::<_, String>(2)?,
            "changelog": r.get::<_, String>(3)?,
            "file_count": r.get::<_, i64>(4)?,
            "total_bytes": r.get::<_, i64>(5)?,
            "current": site.current_version == Some(version),
        }))
    });
    let list: Vec<Value> = rows.map(|r| r.filter_map(Result::ok).collect()).unwrap_or_default();
    json(StatusCode::OK, &json!({ "versions": list }))
}

/// PATCH /docs-sites/{id}: { current_version } rolls back or forward.
pub async fn set_current(State(state): State<Arc<AppState>>, headers: HeaderMap, Path(id): Path<String>, body: Bytes) -> Response {
    let (resp, who) = match principal(&state, &headers) {
        Ok(p) => (set_current_inner(&state, &p, &id, &body), (p.user_id, p.email)),
        Err(resp) => (resp, (None, None)),
    };
    audit(&state, who.0, who.1.as_deref(), "docs_rollback", "PATCH", &format!("/docs-sites/{id}"), resp)
}

fn set_current_inner(state: &AppState, p: &Principal, id: &str, body: &Bytes) -> Response {
    if p.rank() < rank("editor") {
        return error(StatusCode::FORBIDDEN, "Viewers can't change the published version");
    }
    let site = match reachable_site(state, p, id) {
        Ok(site) => site,
        Err(resp) => return resp,
    };
    let value = match parse_body(body) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let Some(version) = value.get("current_version").and_then(Value::as_i64) else {
        return error(StatusCode::BAD_REQUEST, "Send current_version");
    };
    let conn = lock_db(state);
    let exists: bool = conn.query_row("SELECT 1 FROM docs_versions WHERE site_id = ?1 AND version = ?2", params![site.id, version], |_| Ok(true)).optional().ok().flatten().unwrap_or(false);
    if !exists {
        return error(StatusCode::NOT_FOUND, "No such version");
    }
    let _ = conn.execute("UPDATE docs_sites SET current_version = ?1, updated_at = ?2 WHERE id = ?3", params![version, db::now_iso(), site.id]);
    match find_site(&conn, &site.id) {
        Ok(Some(site)) => json(StatusCode::OK, &site_json(&site, p.role == "admin", state.config.docs_allow_http)),
        _ => error(StatusCode::INTERNAL_SERVER_ERROR, "Couldn't read the site back"),
    }
}

/// GET /docs-sites/{id}/versions/{n}/files/{*path}: preview any version.
pub async fn preview(State(state): State<Arc<AppState>>, headers: HeaderMap, method: Method, Path((id, version, path)): Path<(String, i64, String)>) -> Response {
    let p = match principal(&state, &headers) {
        Ok(p) => p,
        Err(resp) => return resp,
    };
    let site = match reachable_site(&state, &p, &id) {
        Ok(site) => site,
        Err(resp) => return resp,
    };
    let found = {
        let conn = lock_db(&state);
        find_file(&conn, &site.id, version, &path)
    };
    if found.is_none() {
        return error(StatusCode::NOT_FOUND, "No such file in that version");
    }
    file_response(found, &method)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hostnames() {
        assert_eq!(normalize_hostname("Docs.Example.com", false).unwrap(), "docs.example.com");
        assert_eq!(normalize_hostname("https://docs.example.com/", false).unwrap(), "docs.example.com");
        assert!(normalize_hostname("localhost", false).is_err());
        assert!(normalize_hostname("docs.example.com:8080", false).is_err());
        assert!(normalize_hostname("10.0.0.1", false).is_err());
        assert!(normalize_hostname("-bad.example.com", false).is_err());
        assert!(normalize_hostname("docs example.com", false).is_err());
        assert_eq!(normalize_hostname("localhost:8383", true).unwrap(), "localhost:8383");
    }

    #[test]
    fn hosts_from_requests() {
        let mut h = HeaderMap::new();
        h.insert(header::HOST, HeaderValue::from_static("Docs.Example.com:443"));
        let uri: axum::http::Uri = "/".parse().unwrap();
        assert_eq!(request_host(&h, &uri, false).as_deref(), Some("docs.example.com"));
        assert_eq!(request_host(&h, &uri, true).as_deref(), Some("docs.example.com:443"));
    }

    #[test]
    fn file_paths() {
        for ok in ["index.html", "r/orders.html", "assets/site.css", "_dispatch/facts.json", "md/orders.md"] {
            assert!(valid_path(ok), "{ok}");
        }
        for bad in ["", "/index.html", "../x", "a//b", "a/./b", "a b.html", "a?b", "x\\y"] {
            assert!(!valid_path(bad), "{bad}");
        }
    }
}
