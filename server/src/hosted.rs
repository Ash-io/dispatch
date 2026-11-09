//! Dispatch workspaces: workspaces stored in this server's database instead of
//! in Postman. They answer the same Postman-shaped endpoints the desktop app
//! already uses (workspaces, collections, environments, global variables), so
//! a team can work without any Postman account. The proxy calls in here before
//! it forwards anything.

use std::sync::Arc;

use axum::body::Bytes;
use axum::http::{Method, StatusCode};
use axum::response::Response;
use serde_json::{json, Map, Value};

use crate::auth::random_hex;
use crate::db::{self, DispatchItem};
use crate::{error, json, lock_db, AppState};

pub const COLLECTION: &str = "collection";
pub const ENVIRONMENT: &str = "environment";
const SCHEMA_V21: &str = "https://schema.getpostman.com/json/collection/v2.1.0/collection.json";
const NOT_HERE: &str = "This isn't available for workspaces stored on this Dispatch server";

/// A random UUID (v4), the shape Postman uses for ids.
pub fn new_id() -> String {
    let mut hex = random_hex(16).into_bytes();
    hex[12] = b'4';
    hex[16] = b"89ab"[(hex[16] as usize) % 4];
    let hex = String::from_utf8(hex).unwrap_or_default();
    format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32])
}

fn list_key(kind: &str) -> &'static str {
    if kind == COLLECTION { "collections" } else { "environments" }
}

pub fn is_hosted(state: &AppState, workspace: &str) -> bool {
    let conn = lock_db(state);
    db::dispatch_workspace(&conn, workspace).ok().flatten().is_some()
}

pub fn ids(state: &AppState) -> Vec<String> {
    let conn = lock_db(state);
    db::dispatch_workspaces(&conn).unwrap_or_default().into_iter().map(|ws| ws.id).collect()
}

fn in_reach(allowed: Option<&[String]>, workspace: &str) -> bool {
    allowed.map_or(true, |list| list.iter().any(|one| one == workspace))
}

/// The /workspaces entries for every Dispatch workspace this caller may see.
pub fn workspace_entries(state: &AppState, allowed: Option<&[String]>) -> Vec<Value> {
    let conn = lock_db(state);
    db::dispatch_workspaces(&conn)
        .unwrap_or_default()
        .into_iter()
        .filter(|ws| in_reach(allowed, &ws.id))
        .map(|ws| json!({ "id": ws.id, "name": ws.name, "type": "team", "visibility": "team", "dispatch": true }))
        .collect()
}

fn entry_json(item: &DispatchItem) -> Value {
    json!({
        "id": item.uid,
        "uid": item.uid,
        "name": item.name,
        "owner": "",
        "createdAt": item.created_at,
        "updatedAt": item.updated_at,
        "isPublic": false,
    })
}

/// The list entries of one kind across every Dispatch workspace in reach.
pub fn entries_in_reach(state: &AppState, kind: &str, allowed: Option<&[String]>) -> Vec<Value> {
    let conn = lock_db(state);
    let mut out = Vec::new();
    for ws in db::dispatch_workspaces(&conn).unwrap_or_default() {
        if in_reach(allowed, &ws.id) {
            out.extend(db::dispatch_items(&conn, &ws.id, kind).unwrap_or_default().iter().map(entry_json));
        }
    }
    out
}

/// GET /collections?workspace=… (or environments) for a Dispatch workspace.
pub fn list(state: &AppState, kind: &str, workspace: &str) -> Response {
    let conn = lock_db(state);
    let items = db::dispatch_items(&conn, workspace, kind).unwrap_or_default();
    let mut body = Map::new();
    body.insert(list_key(kind).to_string(), Value::Array(items.iter().map(entry_json).collect()));
    json(StatusCode::OK, &Value::Object(body))
}

// ----- documents ------------------------------------------------------------

/// Gives every item and folder an id, as Postman does when it stores a collection.
fn assign_item_ids(items: &mut Value) {
    let Some(list) = items.as_array_mut() else { return };
    for item in list {
        let Some(map) = item.as_object_mut() else { continue };
        if !map.get("id").is_some_and(|id| id.as_str().is_some_and(|text| !text.is_empty())) {
            map.insert("id".into(), json!(new_id()));
        }
        if let Some(children) = map.get_mut("item") {
            assign_item_ids(children);
        }
    }
}

/// Checks a create/update body and returns (name, the document to store).
fn document(kind: &str, body: &Bytes, uid: &str, created: &str, updated: &str) -> Result<(String, Value), Response> {
    let value: Value = serde_json::from_slice(body)
        .map_err(|_| error(StatusCode::BAD_REQUEST, "Body must be valid JSON"))?;
    let Some(Value::Object(doc)) = value.get(kind).cloned() else {
        return Err(error(StatusCode::BAD_REQUEST, format!("The body needs a \"{kind}\" object")));
    };
    let mut doc = doc;
    if kind == COLLECTION {
        let mut info = match doc.remove("info") {
            Some(Value::Object(info)) => info,
            _ => Map::new(),
        };
        let name = info.get("name").and_then(Value::as_str).map(str::trim).unwrap_or("").to_string();
        if name.is_empty() {
            return Err(error(StatusCode::BAD_REQUEST, "The collection needs a name (info.name)"));
        }
        info.insert("_postman_id".into(), json!(uid));
        info.insert("name".into(), json!(name));
        if !info.get("schema").is_some_and(Value::is_string) {
            info.insert("schema".into(), json!(SCHEMA_V21));
        }
        info.insert("createdAt".into(), json!(created));
        info.insert("updatedAt".into(), json!(updated));
        info.insert("uid".into(), json!(uid));
        let mut items = doc.remove("item").filter(Value::is_array).unwrap_or_else(|| json!([]));
        assign_item_ids(&mut items);
        let mut out = Map::new();
        out.insert("info".into(), Value::Object(info));
        out.insert("item".into(), items);
        out.extend(doc);
        Ok((name, Value::Object(out)))
    } else {
        let name = doc.get("name").and_then(Value::as_str).map(str::trim).unwrap_or("").to_string();
        if name.is_empty() {
            return Err(error(StatusCode::BAD_REQUEST, "The environment needs a name"));
        }
        let values = doc.get("values").cloned().filter(Value::is_array).unwrap_or_else(|| json!([]));
        Ok((
            name.clone(),
            json!({
                "id": uid,
                "name": name,
                "owner": "",
                "createdAt": created,
                "updatedAt": updated,
                "isPublic": false,
                "values": values,
            }),
        ))
    }
}

fn summary(kind: &str, uid: &str, name: Option<&str>) -> Response {
    let mut inner = json!({ "id": uid, "uid": uid });
    if let Some(name) = name {
        inner["name"] = json!(name);
    }
    let mut body = Map::new();
    body.insert(kind.to_string(), inner);
    json(StatusCode::OK, &Value::Object(body))
}

/// Stores a new collection or environment in a Dispatch workspace.
pub fn create(state: &AppState, kind: &str, workspace: &str, body: &Bytes) -> Response {
    let uid = new_id();
    let now = db::now_iso();
    let (name, doc) = match document(kind, body, &uid, &now, &now) {
        Ok(found) => found,
        Err(resp) => return resp,
    };
    let item = DispatchItem {
        uid: uid.clone(),
        workspace_id: workspace.to_string(),
        name: name.clone(),
        body: doc.to_string(),
        created_at: now.clone(),
        updated_at: now,
    };
    let conn = lock_db(state);
    match db::insert_dispatch_item(&conn, &item, kind) {
        Ok(()) => summary(kind, &uid, Some(&name)),
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, format!("Couldn't save the {kind}")),
    }
}

/// One stored collection or environment, addressed by uid. None when the uid
/// isn't stored here, so the call goes on to Postman.
pub fn single(
    state: &AppState,
    kind: &str,
    method: &Method,
    rest: &str,
    uid: &str,
    body: &Bytes,
    allowed: Option<&[String]>,
    viewer: bool,
) -> Option<Response> {
    let item = {
        let conn = lock_db(state);
        db::dispatch_item(&conn, uid, kind).ok().flatten()
    }?;
    if !in_reach(allowed, &item.workspace_id) {
        return Some(error(
            StatusCode::FORBIDDEN,
            format!("This {kind} isn't in one of your workspaces — refresh your {kind}s list first"),
        ));
    }
    if rest.contains('/') {
        return Some(error(StatusCode::BAD_REQUEST, NOT_HERE));
    }
    let response = match method.as_str() {
        "GET" | "HEAD" => {
            let mut doc: Value = serde_json::from_str(&item.body).unwrap_or(Value::Null);
            if viewer {
                crate::proxy::strip_value(&mut doc);
            }
            let mut out = Map::new();
            out.insert(kind.to_string(), doc);
            json(StatusCode::OK, &Value::Object(out))
        }
        "PUT" => {
            let updated = db::stamp_after(Some(&item.updated_at));
            match document(kind, body, &item.uid, &item.created_at, &updated) {
                Err(resp) => resp,
                Ok((name, doc)) => {
                    let conn = lock_db(state);
                    match db::update_dispatch_item(&conn, &item.uid, &name, &doc.to_string(), &updated) {
                        Ok(_) => summary(kind, &item.uid, Some(&name)),
                        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, format!("Couldn't save the {kind}")),
                    }
                }
            }
        }
        "DELETE" => {
            let conn = lock_db(state);
            match db::delete_dispatch_item(&conn, &item.uid) {
                Ok(_) => summary(kind, &item.uid, None),
                Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, format!("Couldn't delete the {kind}")),
            }
        }
        _ => error(StatusCode::BAD_REQUEST, NOT_HERE),
    };
    Some(response)
}

// ----- the workspace itself --------------------------------------------------

/// /workspaces/{id}…, for a Dispatch workspace. The caller has checked reach.
pub fn workspace_call(state: &AppState, method: &Method, workspace: &str, rest: &str, body: &Bytes) -> Response {
    let sub = rest.split_once('/').map(|(_, sub)| sub).unwrap_or("");
    let found = {
        let conn = lock_db(state);
        db::dispatch_workspace(&conn, workspace).ok().flatten()
    };
    let Some(ws) = found else {
        return error(StatusCode::NOT_FOUND, "No such workspace");
    };
    match (method.as_str(), sub) {
        ("GET" | "HEAD", "") => {
            let conn = lock_db(state);
            let brief = |kind: &str| -> Vec<Value> {
                db::dispatch_items(&conn, &ws.id, kind)
                    .unwrap_or_default()
                    .iter()
                    .map(|item| json!({ "id": item.uid, "uid": item.uid, "name": item.name }))
                    .collect()
            };
            json(
                StatusCode::OK,
                &json!({ "workspace": {
                    "id": ws.id,
                    "name": ws.name,
                    "type": "team",
                    "visibility": "team",
                    "description": "",
                    "createdBy": ws.created_by,
                    "createdAt": ws.created_at,
                    "updatedAt": ws.updated_at,
                    "dispatch": true,
                    "collections": brief(COLLECTION),
                    "environments": brief(ENVIRONMENT),
                }}),
            )
        }
        ("PUT", "") => {
            let value: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
            let name = value.pointer("/workspace/name").and_then(Value::as_str).map(str::trim).unwrap_or("");
            if name.is_empty() {
                return error(StatusCode::BAD_REQUEST, "The workspace needs a name");
            }
            let conn = lock_db(state);
            let _ = db::rename_dispatch_workspace(&conn, &ws.id, name);
            json(StatusCode::OK, &json!({ "workspace": { "id": ws.id, "name": name } }))
        }
        ("DELETE", "") => {
            let conn = lock_db(state);
            let _ = db::delete_dispatch_workspace(&conn, &ws.id);
            json(StatusCode::OK, &json!({ "workspace": { "id": ws.id } }))
        }
        ("GET" | "HEAD", "global-variables") => {
            let values: Value = serde_json::from_str(&ws.globals).unwrap_or_else(|_| json!([]));
            json(StatusCode::OK, &json!({ "values": values }))
        }
        ("PUT", "global-variables") => {
            let value: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
            let Some(values) = value.get("values").filter(|values| values.is_array()) else {
                return error(StatusCode::BAD_REQUEST, "The body needs a \"values\" array");
            };
            let conn = lock_db(state);
            match db::set_dispatch_globals(&conn, &ws.id, &values.to_string()) {
                Ok(_) => json(StatusCode::OK, &json!({ "values": values })),
                Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "Couldn't save the global variables"),
            }
        }
        _ => error(StatusCode::BAD_REQUEST, NOT_HERE),
    }
}

/// Adds Dispatch entries to a list response from Postman. If Postman failed
/// outright, the stored entries are still shown on their own.
pub async fn with_extra(response: Response, key: &str, extra: Vec<Value>) -> Response {
    if extra.is_empty() {
        return response;
    }
    let status = response.status();
    let (parts, body) = response.into_parts();
    let mut value = if status.is_success() {
        match axum::body::to_bytes(body, usize::MAX).await {
            Ok(bytes) => serde_json::from_slice::<Value>(&bytes).unwrap_or_else(|_| json!({})),
            Err(_) => json!({}),
        }
    } else {
        json!({})
    };
    if !value.is_object() {
        value = json!({});
    }
    let mut list = value.get(key).and_then(Value::as_array).cloned().unwrap_or_default();
    list.extend(extra);
    value[key] = Value::Array(list);
    let mut out = json(StatusCode::OK, &value);
    if status.is_success() {
        if let Some(rate) = parts.headers.get("x-ratelimit-remaining-month") {
            out.headers_mut().insert("x-ratelimit-remaining-month", rate.clone());
        }
    }
    out
}

/// A copy of one Postman workspace, built by the admin import: the documents as
/// Postman returned them. New uids are assigned, so the Postman originals stay
/// separate and keep working.
pub struct Imported {
    pub collections: Vec<Value>,
    pub environments: Vec<Value>,
    pub globals: Value,
}

pub fn store_import(state: &Arc<AppState>, id: &str, name: &str, created_by: &str, import: Imported) -> Result<(), String> {
    let conn = lock_db(state);
    let fail = |e: rusqlite::Error| format!("Couldn't save the copy: {e}");
    conn.execute_batch("BEGIN").map_err(fail)?;
    let result = (|| -> Result<(), String> {
        db::insert_dispatch_workspace(&conn, id, name, Some(created_by)).map_err(fail)?;
        if import.globals.is_array() {
            db::set_dispatch_globals(&conn, id, &import.globals.to_string()).map_err(fail)?;
        }
        for (kind, docs) in [(COLLECTION, &import.collections), (ENVIRONMENT, &import.environments)] {
            for doc in docs {
                let mut wrapper = Map::new();
                wrapper.insert(kind.to_string(), strip_postman_ids(kind, doc.clone()));
                let body = Bytes::from(Value::Object(wrapper).to_string());
                let uid = new_id();
                let now = db::now_iso();
                let (item_name, stored) = document(kind, &body, &uid, &now, &now)
                    .map_err(|_| format!("A {kind} in this workspace has no name"))?;
                let item = DispatchItem {
                    uid,
                    workspace_id: id.to_string(),
                    name: item_name,
                    body: stored.to_string(),
                    created_at: now.clone(),
                    updated_at: now,
                };
                db::insert_dispatch_item(&conn, &item, kind).map_err(fail)?;
            }
        }
        Ok(())
    })();
    match result {
        Ok(()) => conn.execute_batch("COMMIT").map_err(fail),
        Err(message) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(message)
        }
    }
}

/// Drops the fields that tie a document to its Postman original.
fn strip_postman_ids(kind: &str, mut doc: Value) -> Value {
    if let Some(map) = doc.as_object_mut() {
        if kind == COLLECTION {
            if let Some(Value::Object(info)) = map.get_mut("info") {
                for field in ["_postman_id", "uid", "createdAt", "updatedAt", "lastUpdatedBy", "fork", "owner"] {
                    info.remove(field);
                }
            }
        } else {
            for field in ["id", "uid", "owner", "createdAt", "updatedAt"] {
                map.remove(field);
            }
        }
    }
    doc
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_look_like_uuids() {
        let id = new_id();
        assert_eq!(id.len(), 36);
        assert_eq!(&id[14..15], "4");
        assert!("89ab".contains(&id[19..20]));
        assert_ne!(new_id(), id);
    }

    #[test]
    fn collections_get_ids_and_a_stamped_info() {
        let body = Bytes::from(r#"{"collection":{"info":{"name":" Orders "},"item":[{"name":"a","item":[{"name":"b"}]}]}}"#);
        let (name, doc) = document(COLLECTION, &body, "u1", "c", "u").unwrap();
        assert_eq!(name, "Orders");
        assert_eq!(doc["info"]["_postman_id"], "u1");
        assert_eq!(doc["info"]["updatedAt"], "u");
        assert!(doc["item"][0]["id"].is_string());
        assert!(doc["item"][0]["item"][0]["id"].is_string());
        let nameless = Bytes::from(r#"{"collection":{"info":{}}}"#);
        assert!(document(COLLECTION, &nameless, "u1", "c", "u").is_err());
    }
}
