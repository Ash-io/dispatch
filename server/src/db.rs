//! SQLite storage: idempotent migrations plus every query the server needs.
//! The single connection lives behind a std Mutex owned by `AppState`.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

pub struct UserRecord {
    pub id: i64,
    pub email: String,
    pub password_hash: String,
    pub role: String,
    /// Raw JSON text of granted workspace IDs; None = all workspaces.
    pub workspace_grants: Option<String>,
    pub created_at: String,
}

pub struct AccountRow {
    pub id: i64,
    pub label: String,
    pub region: String,
    pub key_ciphertext: String,
    pub key_hint: String,
    pub postman_name: Option<String>,
    pub created_by: Option<String>,
    pub created_at: String,
}

pub struct AuditRow {
    pub ts: String,
    pub user_id: Option<i64>,
    pub email: Option<String>,
    pub action: String,
    pub method: String,
    pub path: String,
    pub status: i64,
}

pub fn open(path: &str) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| format!("Couldn't open {path}: {e}"))?;
    let _ = conn.pragma_update(None, "journal_mode", "WAL"); // best effort; fallback to journal is fine
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|e| format!("Couldn't set the SQLite busy timeout: {e}"))?;
    migrate(&conn).map_err(|e| format!("Couldn't initialize {path}: {e}"))?;
    Ok(conn)
}

/// Migrations are idempotent: CREATE TABLE IF NOT EXISTS at boot, nothing else.
fn migrate(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(r#"
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL UNIQUE COLLATE NOCASE,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL,
            workspace_grants TEXT,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tokens (
            token_hash TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        -- Where each collection/environment uid lives, learned from every
        -- per-workspace list/create/delete that the proxy sees.
        CREATE TABLE IF NOT EXISTS collections_map (
            uid TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            name TEXT,
            updated_at TEXT
        );
        CREATE TABLE IF NOT EXISTS environments_map (
            uid TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            name TEXT,
            updated_at TEXT
        );
        -- Postman accounts an admin connected. key_ciphertext is AES-256-GCM under
        -- SECRET_KEY; the plain key is never stored or returned.
        CREATE TABLE IF NOT EXISTS postman_accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            label TEXT NOT NULL,
            region TEXT NOT NULL,
            key_ciphertext TEXT NOT NULL,
            key_hint TEXT NOT NULL,
            postman_user_id TEXT,
            postman_name TEXT,
            created_by TEXT,
            created_at TEXT NOT NULL
        );
        -- Which accounts reach which workspace, refreshed from Postman's own lists.
        -- account_id 0 is the POSTMAN_API_KEY setting.
        CREATE TABLE IF NOT EXISTS workspace_accounts (
            workspace_id TEXT NOT NULL,
            account_id INTEGER NOT NULL,
            name TEXT,
            type TEXT,
            PRIMARY KEY (workspace_id, account_id)
        );
        -- Workspaces stored on this server instead of in Postman. The desktop app
        -- reaches them through the same Postman-shaped endpoints.
        CREATE TABLE IF NOT EXISTS dispatch_workspaces (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            globals TEXT NOT NULL,
            created_by TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        -- Their collections and environments; body is the full JSON document.
        CREATE TABLE IF NOT EXISTS dispatch_items (
            uid TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            workspace_id TEXT NOT NULL,
            name TEXT NOT NULL,
            body TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS dispatch_items_workspace ON dispatch_items (workspace_id, kind);
        CREATE TABLE IF NOT EXISTS audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts TEXT NOT NULL,
            user_id INTEGER,
            email TEXT,
            action TEXT NOT NULL,
            method TEXT NOT NULL,
            path TEXT NOT NULL,
            status INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO settings (key, value) VALUES ('allow_registration', '1');
    "#)?;
    Ok(())
}

/// RFC 3339 UTC timestamp for the current moment, e.g. "2026-11-03T20:42:07.123Z".
pub fn now_iso() -> String {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    iso_from_millis(now.as_millis() as i64)
}

fn now_millis() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64
}

pub fn iso_from_millis(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let days = secs.div_euclid(86_400);
    let time_of_day = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        time_of_day / 3600,
        (time_of_day % 3600) / 60,
        time_of_day % 60,
        ms.rem_euclid(1000)
    )
}

/// Parses the timestamps now_iso() writes (and JS's toISOString()).
pub fn millis_from_iso(text: &str) -> Option<i64> {
    let b = text.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let num = |from: usize, to: usize| text.get(from..to)?.parse::<i64>().ok();
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, s) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    let ms = if b[19] == b'.' { num(20, 23).unwrap_or(0) } else { 0 };
    Some(((days_from_civil(y, mo, d) * 24 + h) * 60 + mi) * 60_000 + s * 1000 + ms)
}

/// A stamp later than `previous`, so every save of a Dispatch workspace item
/// changes its updatedAt (the desktop app spots conflicts by comparing them).
pub fn stamp_after(previous: Option<&str>) -> String {
    let floor = previous.and_then(millis_from_iso).map_or(i64::MIN, |ms| ms + 1);
    iso_from_millis(now_millis().max(floor))
}

/// (year, month, day) → days since 1970-01-01; Hinnant's days-from-civil.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Days since 1970-01-01 → (year, month, day); Hinnant's civil-from-days.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Grants come back as a JSON array of workspace IDs, or null for "all workspaces".
pub fn parse_grants(raw: Option<&str>) -> Option<Vec<String>> {
    raw.and_then(|text| serde_json::from_str::<Vec<String>>(text).ok())
}

pub fn grants_value(user: &UserRecord) -> Value {
    match parse_grants(user.workspace_grants.as_deref()) {
        Some(list) => json!(list),
        None => Value::Null,
    }
}

const USER_COLS: &str = "id, email, password_hash, role, workspace_grants, created_at";

fn user_from_row(row: &rusqlite::Row) -> rusqlite::Result<UserRecord> {
    Ok(UserRecord {
        id: row.get(0)?,
        email: row.get(1)?,
        password_hash: row.get(2)?,
        role: row.get(3)?,
        workspace_grants: row.get(4)?,
        created_at: row.get(5)?,
    })
}

impl UserRecord {
    fn public(&self) -> Value {
        json!({
            "id": self.id,
            "email": self.email,
            "role": self.role,
            "workspace_grants": grants_value(self),
            "created_at": self.created_at,
        })
    }
}

pub fn user_json(user: &UserRecord) -> Value {
    user.public()
}

pub fn count_users(conn: &Connection) -> Result<i64, rusqlite::Error> {
    conn.query_row("SELECT COUNT(*) FROM users", [], |row| row.get(0))
}

pub fn find_user_by_email(conn: &Connection, email: &str) -> Result<Option<UserRecord>, rusqlite::Error> {
    conn.query_row(
        &format!("SELECT {USER_COLS} FROM users WHERE email = ?1 COLLATE NOCASE"),
        params![email],
        user_from_row,
    )
    .optional()
}

pub fn find_user_by_id(conn: &Connection, id: i64) -> Result<Option<UserRecord>, rusqlite::Error> {
    conn.query_row(
        &format!("SELECT {USER_COLS} FROM users WHERE id = ?1"),
        params![id],
        user_from_row,
    )
    .optional()
}

pub fn insert_user(
    conn: &Connection,
    email: &str,
    password_hash: &str,
    role: &str,
    workspace_grants: Option<&str>,
    created_at: &str,
) -> Result<i64, rusqlite::Error> {
    conn.execute(
        "INSERT INTO users (email, password_hash, role, workspace_grants, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![email, password_hash, role, workspace_grants, created_at],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn list_users(conn: &Connection) -> Result<Vec<UserRecord>, rusqlite::Error> {
    let mut stmt =
        conn.prepare(&format!("SELECT {USER_COLS} FROM users ORDER BY id"))?;
    let rows = stmt
        .query_map([], user_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Applies any subset of role / workspace_grants / password (raw PHC string) to a user;
/// `None` means "leave the field untouched". Returns false when the user doesn't exist.
pub fn update_user(
    conn: &Connection,
    id: i64,
    role: Option<&str>,
    grants: Option<Option<String>>,
    password_hash: Option<&str>,
) -> Result<bool, rusqlite::Error> {
    let mut set: Vec<&'static str> = Vec::new();
    let mut args: Vec<String> = Vec::new();
    if let Some(role) = role {
        set.push("role = ?");
        args.push(role.to_string());
    }
    if let Some(grants) = grants {
        set.push("workspace_grants = ?");
        args.push(grants.unwrap_or_default());
    }
    if let Some(hash) = password_hash {
        set.push("password_hash = ?");
        args.push(hash.to_string());
    }
    if set.is_empty() {
        return find_user_by_id(conn, id).map(|u| u.is_some());
    }
    let sql = format!("UPDATE users SET {} WHERE id = ?", set.join(", "));
    args.push(id.to_string());
    let changed = conn.execute(&sql, rusqlite::params_from_iter(args))?;
    Ok(changed > 0)
}

/// Deletes a user and their tokens; returns false when the user doesn't exist.
pub fn delete_user(conn: &Connection, id: i64) -> Result<bool, rusqlite::Error> {
    let deleted = conn.execute("DELETE FROM users WHERE id = ?1", params![id])?;
    if deleted > 0 {
        conn.execute("DELETE FROM tokens WHERE user_id = ?1", params![id])?;
    }
    Ok(deleted > 0)
}

pub fn insert_token(conn: &Connection, token_hash: &str, user_id: i64) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO tokens (token_hash, user_id, created_at) VALUES (?1, ?2, ?3)",
        params![token_hash, user_id, now_iso()],
    )?;
    Ok(())
}

pub fn delete_token(conn: &Connection, token_hash: &str) -> Result<bool, rusqlite::Error> {
    let n = conn.execute("DELETE FROM tokens WHERE token_hash = ?1", params![token_hash])?;
    Ok(n > 0)
}

/// Dangling tokens (e.g. of a deleted user) are treated as invalid and removed.
pub fn token_user_id(conn: &Connection, token_hash: &str) -> Result<Option<i64>, rusqlite::Error> {
    let user_id: Option<i64> = conn
        .query_row("SELECT user_id FROM tokens WHERE token_hash = ?1", params![token_hash], |r| r.get(0))
        .optional()?;
    if let Some(id) = user_id {
        if id != 0 && find_user_by_id(conn, id)?.is_none() {
            delete_token(conn, token_hash)?;
            return Ok(None);
        }
    }
    Ok(user_id)
}

pub fn get_setting(conn: &Connection, key: &str) -> Result<Option<String>, rusqlite::Error> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", params![key], |r| r.get(0))
        .optional()
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

pub fn allow_registration(conn: &Connection) -> Result<bool, rusqlite::Error> {
    Ok(get_setting(conn, "allow_registration")?
        .map(|v| v == "1")
        .unwrap_or(true))
}

/// Remembers uid → workspace rows from a per-workspace list response (an
/// array) or a create response (a single object). `table` is always one of
/// the two fixed map tables from code, never user input. Best effort: rows
/// that can't be attributed (no uid field) are skipped.
pub fn remember_entries(
    conn: &Connection,
    table: &str,
    workspace_id: &str,
    entries: &Value,
) -> Result<(), rusqlite::Error> {
    let sql = format!(
        "INSERT INTO {table} (uid, workspace_id, name, updated_at) VALUES (?1, ?2, ?3, ?4) \
         ON CONFLICT(uid) DO UPDATE SET workspace_id = excluded.workspace_id, \
         name = excluded.name, updated_at = excluded.updated_at"
    );
    let objects: Vec<&Value> = match entries {
        Value::Array(items) => items.iter().collect(),
        obj if obj.is_object() => vec![entries],
        _ => vec![],
    };
    for entry in objects {
        let uid = entry
            .get("uid")
            .and_then(Value::as_str)
            .or_else(|| entry.get("id").and_then(Value::as_str));
        let Some(uid) = uid else { continue };
        let name = entry.get("name").and_then(Value::as_str);
        let updated = entry.get("updatedAt").and_then(Value::as_str);
        let _ = conn.execute(&sql, params![uid, workspace_id, name, updated]);
    }
    Ok(())
}

/// Forgets a uid's mapping after a successful upstream delete.
pub fn forget_entry(conn: &Connection, table: &str, uid: &str) -> Result<(), rusqlite::Error> {
    conn.execute(&format!("DELETE FROM {table} WHERE uid = ?1"), params![uid])?;
    Ok(())
}

/// The owning workspace of a collection/environment uid, if cached.
pub fn mapped_workspace(conn: &Connection, table: &str, uid: &str) -> Result<Option<String>, rusqlite::Error> {
    conn.query_row(
        &format!("SELECT workspace_id FROM {table} WHERE uid = ?1"),
        params![uid],
        |row| row.get(0),
    )
    .optional()
}

const ACCOUNT_COLS: &str =
    "id, label, region, key_ciphertext, key_hint, postman_name, created_by, created_at";

fn account_from_row(row: &rusqlite::Row) -> rusqlite::Result<AccountRow> {
    Ok(AccountRow {
        id: row.get(0)?,
        label: row.get(1)?,
        region: row.get(2)?,
        key_ciphertext: row.get(3)?,
        key_hint: row.get(4)?,
        postman_name: row.get(5)?,
        created_by: row.get(6)?,
        created_at: row.get(7)?,
    })
}

pub fn list_accounts(conn: &Connection) -> Result<Vec<AccountRow>, rusqlite::Error> {
    let mut stmt = conn.prepare(&format!("SELECT {ACCOUNT_COLS} FROM postman_accounts ORDER BY id"))?;
    let rows = stmt.query_map([], account_from_row)?.collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn find_account(conn: &Connection, id: i64) -> Result<Option<AccountRow>, rusqlite::Error> {
    conn.query_row(
        &format!("SELECT {ACCOUNT_COLS} FROM postman_accounts WHERE id = ?1"),
        params![id],
        account_from_row,
    )
    .optional()
}

pub fn account_label_for_postman_user(conn: &Connection, user_id: &str) -> Result<Option<String>, rusqlite::Error> {
    conn.query_row(
        "SELECT label FROM postman_accounts WHERE postman_user_id = ?1",
        params![user_id],
        |row| row.get(0),
    )
    .optional()
}

#[allow(clippy::too_many_arguments)]
pub fn insert_account(
    conn: &Connection,
    label: &str,
    region: &str,
    key_ciphertext: &str,
    key_hint: &str,
    postman_user_id: Option<&str>,
    postman_name: Option<&str>,
    created_by: Option<&str>,
) -> Result<i64, rusqlite::Error> {
    conn.execute(
        "INSERT INTO postman_accounts (label, region, key_ciphertext, key_hint, postman_user_id, postman_name, created_by, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![label, region, key_ciphertext, key_hint, postman_user_id, postman_name, created_by, now_iso()],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn set_account_label(conn: &Connection, id: i64, label: &str) -> Result<(), rusqlite::Error> {
    conn.execute("UPDATE postman_accounts SET label = ?1 WHERE id = ?2", params![label, id])?;
    Ok(())
}

pub fn set_account_key(
    conn: &Connection,
    id: i64,
    key_ciphertext: &str,
    key_hint: &str,
    postman_user_id: Option<&str>,
    postman_name: Option<&str>,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE postman_accounts SET key_ciphertext = ?1, key_hint = ?2, \
         postman_user_id = COALESCE(?3, postman_user_id), postman_name = COALESCE(?4, postman_name) WHERE id = ?5",
        params![key_ciphertext, key_hint, postman_user_id, postman_name, id],
    )?;
    Ok(())
}

pub fn delete_account(conn: &Connection, id: i64) -> Result<bool, rusqlite::Error> {
    let deleted = conn.execute("DELETE FROM postman_accounts WHERE id = ?1", params![id])?;
    conn.execute("DELETE FROM workspace_accounts WHERE account_id = ?1", params![id])?;
    Ok(deleted > 0)
}

/// Replaces what's remembered about one account's workspaces: (id, name, type).
pub fn replace_workspace_accounts(
    conn: &Connection,
    account_id: i64,
    workspaces: &[(String, String, String)],
) -> Result<(), rusqlite::Error> {
    conn.execute("DELETE FROM workspace_accounts WHERE account_id = ?1", params![account_id])?;
    for (id, name, kind) in workspaces {
        conn.execute(
            "INSERT OR REPLACE INTO workspace_accounts (workspace_id, account_id, name, type) VALUES (?1, ?2, ?3, ?4)",
            params![id, account_id, name, kind],
        )?;
    }
    Ok(())
}

pub fn workspace_account_ids(conn: &Connection, workspace_id: &str) -> Result<Vec<i64>, rusqlite::Error> {
    let mut stmt = conn.prepare("SELECT account_id FROM workspace_accounts WHERE workspace_id = ?1")?;
    let rows = stmt
        .query_map(params![workspace_id], |row| row.get(0))?
        .collect::<Result<Vec<i64>, _>>()?;
    Ok(rows)
}

pub fn workspace_count(conn: &Connection, account_id: i64) -> Result<i64, rusqlite::Error> {
    conn.query_row(
        "SELECT COUNT(*) FROM workspace_accounts WHERE account_id = ?1",
        params![account_id],
        |row| row.get(0),
    )
}

// ---------- Dispatch workspaces (stored on this server) ----------------------

pub struct DispatchWorkspace {
    pub id: String,
    pub name: String,
    pub globals: String,
    pub created_by: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

pub struct DispatchItem {
    pub uid: String,
    pub workspace_id: String,
    pub name: String,
    pub body: String,
    pub created_at: String,
    pub updated_at: String,
}

const DW_COLS: &str = "id, name, globals, created_by, created_at, updated_at";

fn dw_from_row(row: &rusqlite::Row) -> rusqlite::Result<DispatchWorkspace> {
    Ok(DispatchWorkspace {
        id: row.get(0)?,
        name: row.get(1)?,
        globals: row.get(2)?,
        created_by: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

pub fn dispatch_workspaces(conn: &Connection) -> Result<Vec<DispatchWorkspace>, rusqlite::Error> {
    let mut stmt = conn.prepare(&format!("SELECT {DW_COLS} FROM dispatch_workspaces ORDER BY name COLLATE NOCASE, id"))?;
    let rows = stmt.query_map([], dw_from_row)?.collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn dispatch_workspace(conn: &Connection, id: &str) -> Result<Option<DispatchWorkspace>, rusqlite::Error> {
    conn.query_row(&format!("SELECT {DW_COLS} FROM dispatch_workspaces WHERE id = ?1"), params![id], dw_from_row)
        .optional()
}

pub fn insert_dispatch_workspace(conn: &Connection, id: &str, name: &str, created_by: Option<&str>) -> Result<(), rusqlite::Error> {
    let now = now_iso();
    conn.execute(
        "INSERT INTO dispatch_workspaces (id, name, globals, created_by, created_at, updated_at) VALUES (?1, ?2, '[]', ?3, ?4, ?4)",
        params![id, name, created_by, now],
    )?;
    Ok(())
}

pub fn rename_dispatch_workspace(conn: &Connection, id: &str, name: &str) -> Result<bool, rusqlite::Error> {
    Ok(conn.execute(
        "UPDATE dispatch_workspaces SET name = ?1, updated_at = ?2 WHERE id = ?3",
        params![name, now_iso(), id],
    )? > 0)
}

pub fn set_dispatch_globals(conn: &Connection, id: &str, globals: &str) -> Result<bool, rusqlite::Error> {
    Ok(conn.execute(
        "UPDATE dispatch_workspaces SET globals = ?1, updated_at = ?2 WHERE id = ?3",
        params![globals, now_iso(), id],
    )? > 0)
}

/// Removes a workspace with everything in it.
pub fn delete_dispatch_workspace(conn: &Connection, id: &str) -> Result<bool, rusqlite::Error> {
    conn.execute("DELETE FROM dispatch_items WHERE workspace_id = ?1", params![id])?;
    Ok(conn.execute("DELETE FROM dispatch_workspaces WHERE id = ?1", params![id])? > 0)
}

const DI_COLS: &str = "uid, workspace_id, name, body, created_at, updated_at";

fn di_from_row(row: &rusqlite::Row) -> rusqlite::Result<DispatchItem> {
    Ok(DispatchItem {
        uid: row.get(0)?,
        workspace_id: row.get(1)?,
        name: row.get(2)?,
        body: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

/// A workspace's collections or environments, without their bodies.
pub fn dispatch_items(conn: &Connection, workspace_id: &str, kind: &str) -> Result<Vec<DispatchItem>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT uid, workspace_id, name, '', created_at, updated_at FROM dispatch_items \
         WHERE workspace_id = ?1 AND kind = ?2 ORDER BY name COLLATE NOCASE, uid",
    )?;
    let rows = stmt.query_map(params![workspace_id, kind], di_from_row)?.collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn dispatch_item(conn: &Connection, uid: &str, kind: &str) -> Result<Option<DispatchItem>, rusqlite::Error> {
    conn.query_row(
        &format!("SELECT {DI_COLS} FROM dispatch_items WHERE uid = ?1 AND kind = ?2"),
        params![uid, kind],
        di_from_row,
    )
    .optional()
}

pub fn insert_dispatch_item(conn: &Connection, item: &DispatchItem, kind: &str) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO dispatch_items (uid, kind, workspace_id, name, body, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![item.uid, kind, item.workspace_id, item.name, item.body, item.created_at, item.updated_at],
    )?;
    Ok(())
}

pub fn update_dispatch_item(conn: &Connection, uid: &str, name: &str, body: &str, updated_at: &str) -> Result<bool, rusqlite::Error> {
    Ok(conn.execute(
        "UPDATE dispatch_items SET name = ?1, body = ?2, updated_at = ?3 WHERE uid = ?4",
        params![name, body, updated_at, uid],
    )? > 0)
}

pub fn delete_dispatch_item(conn: &Connection, uid: &str) -> Result<bool, rusqlite::Error> {
    Ok(conn.execute("DELETE FROM dispatch_items WHERE uid = ?1", params![uid])? > 0)
}

pub fn dispatch_item_count(conn: &Connection, workspace_id: &str, kind: &str) -> Result<i64, rusqlite::Error> {
    conn.query_row(
        "SELECT COUNT(*) FROM dispatch_items WHERE workspace_id = ?1 AND kind = ?2",
        params![workspace_id, kind],
        |row| row.get(0),
    )
}

pub fn audit_insert(
    conn: &Connection,
    ts: &str,
    user_id: Option<i64>,
    email: Option<&str>,
    action: &str,
    method: &str,
    path: &str,
    status: i64,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO audit (ts, user_id, email, action, method, path, status) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![ts, user_id, email, action, method, path, status],
    )?;
    Ok(())
}

/// Newest first, limited.
pub fn audit_list(conn: &Connection, limit: i64) -> Result<Vec<AuditRow>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT ts, user_id, email, action, method, path, status FROM audit \
         ORDER BY id DESC LIMIT ?1",
    )?;
    let rows = stmt
        .query_map(params![limit], |row| {
            Ok(AuditRow {
                ts: row.get(0)?,
                user_id: row.get(1)?,
                email: row.get(2)?,
                action: row.get(3)?,
                method: row.get(4)?,
                path: row.get(5)?,
                status: row.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn audit_json(rows: &[AuditRow]) -> Value {
    Value::Array(
        rows.iter()
            .map(|r| {
                json!({
                    "ts": r.ts,
                    "user_id": r.user_id,
                    "email": r.email,
                    "action": r.action,
                    "method": r.method,
                    "path": r.path,
                    "status": r.status,
                })
            })
            .collect(),
    )
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps_round_trip() {
        for ms in [0_i64, 1_699_999_999_123, 1_762_560_000_000, 951_782_400_999] {
            let text = iso_from_millis(ms);
            assert_eq!(millis_from_iso(&text), Some(ms), "{text}");
        }
        assert_eq!(iso_from_millis(1_762_560_000_005), "2025-11-08T00:00:00.005Z");
        assert_eq!(millis_from_iso("2025-11-08T00:00:00Z"), Some(1_762_560_000_000));
        assert_eq!(millis_from_iso("yesterday"), None);
    }

    #[test]
    fn stamps_always_move_forward() {
        let future = iso_from_millis(now_millis() + 60_000);
        let next = stamp_after(Some(&future));
        assert_eq!(millis_from_iso(&next), millis_from_iso(&future).map(|ms| ms + 1));
        assert!(stamp_after(None) <= stamp_after(None));
    }

    #[test]
    fn dispatch_items_store_and_list() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        insert_dispatch_workspace(&conn, "w", "Team", None).unwrap();
        let item = DispatchItem {
            uid: "u".into(),
            workspace_id: "w".into(),
            name: "Orders".into(),
            body: "{}".into(),
            created_at: now_iso(),
            updated_at: now_iso(),
        };
        insert_dispatch_item(&conn, &item, "collection").unwrap();
        assert_eq!(dispatch_items(&conn, "w", "collection").unwrap().len(), 1);
        assert!(dispatch_items(&conn, "w", "environment").unwrap().is_empty());
        assert!(dispatch_item(&conn, "u", "environment").unwrap().is_none());
        assert!(delete_dispatch_workspace(&conn, "w").unwrap());
        assert!(dispatch_item(&conn, "u", "collection").unwrap().is_none());
    }
}
