//! The admin API (users, Postman accounts, workspaces, settings, audit) and the
//! embedded admin panel.

use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::extract::{Path, RawQuery, State};
use axum::http::{header, Method, StatusCode};
use axum::response::{IntoResponse, Redirect, Response};
use include_dir::{include_dir, Dir};
use serde_json::{json, Value};

use crate::accounts::{self, Cred, ENV_ACCOUNT_ID};
use crate::auth::{self, AuthUser};
use crate::proxy;
use crate::db;
use crate::{error, json, lock_db, AppState};

/// The vanilla-JS admin panel, embedded at build time from server/admin/.
static ADMIN_DIR: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/admin");

fn admin_only(user: &AuthUser) -> Result<(), Response> {
    if user.role == "admin" {
        Ok(())
    } else {
        Err(error(StatusCode::FORBIDDEN, "Only admins can do this"))
    }
}

// ---------- users -----------------------------------------------------------

pub async fn users_list(State(state): State<Arc<AppState>>, user: AuthUser) -> Response {
    if let Err(resp) = admin_only(&user) {
        return resp;
    }
    let conn = lock_db(&state);
    match db::list_users(&conn) {
        Ok(users) => json(
            StatusCode::OK,
            &json!(users.iter().map(db::user_json).collect::<Vec<Value>>()),
        ),
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "Couldn't list users"),
    }
}

pub async fn users_create(State(state): State<Arc<AppState>>, user: AuthUser, body: Bytes) -> Response {
    if let Err(resp) = admin_only(&user) {
        return resp;
    }
    let value = match parse_body(&body) {
        Ok(value) => value,
        Err(resp) => return resp,
    };
    let Some(email) = auth::email_of(&value) else {
        return error(StatusCode::BAD_REQUEST, "Enter a valid email address");
    };
    let Some(password) = auth::password_of(&value) else {
        return error(StatusCode::BAD_REQUEST, "Password must be at least 8 characters");
    };
    if !auth::password_ok(password) {
        return error(StatusCode::BAD_REQUEST, "Password must be at least 8 characters");
    }
    let role = match value.get("role") {
        None | Some(Value::Null) => "viewer".to_string(),
        Some(Value::String(candidate)) => candidate.clone(),
        Some(_) => {
            return error(
                StatusCode::BAD_REQUEST,
                "Role must be one of viewer, editor, creator or admin",
            )
        }
    };
    if !auth::is_valid_role(&role) {
        return error(
            StatusCode::BAD_REQUEST,
            "Role must be one of viewer, editor, creator or admin",
        );
    }
    // No access until granted, unless the request asks for all workspaces (null).
    let no_access = json!([]);
    let grants = match grants_text(Some(value.get("workspace_grants").unwrap_or(&no_access))) {
        Ok(grants) => grants,
        Err(resp) => return resp,
    };
    let password_hash = match auth::hash_password(password) {
        Ok(hash) => hash,
        Err(msg) => return error(StatusCode::INTERNAL_SERVER_ERROR, msg),
    };
    let created = {
        let conn = lock_db(&state);
        db::insert_user(&conn, email, &password_hash, &role, grants.as_deref(), &db::now_iso())
    };
    match created {
        Ok(id) => match {
            let conn = lock_db(&state);
            db::find_user_by_id(&conn, id)
        } {
            Ok(Some(created)) => json(StatusCode::CREATED, &db::user_json(&created)),
            _ => error(StatusCode::INTERNAL_SERVER_ERROR, "Couldn't create the account"),
        },
        Err(rusqlite::Error::SqliteFailure(e, _))
            if e.code == rusqlite::ErrorCode::ConstraintViolation =>
        {
            error(StatusCode::CONFLICT, "An account with this email already exists")
        }
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "Couldn't create the account"),
    }
}

pub async fn users_update(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
    Path(id_text): Path<String>,
    body: Bytes,
) -> Response {
    if let Err(resp) = admin_only(&user) {
        return resp;
    }
    let Ok(id) = id_text.parse::<i64>() else {
        return error(StatusCode::NOT_FOUND, "No such user");
    };
    let value = match parse_body(&body) {
        Ok(value) => value,
        Err(resp) => return resp,
    };
    let role = match value.get("role") {
        None | Some(Value::Null) => None,
        Some(Value::String(candidate)) => {
            if auth::is_valid_role(candidate) {
                Some(candidate)
            } else {
                return error(
                    StatusCode::BAD_REQUEST,
                    "Role must be one of viewer, editor, creator or admin",
                );
            }
        }
        Some(_) => {
            return error(
                StatusCode::BAD_REQUEST,
                "Role must be one of viewer, editor, creator or admin",
            )
        }
    };
    let grants = match value.get("workspace_grants") {
        None => None,
        Some(found) => match grants_text(Some(found)) {
            Ok(parsed) => Some(parsed),
            Err(resp) => return resp,
        },
    };
    let password_hash = match value.get("password") {
        None | Some(Value::Null) => None,
        Some(Value::String(password)) => {
            if !auth::password_ok(password) {
                return error(StatusCode::BAD_REQUEST, "Password must be at least 8 characters");
            }
            match auth::hash_password(password) {
                Ok(hash) => Some(Some(hash)),
                Err(msg) => return error(StatusCode::INTERNAL_SERVER_ERROR, msg),
            }
        }
        Some(_) => {
            return error(StatusCode::BAD_REQUEST, "Password must be a string")
        }
    };
    let updated = {
        let conn = lock_db(&state);
        match db::update_user(
            &conn,
            id,
            role.map(|r| r.as_str()),
            grants,
            password_hash.as_ref().map(|outer| outer.as_deref()).flatten(),
        ) {
            Ok(true) => db::find_user_by_id(&conn, id),
            Ok(false) => return error(StatusCode::NOT_FOUND, "No such user"),
            Err(_) => return error(StatusCode::INTERNAL_SERVER_ERROR, "Couldn't update the user"),
        }
    };
    match updated {
        Ok(Some(updated)) => json(StatusCode::OK, &db::user_json(&updated)),
        _ => error(StatusCode::INTERNAL_SERVER_ERROR, "Couldn't update the user"),
    }
}

pub async fn users_delete(State(state): State<Arc<AppState>>, user: AuthUser, Path(id_text): Path<String>) -> Response {
    if let Err(resp) = admin_only(&user) {
        return resp;
    }
    let Ok(id) = id_text.parse::<i64>() else {
        return error(StatusCode::NOT_FOUND, "No such user");
    };
    if user.user_id == id {
        return error(StatusCode::BAD_REQUEST, "You can't delete your own account");
    }
    let deleted = {
        let conn = lock_db(&state);
        db::delete_user(&conn, id)
    };
    match deleted {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => error(StatusCode::NOT_FOUND, "No such user"),
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "Couldn't delete the user"),
    }
}

// ---------- Postman accounts ---------------------------------------------------

const POSTMAN_KEY_MAX: usize = 512;

fn key_hint(key: &str) -> String {
    let tail: String = key.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
    format!("…{tail}")
}

fn clean_key(value: Option<&Value>) -> Option<String> {
    let key = value?.as_str()?.trim();
    let printable = key.chars().all(|c| c.is_ascii_graphic());
    (!key.is_empty() && key.len() <= POSTMAN_KEY_MAX && printable).then(|| key.to_string())
}

fn clean_label(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .map(|label| label.trim().chars().take(80).collect())
        .unwrap_or_default()
}

struct KeyCheck {
    status: &'static str,
    user_id: Option<String>,
    name: Option<String>,
    usage: Value,
}

/// Who a key belongs to, from Postman's own GET /me.
async fn identify_key(state: &Arc<AppState>, cred: &Cred) -> KeyCheck {
    let failed = |status| KeyCheck { status, user_id: None, name: None, usage: Value::Null };
    let upstream = proxy::forward_to_postman(
        state,
        std::slice::from_ref(cred),
        &Method::GET,
        "/me",
        "",
        &Bytes::new(),
    )
    .await;
    let Ok(upstream) = upstream else { return failed("unreachable") };
    if matches!(upstream.status.as_u16(), 401 | 403) {
        return failed("invalid");
    }
    if !upstream.status.is_success() {
        return failed("unreachable");
    }
    let value: Value = serde_json::from_slice(&upstream.body).unwrap_or(Value::Null);
    let user = value.get("user").cloned().unwrap_or(Value::Null);
    let name = ["teamName", "fullName", "username"]
        .iter()
        .find_map(|field| user.get(*field).and_then(Value::as_str).filter(|v| !v.is_empty()))
        .map(str::to_string);
    let user_id = match user.get("id") {
        Some(Value::Number(id)) => Some(id.to_string()),
        Some(Value::String(id)) => Some(id.clone()),
        _ => None,
    };
    let usage = value
        .get("operations")
        .and_then(Value::as_array)
        .and_then(|ops| ops.iter().find(|op| op.get("name").and_then(Value::as_str) == Some("api_usage")))
        .and_then(|op| Some(json!({ "used": op.get("usage")?.as_f64()?, "limit": op.get("limit")?.as_f64()? })))
        .unwrap_or(Value::Null);
    KeyCheck { status: "ok", user_id, name, usage }
}

fn workspace_count(state: &AppState, account_id: i64) -> i64 {
    let conn = lock_db(state);
    db::workspace_count(&conn, account_id).unwrap_or(0)
}

fn stored_account_json(row: &db::AccountRow) -> Value {
    json!({
        "id": row.id,
        "label": row.label,
        "region": row.region,
        "key_hint": row.key_hint,
        "source": "stored",
        "postman_name": row.postman_name,
        "created_by": row.created_by,
        "created_at": row.created_at,
    })
}

async fn with_live_status(state: &Arc<AppState>, mut base: Value, cred: Option<&Cred>, id: i64) -> Value {
    let check = match cred {
        Some(cred) => identify_key(state, cred).await,
        None => KeyCheck { status: "undecryptable", user_id: None, name: None, usage: Value::Null },
    };
    if let Some(name) = check.name {
        base["postman_name"] = json!(name);
    } else if base.get("postman_name").is_none() {
        base["postman_name"] = Value::Null;
    }
    base["status"] = json!(check.status);
    base["usage"] = check.usage;
    base["workspace_count"] = json!(workspace_count(state, id));
    base
}

fn audit_account(state: &AppState, user: &AuthUser, action: &str, method: &str, path: &str, response: Response) -> Response {
    let conn = lock_db(state);
    let _ = db::audit_insert(
        &conn,
        &db::now_iso(),
        Some(user.user_id),
        Some(&user.email),
        action,
        method,
        path,
        response.status().as_u16() as i64,
    );
    response
}

fn clear_list_cache(state: &AppState) {
    crate::lock_cache(state).clear();
}

pub async fn accounts_list(State(state): State<Arc<AppState>>, user: AuthUser) -> Response {
    if let Err(resp) = admin_only(&user) {
        return resp;
    }
    let creds = accounts::connected(&state);
    let _ = proxy::sync_workspaces(&state, &creds, "").await;
    let mut list = Vec::new();
    if let Some(cred) = accounts::env_cred(&state) {
        let base = json!({
            "id": ENV_ACCOUNT_ID,
            "label": cred.label,
            "region": state.config.postman_region,
            "key_hint": key_hint(&cred.key),
            "source": "environment",
            "created_by": Value::Null,
            "created_at": Value::Null,
        });
        list.push(with_live_status(&state, base, Some(&cred), ENV_ACCOUNT_ID).await);
    }
    let rows = {
        let conn = lock_db(&state);
        db::list_accounts(&conn).unwrap_or_default()
    };
    for row in &rows {
        let cred = creds.iter().find(|cred| cred.id == row.id);
        list.push(with_live_status(&state, stored_account_json(row), cred, row.id).await);
    }
    json(StatusCode::OK, &json!({ "accounts": list, "can_store_keys": true }))
}

pub async fn accounts_create(State(state): State<Arc<AppState>>, user: AuthUser, body: Bytes) -> Response {
    if let Err(resp) = admin_only(&user) {
        return resp;
    }
    let response = accounts_create_inner(&state, &user, &body).await;
    audit_account(&state, &user, "account_add", "POST", "/admin/postman-accounts", response)
}

async fn accounts_create_inner(state: &Arc<AppState>, user: &AuthUser, body: &Bytes) -> Response {
    let value = match parse_body(body) {
        Ok(value) => value,
        Err(resp) => return resp,
    };
    let Some(key) = clean_key(value.get("api_key")) else {
        return error(StatusCode::BAD_REQUEST, "Paste a Postman API key");
    };
    let region = match value.get("region") {
        None | Some(Value::Null) => "us",
        Some(Value::String(region)) if region == "us" => "us",
        Some(Value::String(region)) if region == "eu" => "eu",
        Some(_) => return error(StatusCode::BAD_REQUEST, "Region must be us or eu"),
    };
    let probe = Cred { id: -1, label: String::new(), key: key.clone(), base: state.config.postman_base_for(region) };
    let check = identify_key(state, &probe).await;
    match check.status {
        "ok" => {}
        "invalid" => return error(StatusCode::BAD_REQUEST, "Postman didn't accept this key. Check the key and its region."),
        _ => return error(StatusCode::BAD_GATEWAY, "Couldn't reach the Postman API to check this key. Try again."),
    }
    if let Some(postman_user) = &check.user_id {
        let twin = {
            let conn = lock_db(state);
            db::account_label_for_postman_user(&conn, postman_user).ok().flatten()
        };
        if let Some(label) = twin {
            return error(StatusCode::CONFLICT, format!("This Postman user is already connected as \"{label}\""));
        }
    }
    let mut label = clean_label(value.get("label"));
    if label.is_empty() {
        label = check.name.clone().unwrap_or_else(|| format!("Postman account {}", key_hint(&key)));
    }
    let ciphertext = match accounts::encrypt_key(&state.config.secret_key, &key) {
        Ok(ciphertext) => ciphertext,
        Err(msg) => return error(StatusCode::INTERNAL_SERVER_ERROR, msg),
    };
    let row = {
        let conn = lock_db(state);
        let inserted = db::insert_account(
            &conn,
            &label,
            region,
            &ciphertext,
            &key_hint(&key),
            check.user_id.as_deref(),
            check.name.as_deref(),
            Some(&user.email),
        );
        match inserted.and_then(|id| db::find_account(&conn, id)) {
            Ok(Some(row)) => row,
            _ => return error(StatusCode::INTERNAL_SERVER_ERROR, "Couldn't save the account"),
        }
    };
    clear_list_cache(state);
    let cred = Cred { id: row.id, label: row.label.clone(), key, base: probe.base };
    let _ = proxy::sync_workspaces(state, std::slice::from_ref(&cred), "").await;
    let mut out = stored_account_json(&row);
    out["status"] = json!("ok");
    out["usage"] = check.usage;
    out["workspace_count"] = json!(workspace_count(state, row.id));
    json(StatusCode::CREATED, &out)
}

pub async fn accounts_update(
    State(state): State<Arc<AppState>>,
    user: AuthUser,
    Path(id_text): Path<String>,
    body: Bytes,
) -> Response {
    if let Err(resp) = admin_only(&user) {
        return resp;
    }
    let path = format!("/admin/postman-accounts/{id_text}");
    let response = accounts_update_inner(&state, &id_text, &body).await;
    audit_account(&state, &user, "account_update", "PATCH", &path, response)
}

async fn accounts_update_inner(state: &Arc<AppState>, id_text: &str, body: &Bytes) -> Response {
    let Ok(id) = id_text.parse::<i64>() else {
        return error(StatusCode::NOT_FOUND, "No such Postman account");
    };
    if id == ENV_ACCOUNT_ID {
        return error(StatusCode::BAD_REQUEST, "This key comes from the server's POSTMAN_API_KEY setting. Change it there.");
    }
    let value = match parse_body(body) {
        Ok(value) => value,
        Err(resp) => return resp,
    };
    let row = {
        let conn = lock_db(state);
        db::find_account(&conn, id).ok().flatten()
    };
    let Some(row) = row else {
        return error(StatusCode::NOT_FOUND, "No such Postman account");
    };
    if value.get("label").is_some() {
        let label = clean_label(value.get("label"));
        if label.is_empty() {
            return error(StatusCode::BAD_REQUEST, "Give the account a name");
        }
        let conn = lock_db(state);
        let _ = db::set_account_label(&conn, id, &label);
    }
    if value.get("api_key").is_some() {
        let Some(key) = clean_key(value.get("api_key")) else {
            return error(StatusCode::BAD_REQUEST, "Paste a Postman API key");
        };
        let cred = Cred { id, label: row.label.clone(), key: key.clone(), base: state.config.postman_base_for(&row.region) };
        let check = identify_key(state, &cred).await;
        match check.status {
            "ok" => {}
            "invalid" => return error(StatusCode::BAD_REQUEST, "Postman didn't accept this key. Check the key and its region."),
            _ => return error(StatusCode::BAD_GATEWAY, "Couldn't reach the Postman API to check this key. Try again."),
        }
        let ciphertext = match accounts::encrypt_key(&state.config.secret_key, &key) {
            Ok(ciphertext) => ciphertext,
            Err(msg) => return error(StatusCode::INTERNAL_SERVER_ERROR, msg),
        };
        {
            let conn = lock_db(state);
            let _ = db::set_account_key(&conn, id, &ciphertext, &key_hint(&key), check.user_id.as_deref(), check.name.as_deref());
        }
        let _ = proxy::sync_workspaces(state, std::slice::from_ref(&cred), "").await;
    }
    clear_list_cache(state);
    let updated = {
        let conn = lock_db(state);
        db::find_account(&conn, id).ok().flatten()
    };
    let Some(updated) = updated else {
        return error(StatusCode::NOT_FOUND, "No such Postman account");
    };
    let creds = accounts::connected(state);
    let cred = creds.iter().find(|cred| cred.id == id);
    json(StatusCode::OK, &with_live_status(state, stored_account_json(&updated), cred, id).await)
}

pub async fn accounts_delete(State(state): State<Arc<AppState>>, user: AuthUser, Path(id_text): Path<String>) -> Response {
    if let Err(resp) = admin_only(&user) {
        return resp;
    }
    let path = format!("/admin/postman-accounts/{id_text}");
    let response = match id_text.parse::<i64>() {
        Err(_) => error(StatusCode::NOT_FOUND, "No such Postman account"),
        Ok(ENV_ACCOUNT_ID) => error(StatusCode::BAD_REQUEST, "This key comes from the server's POSTMAN_API_KEY setting. Remove it there."),
        Ok(id) => {
            let deleted = {
                let conn = lock_db(&state);
                db::delete_account(&conn, id)
            };
            clear_list_cache(&state);
            match deleted {
                Ok(true) => StatusCode::NO_CONTENT.into_response(),
                Ok(false) => error(StatusCode::NOT_FOUND, "No such Postman account"),
                Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "Couldn't remove the account"),
            }
        }
    };
    audit_account(&state, &user, "account_remove", "DELETE", &path, response)
}

/// Every workspace any connected account reaches, each once, with the accounts
/// that reach it.
pub async fn workspaces_list(State(state): State<Arc<AppState>>, user: AuthUser) -> Response {
    if let Err(resp) = admin_only(&user) {
        return resp;
    }
    let creds = accounts::connected(&state);
    let results = proxy::sync_workspaces(&state, &creds, "").await;
    let mut workspaces: Vec<Value> = Vec::new();
    let mut failed: Vec<String> = Vec::new();
    for (cred, upstream) in results {
        let value = match &upstream {
            Ok(found) if found.status.is_success() => serde_json::from_slice::<Value>(&found.body).ok(),
            _ => None,
        };
        let Some(value) = value else {
            failed.push(cred.label.clone());
            continue;
        };
        for ws in value.get("workspaces").and_then(Value::as_array).into_iter().flatten() {
            let Some(id) = ws.get("id").and_then(Value::as_str) else { continue };
            let account = json!({ "id": cred.id, "label": cred.label });
            if let Some(entry) = workspaces.iter_mut().find(|entry| entry["id"] == id) {
                if let Some(list) = entry["accounts"].as_array_mut() {
                    list.push(account);
                }
            } else {
                workspaces.push(json!({
                    "id": id,
                    "name": ws.get("name").and_then(Value::as_str).unwrap_or(id),
                    "type": ws.get("type").and_then(Value::as_str).unwrap_or(""),
                    "accounts": [account],
                }));
            }
        }
    }
    workspaces.sort_by_key(|entry| entry["name"].as_str().unwrap_or("").to_lowercase());
    json(StatusCode::OK, &json!({ "workspaces": workspaces, "failed_accounts": failed }))
}

// ---------- settings --------------------------------------------------------

pub async fn settings_get(State(state): State<Arc<AppState>>, user: AuthUser) -> Response {
    if let Err(resp) = admin_only(&user) {
        return resp;
    }
    let allow_registration = {
        let conn = lock_db(&state);
        db::allow_registration(&conn).unwrap_or(true)
    };
    json(StatusCode::OK, &json!({ "allow_registration": allow_registration }))
}

pub async fn settings_patch(State(state): State<Arc<AppState>>, user: AuthUser, body: Bytes) -> Response {
    if let Err(resp) = admin_only(&user) {
        return resp;
    }
    let value = match parse_body(&body) {
        Ok(value) => value,
        Err(resp) => return resp,
    };
    let Some(allow_registration) = value.get("allow_registration").and_then(Value::as_bool) else {
        return error(StatusCode::BAD_REQUEST, "allow_registration must be true or false");
    };
    let conn = lock_db(&state);
    match db::set_setting(&conn, "allow_registration", if allow_registration { "1" } else { "0" }) {
        Ok(()) => json(StatusCode::OK, &json!({ "allow_registration": allow_registration })),
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "Couldn't save the setting"),
    }
}

// ---------- audit -----------------------------------------------------------

pub async fn audit_list(State(state): State<Arc<AppState>>, user: AuthUser, RawQuery(query): RawQuery) -> Response {
    if let Err(resp) = admin_only(&user) {
        return resp;
    }
    let limit = match parse_limit(query.as_deref()) {
        Ok(limit) => limit,
        Err(resp) => return resp,
    };
    let conn = lock_db(&state);
    match db::audit_list(&conn, limit) {
        Ok(rows) => json(StatusCode::OK, &db::audit_json(&rows)),
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "Couldn't read the audit trail"),
    }
}

/// Newest-first listing capped at 1000 rows (default 100).
fn parse_limit(query: Option<&str>) -> Result<i64, Response> {
    let raw = query.and_then(|query| {
        query.split('&').find_map(|pair| {
            let (key, value) = pair.split_once('=')?;
            (key == "limit" && !value.is_empty()).then_some(value)
        })
    });
    match raw {
        None => Ok(100),
        Some(text) => match text.parse::<i64>() {
            Ok(limit) => Ok(limit.clamp(1, 1000)),
            Err(_) => Err(error(StatusCode::BAD_REQUEST, "limit must be a number")),
        },
    }
}

// ---------- shared bits ------------------------------------------------------

fn parse_body(body: &Bytes) -> Result<Value, Response> {
    serde_json::from_slice(body)
        .map_err(|_| error(StatusCode::BAD_REQUEST, "Body must be valid JSON"))
}

/// workspace_grants in admin payloads: null (all workspaces) or an array of
/// workspace ID strings; stored as JSON text.
fn grants_text(value: Option<&Value>) -> Result<Option<String>, Response> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(list)) if list.iter().all(Value::is_string) => serde_json::to_string(list)
            .ok()
            .map(Some)
            .ok_or_else(|| error(StatusCode::INTERNAL_SERVER_ERROR, "Couldn't encode workspace grants")),
        Some(_) => Err(error(
            StatusCode::BAD_REQUEST,
            "workspace_grants must be an array of workspace IDs",
        )),
    }
}

// ---------- embedded admin panel --------------------------------------------

/// GET /admin (no trailing slash) redirects so the panel's relative assets
/// (./styles.css, ./app.js) resolve against /admin/.
pub async fn panel_redirect() -> Response {
    Redirect::to("/admin/").into_response()
}

pub async fn panel_index() -> Response {
    match ADMIN_DIR.get_file("index.html") {
        Some(file) => file_response(file),
        None => error(
            StatusCode::NOT_FOUND,
            "The admin panel (index.html) is not embedded in this binary",
        ),
    }
}

pub async fn panel_file(Path(path): Path<String>) -> Response {
    let relative = path.trim_start_matches('/');
    match ADMIN_DIR.get_file(relative) {
        Some(file) => file_response(file),
        None => error(StatusCode::NOT_FOUND, "No such admin panel file"),
    }
}

fn file_response(file: &'static include_dir::File<'static>) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type(file.path().to_string_lossy().as_ref()))
        .body(Body::from(axum::body::Bytes::from_static(file.contents())))
        .unwrap_or_else(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "Response construction failed"))
}

fn content_type(path: &str) -> &'static str {
    let extension = path.rsplit('.').next().unwrap_or("");
    match extension {
        "html" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json",
        "txt" | "md" => "text/plain; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}