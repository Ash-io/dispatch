//! The Postman proxy: an allowlisted passthrough of the Postman API surface
//! with role checks, workspace scoping for granted users, secret redaction
//! for viewers, and an audit row for every request.

use std::sync::Arc;
use std::time::Instant;

use axum::body::{Body, Bytes};
use axum::extract::{Request, State};
use axum::http::{header, HeaderName, Method, StatusCode};
use axum::response::Response;
use serde_json::{json, Value};

use crate::accounts::{self, Cred};
use crate::auth::{rank, token_principal};
use crate::db;
use crate::{error, json, lock_cache, lock_db, AppState, CachedList, LIST_CACHE_TTL};

/// Largest request body we accept for a proxied call (collections can be big).
const MAX_PROXY_BODY: usize = 64 * 1024 * 1024;
/// How often an unknown workspace id may trigger a refresh of the account map.
const WORKSPACE_SYNC_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30);
const RATE_LIMIT_HEADER: HeaderName = HeaderName::from_static("x-ratelimit-remaining-month");

#[derive(Clone, Copy, PartialEq)]
enum Family {
    Workspaces,
    Collections,
    Environments,
    Apis,
    Monitors,
    MockServers,
    Schemas,
    Integrations,
    Scim,
}

/// The documented Postman API surface; everything else is rejected.
fn family_of(path: &str) -> Option<(Family, &str)> {
    const PREFIXES: [(&str, Family); 9] = [
        ("/workspaces", Family::Workspaces),
        ("/collections", Family::Collections),
        ("/environments", Family::Environments),
        ("/apis", Family::Apis),
        ("/monitors", Family::Monitors),
        ("/mock-servers", Family::MockServers),
        ("/schemas", Family::Schemas),
        ("/integrations", Family::Integrations),
        ("/scim", Family::Scim),
    ];
    for (prefix, family) in PREFIXES {
        if let Some(rest) = path.strip_prefix(prefix) {
            // "/collectionsx" must not match; "/collections" and "/collections/…" must.
            if rest.is_empty() || rest.starts_with('/') {
                return Some((family, rest.trim_start_matches('/')));
            }
        }
    }
    None
}

fn family_base(family: Family) -> &'static str {
    match family {
        Family::Workspaces => "/workspaces",
        Family::Collections => "/collections",
        Family::Environments => "/environments",
        Family::Apis => "/apis",
        Family::Monitors => "/monitors",
        Family::MockServers => "/mock-servers",
        Family::Schemas => "/schemas",
        Family::Integrations => "/integrations",
        Family::Scim => "/scim",
    }
}

/// The path as it goes upstream (trailing slashes were stripped on the way in).
fn full_path(family: Family, rest: &str) -> String {
    if rest.is_empty() {
        family_base(family).to_string()
    } else {
        format!("{}/{}", family_base(family), rest)
    }
}

/// Key details that differ between collections and environments:
/// (sqlite map table, Postman list key, singular key).
fn dialect(family: Family) -> (&'static str, &'static str, &'static str) {
    match family {
        Family::Collections => ("collections_map", "collections", "collection"),
        Family::Environments => ("environments_map", "environments", "environment"),
        _ => unreachable!("dialect on unscoped family"),
    }
}

/// Who the proxied request belongs to, for the audit row.
struct Who {
    user_id: Option<i64>,
    email: Option<String>,
}

struct Principal {
    user_id: Option<i64>,
    email: Option<String>,
    role: String,
    /// None = all workspaces; Some = only these workspace IDs.
    grants: Option<Vec<String>>,
}

impl Principal {
    fn rank(&self) -> u8 {
        rank(&self.role)
    }

    /// Admins and NULL-grant principals bypass scoping entirely; a granted
    /// principal may only touch workspaces in its list.
    fn scope(&self) -> Option<&[String]> {
        if self.role == "admin" || self.grants.is_none() {
            None
        } else {
            Some(self.grants.as_deref().unwrap_or(&[]))
        }
    }
}

/// Enforced mode always requires a valid Bearer token. Open mode treats every
/// request as an implicit editor with no grants, unless the caller happens to
/// present a valid token (e.g. the admin principal from /auth/admin-login).
fn resolve_principal(state: &AppState, authorization: Option<&str>) -> Result<Principal, Response> {
    let token = authorization.and_then(extract_bearer);
    let principal_from = |user: Option<crate::auth::AuthUser>| user.map(|auth_user| Principal {
        user_id: Some(auth_user.user_id),
        email: Some(auth_user.email),
        role: auth_user.role,
        grants: auth_user.grants,
    });
    if !state.config.require_auth {
        if let Some(token) = token {
            if let Some(principal) = principal_from(token_principal(state, token)) {
                return Ok(principal);
            }
        }
        return Ok(Principal {
            user_id: None,
            email: None,
            role: "editor".to_string(),
            grants: None,
        });
    }
    let Some(token) = token else {
        return Err(error(StatusCode::UNAUTHORIZED, "Invalid or missing token"));
    };
    principal_from(token_principal(state, token))
        .ok_or_else(|| error(StatusCode::UNAUTHORIZED, "Invalid or missing token"))
}

fn extract_bearer(value: &str) -> Option<&str> {
    let (scheme, rest) = value.trim().split_once(' ')?;
    if scheme.eq_ignore_ascii_case("bearer") && !rest.trim().is_empty() {
        Some(rest.trim())
    } else {
        None
    }
}

/// Minimum role for each proxied call, plus the message for when that exact
/// tier is what was missed.
fn min_role(family: Family, method: &Method, rest: &str) -> (u8, &'static str) {
    let has_uid = !rest.is_empty();
    // SCIM and integrations act on the whole Postman team behind a key.
    if matches!(family, Family::Scim | Family::Integrations) {
        return (rank("admin"), "Only admins can do this");
    }
    if matches!(method.as_str(), "GET" | "HEAD") {
        return (rank("viewer"), "");
    }
    if method == Method::DELETE {
        if has_uid && matches!(family, Family::Collections | Family::Environments) {
            return (rank("admin"), "Only admins can delete collections and environments");
        }
        if family == Family::Workspaces && has_uid && !rest.contains('/') {
            return (rank("admin"), "Only admins can delete workspaces");
        }
        return (rank("editor"), "");
    }
    // POST / PATCH / PUT and anything else: editor+, while creating a collection
    // or workspace and touching apis/monitors/mock-servers/schemas needs creator+.
    let creator_only = (!has_uid && matches!(family, Family::Collections | Family::Workspaces))
        || matches!(
            family,
            Family::Apis | Family::Monitors | Family::MockServers | Family::Schemas
        );
    if creator_only {
        (rank("creator"), "This action requires the creator role or above")
    } else {
        (rank("editor"), "")
    }
}

/// The proxy fallback: every non-contract path lands here (contract paths are
/// their own routes above), then gets validated, scoped, forwarded audited.
pub async fn proxy(State(state): State<Arc<AppState>>, request: Request) -> Response {
    let (parts, body_stream) = request.into_parts();
    let method = parts.method.clone();
    let path = parts.uri.path().to_string();
    let query = parts.uri.query().unwrap_or("").to_string();
    let authorization = parts
        .headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string());

    let body = match axum::body::to_bytes(body_stream, MAX_PROXY_BODY).await {
        Ok(body) => body,
        Err(_) => {
            let too_large = error(StatusCode::PAYLOAD_TOO_LARGE, "Request body is too large");
            return audit(state, method, path, too_large, Who { user_id: None, email: None });
        }
    };

    let (response, who) =
        handle(&state, &method, &path, &query, authorization.as_deref(), body).await;
    audit(state, method, path, response, who)
}

/// Logs every request that reaches the proxy: (ts, user_id, email, method,
/// path, status). Open-mode principals audit as NULL/NULL; a presented admin
/// principal audits as user 0 ("admin").
fn audit(state: Arc<AppState>, method: Method, path: String, response: Response, who: Who) -> Response {
    let status = response.status().as_u16() as i64;
    {
        let conn = lock_db(&state);
        let _ = db::audit_insert(
            &conn,
            &db::now_iso(),
            who.user_id,
            who.email.as_deref(),
            "proxy",
            method.as_str(),
            &path,
            status,
        );
    }
    response
}

async fn handle(
    state: &Arc<AppState>,
    method: &Method,
    path: &str,
    query: &str,
    authorization: Option<&str>,
    body: Bytes,
) -> (Response, Who) {
    // 1. Principal.
    let principal = match resolve_principal(state, authorization) {
        Ok(principal) => principal,
        Err(resp) => {
            return (resp, Who { user_id: None, email: None });
        }
    };
    let who = Who {
        user_id: principal.user_id,
        email: principal.email.clone(),
    };

    // 2. Only the documented Postman API surface, and never absolute URLs.
    if !path.starts_with('/') || path.contains("://") || path.starts_with("//") {
        return (error(StatusCode::NOT_FOUND, "No such Postman endpoint"), who);
    }
    let Some((family, rest)) = family_of(path) else {
        return (error(StatusCode::NOT_FOUND, "No such Postman endpoint"), who);
    };

    // 3. A connected Postman account is a server-side prerequisite for proxying.
    let creds = accounts::connected(state);
    if creds.is_empty() {
        return (
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "This server has no Postman account connected. An admin can add one under Postman accounts in the admin panel.",
            ),
            who,
        );
    }

    // 4. Role matrix.
    let (needed, needed_msg) = min_role(family, method, rest);
    if principal.rank() < needed {
        let message = if principal.rank() == rank("viewer") {
            "Viewers have read-only access"
        } else if needed_msg.is_empty() {
            "Your role doesn't allow this action"
        } else {
            needed_msg
        };
        return (error(StatusCode::FORBIDDEN, message), who);
    }

    // 5. Scoping and forwarding (redaction and map upkeep happen inside).
    let response = match family {
        Family::Collections | Family::Environments => {
            scoped_or_plain(state, &creds, family, method, rest, query, &body, &principal).await
        }
        Family::Workspaces => {
            workspaces(state, &creds, method, rest, query, body, &principal).await
        }
        // Admin-only by the role matrix.
        Family::Scim | Family::Integrations => {
            passthrough(state, &creds, method, &full_path(family, rest), query, body).await
        }
        _ => unscoped_family(state, &creds, family, method, rest, query, body, &principal).await,
    };
    (response, who)
}

// ----- workspace → account routing ------------------------------------------

/// Asks every account for its workspaces. An unfiltered list replaces what's
/// remembered for that account, so workspaces created in or removed from Postman
/// are picked up.
pub(crate) async fn sync_workspaces(
    state: &Arc<AppState>,
    creds: &[Cred],
    query: &str,
) -> Vec<(Cred, Result<Upstream, Response>)> {
    let mut results = Vec::with_capacity(creds.len());
    for cred in creds {
        let one = std::slice::from_ref(cred);
        let upstream =
            forward_to_postman(state, one, &Method::GET, "/workspaces", query, &Bytes::new()).await;
        if query.is_empty() {
            if let Ok(found) = &upstream {
                if found.status.is_success() {
                    if let Ok(value) = serde_json::from_slice::<Value>(&found.body) {
                        if let Some(list) = value.get("workspaces").and_then(Value::as_array) {
                            let rows: Vec<(String, String, String)> = list
                                .iter()
                                .filter_map(|ws| {
                                    let id = ws.get("id")?.as_str()?.to_string();
                                    let name = ws.get("name").and_then(Value::as_str).unwrap_or(&id).to_string();
                                    let kind = ws.get("type").and_then(Value::as_str).unwrap_or("").to_string();
                                    Some((id, name, kind))
                                })
                                .collect();
                            let conn = lock_db(state);
                            let _ = db::replace_workspace_accounts(&conn, cred.id, &rows);
                        }
                    }
                }
            }
        }
        results.push((cred.clone(), upstream));
    }
    if query.is_empty() {
        *lock_sync(state) = Some(Instant::now());
    }
    results
}

fn lock_sync(state: &AppState) -> std::sync::MutexGuard<'_, Option<Instant>> {
    match state.last_workspace_sync.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// The accounts that can reach a workspace. An unknown id triggers one throttled
/// refresh, since it may have been created in Postman moments ago.
async fn workspace_creds(state: &Arc<AppState>, creds: &[Cred], workspace: &str) -> Vec<Cred> {
    let lookup = || {
        let ids = {
            let conn = lock_db(state);
            db::workspace_account_ids(&conn, workspace).unwrap_or_default()
        };
        creds.iter().filter(|cred| ids.contains(&cred.id)).cloned().collect::<Vec<Cred>>()
    };
    let found = lookup();
    let recently = lock_sync(state).is_some_and(|at| at.elapsed() < WORKSPACE_SYNC_INTERVAL);
    if !found.is_empty() || recently {
        return found;
    }
    let _ = sync_workspaces(state, creds, "").await;
    lookup()
}

/// The merged workspace list. One account failing doesn't hide the others; two
/// accounts seeing the same workspace show it once. Different workspaces sharing
/// a name (every account has a "My Workspace") get the account's label added.
async fn merged_workspaces(
    state: &Arc<AppState>,
    creds: &[Cred],
    query: &str,
    allowed: Option<&[String]>,
) -> Response {
    let results = sync_workspaces(state, creds, query).await;
    let mut merged: Vec<(Value, String)> = Vec::new();
    let mut first: Option<Value> = None;
    let mut rate: Option<String> = None;
    let mut failure: Option<Result<Upstream, Response>> = None;
    for (cred, upstream) in results {
        let parsed = match &upstream {
            Ok(found) if found.status.is_success() => serde_json::from_slice::<Value>(&found.body)
                .ok()
                .filter(|value| value.get("workspaces").is_some_and(Value::is_array)),
            _ => None,
        };
        let Some(value) = parsed else {
            failure.get_or_insert(upstream);
            continue;
        };
        if let Ok(found) = &upstream {
            rate = found.rate.clone();
        }
        for ws in value["workspaces"].as_array().into_iter().flatten() {
            let Some(id) = ws.get("id").and_then(Value::as_str) else { continue };
            if allowed.is_some_and(|list| !list.iter().any(|one| one == id)) {
                continue;
            }
            if merged.iter().any(|(seen, _)| seen.get("id").and_then(Value::as_str) == Some(id)) {
                continue;
            }
            merged.push((ws.clone(), cred.label.clone()));
        }
        first.get_or_insert(value);
    }
    let Some(mut body) = first else {
        return match failure {
            Some(Ok(upstream)) => as_response(upstream, None),
            Some(Err(resp)) => resp,
            None => error(StatusCode::BAD_GATEWAY, "Couldn't list workspaces"),
        };
    };
    let names: Vec<String> = merged
        .iter()
        .map(|(ws, _)| ws.get("name").and_then(Value::as_str).unwrap_or("").to_string())
        .collect();
    let workspaces: Vec<Value> = merged
        .iter()
        .enumerate()
        .map(|(index, (ws, label))| {
            let mut ws = ws.clone();
            if names.iter().filter(|name| **name == names[index]).count() > 1 {
                ws["name"] = json!(format!("{} ({})", names[index], label));
            }
            ws
        })
        .collect();
    body["workspaces"] = Value::Array(workspaces);
    json_with_rate(StatusCode::OK, &body, rate.as_deref())
}

// ----- workspace-scoped resources (collections / environments) --------------

async fn scoped_or_plain(
    state: &Arc<AppState>,
    creds: &[Cred],
    family: Family,
    method: &Method,
    rest: &str,
    query: &str,
    body: &Bytes,
    principal: &Principal,
) -> Response {
    let (table, _, thing) = dialect(family);
    let is_list = rest.is_empty();
    let is_create = is_list && method == Method::POST;

    if let Some(allowed) = principal.scope() {
        if is_create {
            return create_scoped(state, creds, family, query, body, allowed).await;
        }
        if is_list {
            return list_scoped(state, creds, family, table, list_key(family), query, allowed).await;
        }
        // Single-uid operation: the owning workspace comes from the sqlite
        // map, never from the request.
        let uid = percent_decode(rest.split('/').next().unwrap_or(rest));
        let mapped = {
            let conn = lock_db(state);
            db::mapped_workspace(&conn, table, &uid).ok().flatten()
        };
        match mapped {
            Some(workspace) if allowed.iter().any(|allowed_ws| *allowed_ws == workspace) => {
                let route = workspace_creds(state, creds, &workspace).await;
                forward_single(state, &route, family, method, rest, query, body, principal).await
            }
            _ => error(
                StatusCode::FORBIDDEN,
                format!("This {thing} isn't in one of your workspaces — refresh your {thing}s list first"),
            ),
        }
    } else {
        // Grants NULL (or admin): the call passes through as-is, but we still
        // learn uid → workspace from every per-workspace list/create/delete.
        plain_forward(state, creds, family, method, rest, query, body, principal).await
    }
}

fn list_key(family: Family) -> &'static str {
    dialect(family).1
}

/// A list with no workspace named, for a principal with no grants to scope by:
/// every account's list, each collection or environment once.
async fn merged_across_accounts(
    state: &Arc<AppState>,
    creds: &[Cred],
    family: Family,
    query: &str,
) -> Response {
    let key = list_key(family);
    let mut merged: Vec<Value> = Vec::new();
    let mut rate: Option<String> = None;
    let mut succeeded = false;
    let mut failure: Option<Result<Upstream, Response>> = None;
    for cred in creds {
        let upstream = forward_to_postman(
            state,
            std::slice::from_ref(cred),
            &Method::GET,
            family_base(family),
            query,
            &Bytes::new(),
        )
        .await;
        let value = match &upstream {
            Ok(found) if found.status.is_success() => serde_json::from_slice::<Value>(&found.body).ok(),
            _ => None,
        };
        let Some(value) = value else {
            failure.get_or_insert(upstream);
            continue;
        };
        succeeded = true;
        if let Ok(found) = &upstream {
            rate = found.rate.clone();
        }
        let uid_of = |entry: &Value| {
            entry
                .get("uid")
                .or_else(|| entry.get("id"))
                .and_then(Value::as_str)
                .map(str::to_string)
        };
        for entry in value.get(key).and_then(Value::as_array).into_iter().flatten() {
            if !merged.iter().any(|seen| uid_of(seen) == uid_of(entry)) {
                merged.push(entry.clone());
            }
        }
    }
    if !succeeded {
        return match failure {
            Some(Ok(upstream)) => as_response(upstream, None),
            Some(Err(resp)) => resp,
            None => error(StatusCode::BAD_GATEWAY, "Couldn't reach Postman"),
        };
    }
    let mut body = serde_json::Map::new();
    body.insert(key.to_string(), Value::Array(merged));
    json_with_rate(StatusCode::OK, &Value::Object(body), rate.as_deref())
}

/// Which accounts to try for one collection or environment: the owning
/// workspace's when known, else any account (only reachable by principals with
/// no grants to scope by; granted ones must have the uid mapped).
async fn creds_for_uid(state: &Arc<AppState>, creds: &[Cred], table: &str, rest: &str) -> Vec<Cred> {
    let uid = percent_decode(rest.split('/').next().unwrap_or(rest));
    let mapped = {
        let conn = lock_db(state);
        db::mapped_workspace(&conn, table, &uid).ok().flatten()
    };
    let Some(workspace) = mapped else { return creds.to_vec() };
    let route = workspace_creds(state, creds, &workspace).await;
    if route.is_empty() { creds.to_vec() } else { route }
}

/// Unscoped passthrough. Maintains the uid→workspace map from per-workspace
/// lists, creates and deletes; redacts viewers' single-item GETs.
async fn plain_forward(
    state: &Arc<AppState>,
    creds: &[Cred],
    family: Family,
    method: &Method,
    rest: &str,
    query: &str,
    body: &Bytes,
    principal: &Principal,
) -> Response {
    let (table, _, thing) = dialect(family);
    let is_list = rest.is_empty();
    let is_create = is_list && method == Method::POST;
    let is_delete_single = !is_list && method == Method::DELETE;
    // The workspace this call belongs to, when the caller declared one.
    let declared_workspace = if is_create {
        find_workspace_in(body, query)
    } else if is_list {
        query_workspace(query).map(str::to_string)
    } else {
        None
    };

    if is_list && !is_create && declared_workspace.is_none() && creds.len() > 1 {
        return merged_across_accounts(state, creds, family, query).await;
    }
    let route: Vec<Cred> = if let Some(workspace) = &declared_workspace {
        let found = workspace_creds(state, creds, workspace).await;
        if found.is_empty() { creds.to_vec() } else { found }
    } else if is_create {
        creds.iter().take(1).cloned().collect()
    } else if is_list {
        creds.to_vec()
    } else {
        creds_for_uid(state, creds, table, rest).await
    };

    let upstream = match forward_to_postman(state, &route, method, &full_path(family, rest), query, body).await {
        Ok(upstream) => upstream,
        Err(resp) => return resp,
    };

    if upstream.status.is_success() {
        if is_delete_single {
            let uid = percent_decode(rest.split('/').next().unwrap_or(rest));
            let conn = lock_db(state);
            let _ = db::forget_entry(&conn, table, &uid);
        } else if let Some(workspace) = declared_workspace {
            if let Ok(value) = serde_json::from_slice::<Value>(&upstream.body) {
                if let Some(entries) = list_entries(&value, list_key(family), thing) {
                    let conn = lock_db(state);
                    let _ = db::remember_entries(&conn, table, &workspace, &Value::Array(entries));
                }
            }
        }
    }

    if should_redact(principal, method, rest) && upstream.status.is_success() {
        return match strip_current_values(&upstream.body) {
            Some(stripped) => as_response(upstream, Some(stripped)),
            None => as_response(upstream, None),
        };
    }
    as_response(upstream, None)
}

/// Viewer + GET on a single collection/environment ⇒ strip `currentValue`s.
fn should_redact(principal: &Principal, method: &Method, rest: &str) -> bool {
    principal.role == "viewer" && method == Method::GET && !rest.is_empty() && !rest.contains('/')
}

/// One entry (object) or a whole list (array) from a list/create response.
fn list_entries(value: &Value, list_key: &str, thing: &str) -> Option<Vec<Value>> {
    if let Some(list) = value.get(list_key).and_then(Value::as_array) {
        return Some(list.clone());
    }
    // Create responses carry the single object under its singular key.
    let single = value.get(thing)?;
    single.is_object().then(|| vec![single.clone()])
}

/// GET on the list endpoint with grants: an explicitly requested workspace is
/// served from cache/upstream if granted; otherwise every granted workspace's
/// lists are fetched (60s cached) and merged.
async fn list_scoped(
    state: &Arc<AppState>,
    creds: &[Cred],
    family: Family,
    table: &str,
    list_key: &str,
    query: &str,
    allowed: &[String],
) -> Response {
    if allowed.is_empty() {
        let mut empty_map = serde_json::Map::new();
        empty_map.insert(list_key.to_string(), Value::Array(Vec::new()));
        return json(StatusCode::OK, &Value::Object(empty_map));
    }
    match query_workspace(query) {
        Some(requested) if allowed.iter().any(|ws| ws == requested) => {
            match cached_workspace_list(state, creds, family, table, query, requested).await {
                Ok(upstream) => as_response(upstream, None),
                Err(resp) => resp,
            }
        }
        Some(_) => error(StatusCode::FORBIDDEN, "This workspace isn't in one of your workspaces"),
        None => merged_lists(state, creds, family, table, allowed).await,
    }
}

/// Per-workspace list fetch: answers from the 60s cache when fresh; on a
/// cache/stream miss calls upstream, then populates cache and the uid map.
/// Responses come back byte-verbatim.
async fn cached_workspace_list(
    state: &Arc<AppState>,
    creds: &[Cred],
    family: Family,
    table: &str,
    query: &str,
    workspace: &str,
) -> Result<Upstream, Response> {
    let base = family_base(family);
    let cache_key = format!("{base}:{workspace}");
    if let Some(cached) = fresh_cached_list(state, &cache_key) {
        return Ok(cached);
    }
    let scoped_query = query_with_workspace(query, workspace);
    let route = workspace_creds(state, creds, workspace).await;
    let upstream = forward_to_postman(state, &route, &Method::GET, base, &scoped_query, &Bytes::new())
        .await?
        ;
    if upstream.status.is_success() {
        if let Ok(value) = serde_json::from_slice::<Value>(&upstream.body) {
            if let Some(entries) = list_entries(&value, list_key(family), dialect(family).2) {
                let conn = lock_db(state);
                let _ = db::remember_entries(&conn, table, workspace, &Value::Array(entries));
            }
        }
        {
            let mut cache = lock_cache(state);
            cache.insert(
                cache_key.clone(),
                CachedList {
                    at: Instant::now(),
                    rate: upstream.rate.clone(),
                    body: upstream.body.clone(),
                },
            );
        }
    }
    Ok(upstream)
}

fn fresh_cached_list(state: &Arc<AppState>, cache_key: &str) -> Option<Upstream> {
    let cache = lock_cache(state);
    cache.get(cache_key).filter(|entry| entry.at.elapsed() < LIST_CACHE_TTL).map(|entry| Upstream {
        status: StatusCode::OK,
        rate: entry.rate.clone(),
        content_type: Some("application/json".to_string()),
        body: entry.body.clone(),
    })
}

/// Merges the per-workspace list responses of every granted workspace into one
/// list. A workspace that fails is skipped while another succeeded, so one
/// revoked key doesn't hide everything; failures are never cached.
async fn merged_lists(
    state: &Arc<AppState>,
    creds: &[Cred],
    family: Family,
    table: &str,
    allowed: &[String],
) -> Response {
    let (_, list_key, thing) = (family_base(family), list_key(family), dialect(family).2);
    let mut merged: Vec<Value> = Vec::new();
    let mut rate: Option<String> = None;
    let mut response_key = list_key.to_string();
    let mut succeeded = false;
    let mut failure: Option<Result<Upstream, Response>> = None;
    for workspace in allowed {
        let upstream = match cached_workspace_list(state, creds, family, table, "", workspace).await {
            Ok(upstream) if upstream.status.is_success() => upstream,
            other => {
                failure.get_or_insert(other);
                continue;
            }
        };
        succeeded = true;
        if let Ok(value) = serde_json::from_slice::<Value>(&upstream.body) {
            if let Some(key_name) = value
                .as_object()
                .and_then(|map| map.keys().find(|key| **key == list_key || **key == thing).cloned())
            {
                response_key = key_name;
            }
            if let Some(entries) = list_entries(&value, list_key, thing) {
                merged.extend(entries);
            }
        }
        rate = upstream.rate.clone();
    }
    if !succeeded {
        match failure {
            Some(Ok(upstream)) => return as_response(upstream, None),
            Some(Err(resp)) => return resp,
            None => {}
        }
    }
    let mut body_map = serde_json::Map::new();
    body_map.insert(response_key, Value::Array(merged));
    json_with_rate(StatusCode::OK, &Value::Object(body_map), rate.as_deref())
}

/// POST /collections or /environments with grants: force the workspace in the
/// body to an allowed one (defaulting to the first), keep the query param in
/// sync for clients that carry the workspace there, and cache the mapping
/// from the create response.
async fn create_scoped(
    state: &Arc<AppState>,
    creds: &[Cred],
    family: Family,
    query: &str,
    body: &Bytes,
    allowed: &[String],
) -> Response {
    if allowed.is_empty() {
        return error(StatusCode::FORBIDDEN, "You have no granted workspaces");
    }
    let Ok(mut value) = serde_json::from_slice::<Value>(body) else {
        return error(StatusCode::BAD_REQUEST, "Body must be valid JSON");
    };
    let (table, _, thing) = dialect(family);
    let existing = find_workspace_in_value(&value, query);
    let chosen = match existing {
        Some(ws) if allowed.iter().any(|allowed_ws| *allowed_ws == ws) => ws,
        _ => allowed.first().cloned().unwrap_or_default(),
    };
    force_workspace_in_body(&mut value, &chosen);
    let forwarded_body = match serde_json::to_vec(&value) {
        Ok(bytes) => bytes,
        Err(_) => {
            return error(StatusCode::INTERNAL_SERVER_ERROR, "Couldn't re-encode the request body")
        }
    };
    let forwarded_query = query_with_workspace(query, &chosen);
    let route = workspace_creds(state, creds, &chosen).await;

    let upstream = match forward_to_postman_bytes(
        state,
        &route,
        &Method::POST,
        family_base(family),
        &forwarded_query,
        forwarded_body,
    )
    .await
    {
        Ok(upstream) => upstream,
        Err(resp) => return resp,
    };
    if upstream.status.is_success() {
        if let Ok(value) = serde_json::from_slice::<Value>(&upstream.body) {
            if let Some(entries) = list_entries(&value, list_key(family), thing) {
                let conn = lock_db(state);
                let _ = db::remember_entries(&conn, table, &chosen, &Value::Array(entries));
            }
        }
    }
    as_response(upstream, None)
}

// ----- workspaces -----------------------------------------------------------

/// The list is merged across accounts and filtered to the grants; anything aimed
/// at one workspace goes through the accounts that can reach it.
async fn workspaces(
    state: &Arc<AppState>,
    creds: &[Cred],
    method: &Method,
    rest: &str,
    query: &str,
    body: Bytes,
    principal: &Principal,
) -> Response {
    let allowed = principal.scope();
    if rest.is_empty() {
        if matches!(method.as_str(), "GET" | "HEAD") {
            return merged_workspaces(state, creds, query, allowed).await;
        }
        if allowed.is_some() {
            return error(StatusCode::FORBIDDEN, "Only people with access to all workspaces can create one");
        }
        let first: Vec<Cred> = creds.iter().take(1).cloned().collect();
        return passthrough(state, &first, method, "/workspaces", query, body).await;
    }
    let uid = percent_decode(rest.split('/').next().unwrap_or(rest));
    if allowed.is_some_and(|list| !list.iter().any(|ws| *ws == uid)) {
        return error(StatusCode::FORBIDDEN, "This workspace isn't in one of your workspaces");
    }
    let route = workspace_creds(state, creds, &uid).await;
    if route.is_empty() && allowed.is_some() {
        return error(StatusCode::NOT_FOUND, "No connected Postman account can reach this workspace");
    }
    let route = if route.is_empty() { creds.to_vec() } else { route };
    passthrough(state, &route, method, &full_path(Family::Workspaces, rest), query, body).await
}

// ----- generic forwarding ---------------------------------------------------

/// /apis, /monitors, /mock-servers and /schemas don't belong to a workspace we
/// can check, unless the caller names one. Without it, someone limited to certain
/// workspaces is refused rather than shown the whole account.
async fn unscoped_family(
    state: &Arc<AppState>,
    creds: &[Cred],
    family: Family,
    method: &Method,
    rest: &str,
    query: &str,
    body: Bytes,
    principal: &Principal,
) -> Response {
    let workspace = query_workspace(query);
    if let Some(allowed) = principal.scope() {
        if !workspace.is_some_and(|ws| allowed.iter().any(|one| one == ws)) {
            return error(StatusCode::FORBIDDEN, "This isn't available to people limited to certain workspaces");
        }
    }
    let path = full_path(family, rest);
    let Some(workspace) = workspace else {
        return passthrough(state, creds, method, &path, query, body).await;
    };
    let route = workspace_creds(state, creds, workspace).await;
    let route = if route.is_empty() { creds.to_vec() } else { route };
    passthrough(state, &route, method, &path, query, body).await
}

/// Everything else flows through verbatim.
async fn passthrough(
    state: &Arc<AppState>,
    creds: &[Cred],
    method: &Method,
    path: &str,
    query: &str,
    body: Bytes,
) -> Response {
    match forward_to_postman(state, creds, method, path, query, &body).await {
        Ok(upstream) => as_response(upstream, None),
        Err(resp) => resp,
    }
}

/// Allowed single-uid call inside a granted workspace: forward verbatim, keep
/// the map in sync on deletes, redact viewers.
async fn forward_single(
    state: &Arc<AppState>,
    creds: &[Cred],
    family: Family,
    method: &Method,
    rest: &str,
    query: &str,
    body: &Bytes,
    principal: &Principal,
) -> Response {
    let (table, _, _) = dialect(family);
    let upstream = match forward_to_postman(state, creds, method, &full_path(family, rest), query, body).await
    {
        Ok(upstream) => upstream,
        Err(resp) => return resp,
    };
    if upstream.status.is_success() && method == Method::DELETE {
        let uid = percent_decode(rest.split('/').next().unwrap_or(rest));
        let conn = lock_db(state);
        let _ = db::forget_entry(&conn, table, &uid);
    }
    if should_redact(principal, method, rest) && upstream.status.is_success() {
        if let Some(stripped) = strip_current_values(&upstream.body) {
            return as_response(upstream, Some(stripped));
        }
    }
    as_response(upstream, None)
}

pub(crate) struct Upstream {
    pub(crate) status: StatusCode,
    rate: Option<String>,
    content_type: Option<String>,
    pub(crate) body: Bytes,
}

/// The upstream call: method + path + query + JSON body, trying each account in
/// turn while the upstream refuses (a refused call did nothing there). 60s
/// timeout (on the shared client); the response of the last account tried is
/// passed through verbatim (status, body, content-type, rate-limit header).
pub(crate) async fn forward_to_postman(
    state: &Arc<AppState>,
    creds: &[Cred],
    method: &Method,
    path: &str,
    query: &str,
    body: &Bytes,
) -> Result<Upstream, Response> {
    forward_to_postman_bytes(state, creds, method, path, query, body.to_vec()).await
}

async fn forward_to_postman_bytes(
    state: &Arc<AppState>,
    creds: &[Cred],
    method: &Method,
    path: &str,
    query: &str,
    body: Vec<u8>,
) -> Result<Upstream, Response> {
    let mut last = Err(error(
        StatusCode::NOT_FOUND,
        "No connected Postman account can reach this workspace",
    ));
    for cred in creds {
        last = forward_once(state, cred, method, path, query, body.clone()).await;
        if let Ok(upstream) = &last {
            if !matches!(upstream.status.as_u16(), 401 | 403 | 404 | 429) {
                return last;
            }
        }
    }
    last
}

async fn forward_once(
    state: &Arc<AppState>,
    cred: &Cred,
    method: &Method,
    path: &str,
    query: &str,
    body: Vec<u8>,
) -> Result<Upstream, Response> {
    let mut url = format!("{}{}", cred.base, path);
    if !query.is_empty() {
        url.push('?');
        url.push_str(query);
    }
    let mut request = state
        .http
        .request(method.clone(), &url)
        .header("X-Api-Key", &cred.key)
        .header("Accept", "application/json");
    if !body.is_empty() {
        request = request
            .header(header::CONTENT_TYPE, "application/json")
            .body(body);
    }
    let upstream_resp = match request.send().await {
        Ok(resp) => resp,
        Err(_) => {
            return Err(error(
                StatusCode::BAD_GATEWAY,
                "Couldn't reach the Postman API. Check the server's internet connection.",
            ))
        }
    };
    let status = upstream_resp.status();
    let rate = upstream_resp
        .headers()
        .get(RATE_LIMIT_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string());
    let content_type = upstream_resp
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string());
    let upstream_body = upstream_resp.bytes().await.map_err(|_| {
        error(
            StatusCode::BAD_GATEWAY,
            "Couldn't read the response from the Postman API",
        )
    })?;
    Ok(Upstream {
        status,
        rate,
        content_type,
        body: upstream_body,
    })
}

pub(crate) fn as_response(upstream: Upstream, body_override: Option<Bytes>) -> Response {
    let content_type = upstream
        .content_type
        .unwrap_or_else(|| "application/json".to_string());
    let mut builder = Response::builder()
        .status(upstream.status)
        .header(header::CONTENT_TYPE, content_type);
    if let Some(rate) = upstream.rate {
        if let Ok(value) = axum::http::HeaderValue::from_str(&rate) {
            builder = builder.header(RATE_LIMIT_HEADER, value);
        }
    }
    builder
        .body(Body::from(body_override.unwrap_or(upstream.body)))
        .unwrap_or_else(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "Response construction failed"))
}

/// JSON response (merged/filtered lists) carrying the rate-limit header.
fn json_with_rate(status: StatusCode, value: &Value, rate: Option<&str>) -> Response {
    let mut response = json(status, value);
    if let Some(rate) = rate {
        if let Ok(header_value) = axum::http::HeaderValue::from_str(rate) {
            response.headers_mut().insert(RATE_LIMIT_HEADER, header_value);
        }
    }
    response
}

// ----- JSON body/query shaping ----------------------------------------------

/// Drops every `currentValue` field from a JSON body, keeping `value`;
/// returns None when the body isn't JSON.
fn strip_current_values(body: &Bytes) -> Option<Bytes> {
    let mut value: Value = serde_json::from_slice(body).ok()?;
    strip_value(&mut value);
    serde_json::to_vec(&value).ok().map(Bytes::from)
}

fn strip_value(value: &mut Value) {
    match value {
        Value::Object(map) => {
            let _ = map.remove("currentValue");
            for child in map.values_mut() {
                strip_value(child);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(strip_value),
        _ => {}
    }
}

/// The `workspace` query parameter, if present and non-empty.
fn query_workspace(query: &str) -> Option<&str> {
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        (key == "workspace" && !value.is_empty()).then_some(value)
    })
}

/// Rewrites/inserts the `workspace` query parameter, leaving other params.
fn query_with_workspace(query: &str, workspace: &str) -> String {
    let mut kept: Vec<String> = Vec::new();
    let mut replaced = false;
    for pair in query.split('&').filter(|pair| !pair.is_empty()) {
        if pair.split('=').next() == Some("workspace") {
            kept.push(format!("workspace={workspace}"));
            replaced = true;
        } else {
            kept.push(pair.to_string());
        }
    }
    if !replaced {
        kept.push(format!("workspace={workspace}"));
    }
    kept.join("&")
}

/// The caller's declared workspace: body["workspace"]["id"], then
/// body["workspaceId"], then the `workspace` query parameter.
fn find_workspace_in(body: &Bytes, query: &str) -> Option<String> {
    let value = serde_json::from_slice::<Value>(body).ok()?;
    find_workspace_in_value(&value, query)
}

fn find_workspace_in_value(value: &Value, query: &str) -> Option<String> {
    value
        .get("workspace")
        .and_then(|ws| ws.get("id"))
        .and_then(Value::as_str)
        .or_else(|| value.get("workspaceId").and_then(Value::as_str))
        .map(str::to_string)
        .or_else(|| query_workspace(query).map(str::to_string))
}

/// Forces the declared workspace into the body: an existing workspace object
/// simply gets its `id` replaced; otherwise `workspace` (and any explicit
/// `workspaceId`) is set to the chosen workspace.
fn force_workspace_in_body(value: &mut Value, workspace: &str) {
    let Some(map) = value.as_object_mut() else { return };
    match map.remove("workspace") {
        Some(Value::Object(ws_obj)) => {
            let mut ws_obj = ws_obj;
            ws_obj.insert("id".to_string(), json!(workspace));
            map.insert("workspace".to_string(), Value::Object(ws_obj));
        }
        _ => {
            map.insert("workspace".to_string(), json!({ "id": workspace }));
        }
    }
    if map.contains_key("workspaceId") {
        map.insert("workspaceId".to_string(), json!(workspace));
    }
}

/// Only uids are compared against the map; decode the percent-encoding the
/// URL carried so "1%2Ddemo" matches the stored "1-demo".
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hi = (bytes[index + 1] as char).to_digit(16);
            let lo = (bytes[index + 2] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push((hi * 16 + lo) as u8);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}