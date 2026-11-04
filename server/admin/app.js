/* Dispatch admin panel — vanilla JS, no build step, no dependencies. */
(() => {
  "use strict";

  const TOKEN_KEY = "dispatch_admin_token";
  const ROLES = ["viewer", "editor", "creator", "admin"];
  const AUDIT_LIMIT = 500;

  const $ = (id) => document.getElementById(id);

  const els = {
    loginView: $("view-login"),
    appView: $("view-app"),
    loginForm: $("login-form"),
    loginEmail: $("login-email"),
    loginPassword: $("login-password"),
    loginPasswordLabel: $("login-password-label"),
    loginError: $("login-error"),
    loginSubmit: $("login-submit"),
    loginSub: $("login-sub"),
    modeToggle: $("mode-toggle"),
    registerToggle: $("register-toggle"),
    logoutBtn: $("logout-btn"),
    meEmail: $("me-email"),
    meAvatar: $("me-avatar"),
    tabs: Array.from(document.querySelectorAll(".tab")),
    panels: { users: $("tab-users"), settings: $("tab-settings"), audit: $("tab-audit") },
    addForm: $("add-user-form"),
    newEmail: $("new-email"),
    newPassword: $("new-password"),
    newRole: $("new-role"),
    addOpen: $("add-user-open"),
    addCancel: $("add-user-cancel"),
    addError: $("add-user-error"),
    addUserSubmit: $("add-user-submit"),
    usersRefresh: $("users-refresh"),
    usersSearch: $("users-search"),
    usersCount: $("users-count"),
    usersBody: $("users-body"),
    regNotice: $("reg-notice"),
    regClose: $("reg-close"),
    keyNotice: $("key-notice"),
    settingsToggle: $("allow-registration"),
    auditRefresh: $("audit-refresh"),
    auditSearch: $("audit-search"),
    auditStatus: $("audit-status"),
    auditFoot: $("audit-foot"),
    auditBody: $("audit-body"),
    dialog: $("dialog"),
    dialogForm: $("dialog-form"),
    dialogTitle: $("dialog-title"),
    dialogBody: $("dialog-body"),
    dialogError: $("dialog-error"),
    dialogCancel: $("dialog-cancel"),
    dialogOk: $("dialog-ok"),
    toast: $("toast"),
  };

  let me = null;
  let loginMode = "credentials";
  let toastTimer = null;
  let allUsers = [];
  let allAudit = [];
  let workspaces = null; // [{ id, name }] once listed; null if Postman can't be reached

  /* ---- session storage ---- */

  const getToken = () => localStorage.getItem(TOKEN_KEY);
  const setToken = (token) => localStorage.setItem(TOKEN_KEY, token);
  const clearToken = () => localStorage.removeItem(TOKEN_KEY);

  /* ---- fetch wrapper ---- */

  async function api(path, options) {
    const opts = options || {};
    const headers = { Accept: "application/json" };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    const token = getToken();
    if (token) headers.Authorization = "Bearer " + token;

    let response;
    try {
      response = await fetch(path, {
        method: opts.method || "GET",
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch (err) {
      return { ok: false, status: 0, error: "Network error: could not reach the server." };
    }

    let data = null;
    const text = await response.text();
    if (text) {
      try { data = JSON.parse(text); } catch (err) { data = null; }
    }

    if (!response.ok) {
      const message = data && typeof data === "object" && data.error
        ? String(data.error)
        : "Request failed with status " + response.status + ".";
      if (response.status === 401) {
        clearToken();
        showLogin();
      }
      return { ok: false, status: response.status, error: message };
    }
    return { ok: true, status: response.status, data };
  }

  /* ---- small DOM helpers ---- */

  function el(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined && content !== null) node.textContent = String(content);
    return node;
  }

  function labeledCell(label, className, content) {
    const cell = el("td", className, content);
    cell.setAttribute("data-label", label);
    return cell;
  }

  function statusRow(body, colSpan, text) {
    body.textContent = "";
    const row = el("tr");
    const cell = el("td", "empty-cell", text);
    cell.colSpan = colSpan;
    row.appendChild(cell);
    body.appendChild(row);
  }

  function skeletonRows(body, colSpan) {
    if (body.querySelector("tr:not(.skeleton)") && body.children.length) return; // keep rows on refresh
    body.textContent = "";
    for (let i = 0; i < 3; i += 1) {
      const row = el("tr", "skeleton");
      const cell = el("td");
      cell.colSpan = colSpan;
      cell.appendChild(el("span", "skeleton-bar"));
      row.appendChild(cell);
      body.appendChild(row);
    }
  }

  /* ---- dialog ---- */

  // Native <dialog> brings focus trapping and Esc. `onSubmit` returns an error
  // string to keep the dialog open, or anything else to close and resolve with it.
  let dialogSubmit = null;
  let dialogDone = null;

  function openDialog({ title, body, okLabel, danger, onSubmit }) {
    els.dialogTitle.textContent = title;
    els.dialogBody.textContent = "";
    for (const node of body) els.dialogBody.appendChild(node);
    els.dialogError.hidden = true;
    els.dialogOk.textContent = okLabel;
    els.dialogOk.className = "btn " + (danger ? "danger-solid" : "primary");
    els.dialogOk.disabled = false;
    els.dialog.showModal();
    const focus = els.dialogBody.querySelector("input");
    if (focus) focus.focus();
    return new Promise((resolve) => {
      dialogSubmit = onSubmit;
      dialogDone = resolve;
    });
  }

  function closeDialog(value) {
    const done = dialogDone;
    dialogDone = null;
    dialogSubmit = null;
    if (els.dialog.open) els.dialog.close();
    if (done) done(value);
  }

  els.dialogForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!dialogSubmit) return;
    els.dialogOk.disabled = true;
    els.dialogError.hidden = true;
    const outcome = await dialogSubmit();
    els.dialogOk.disabled = false;
    if (outcome && outcome.error) {
      els.dialogError.textContent = outcome.error;
      els.dialogError.hidden = false;
      return;
    }
    closeDialog(true);
  });
  els.dialogCancel.addEventListener("click", () => closeDialog(null));
  els.dialog.addEventListener("cancel", () => closeDialog(null));

  /* ---- toast ---- */

  function toast(message, kind) {
    els.toast.textContent = message;
    els.toast.className = "toast " + (kind === "error" ? "error" : "ok") + " show";
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => els.toast.classList.remove("show"), kind === "error" ? 5000 : 2800);
  }

  const toastErr = (message) => toast(message, "error");
  const toastOk = (message) => toast(message, "ok");

  function fail(result) {
    toastErr(result && result.error ? result.error : "Request failed.");
  }

  /* ---- formatting ---- */

  function fmtTime(value) {
    if (value === null || value === undefined || value === "") return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString(undefined, {
      year: "numeric", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  }

  const fmtDate = (value) => {
    const date = new Date(value);
    if (value === null || value === undefined || Number.isNaN(date.getTime())) return fmtTime(value);
    return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  };

  const fmtStamp = (value) => {
    const date = new Date(value);
    if (value === null || value === undefined || Number.isNaN(date.getTime())) return fmtTime(value);
    return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  };

  function grantsText(grants) {
    if (grants === null || grants === undefined) return "All workspaces";
    if (!grants.length) return "No workspaces";
    const names = grants.map((id) => {
      const known = workspaces && workspaces.find((w) => w.id === id);
      return known ? known.name : id;
    });
    return names.length <= 2 ? names.join(", ") : names.length + " workspaces";
  }

  function statusClass(status) {
    const n = Number(status);
    if (!Number.isFinite(n)) return "";
    if (n >= 500) return "bad";
    if (n >= 400) return "warn";
    if (n >= 200 && n < 400) return "ok";
    return "";
  }

  /* ---- view switching ---- */

  function showInlineLoginError(message) {
    els.loginError.textContent = message;
    els.loginError.hidden = false;
  }

  function showLogin(message) {
    const wasInApp = !els.appView.hidden;
    me = null;
    els.appView.hidden = true;
    els.loginView.hidden = false;
    if (els.dialog.open) closeDialog(null);
    els.usersBody.textContent = "";
    els.auditBody.textContent = "";
    if (message !== undefined) showInlineLoginError(message);
    if (wasInApp) {
      els.loginPassword.value = "";
      try { els.loginEmail.focus(); } catch (err) { /* ignore */ }
    }
  }

  function showApp() {
    els.loginView.hidden = true;
    els.appView.hidden = false;
  }

  function switchTab(name) {
    if (!els.panels[name]) return;
    for (const tab of els.tabs) {
      const active = tab.dataset.tab === name;
      tab.classList.toggle("active", active);
      if (active) tab.setAttribute("aria-current", "page"); else tab.removeAttribute("aria-current");
    }
    if (location.hash.slice(1) !== name) history.replaceState(null, "", "#" + name);
    for (const key of Object.keys(els.panels)) els.panels[key].hidden = key !== name;
    if (name === "users") loadUsers();
    else if (name === "settings") loadSettings();
    else if (name === "audit") loadAudit();
  }

  for (const tab of els.tabs) {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  }

  /* ---- session flow ---- */

  // Every admin page load funnels through GET /me; admin API calls are only
  // made when /me reports role "admin".
  async function enterApp() {
    if (!getToken()) { showLogin(); return false; }
    const result = await api("/me");
    if (!result.ok) {
      if (result.status !== 401) { showLogin(); fail(result); }
      return false; // 401 was already routed to the login view by the wrapper
    }
    const user = result.data && result.data.user ? result.data.user : null;
    if (!user || user.role !== "admin") {
      clearToken();
      showLogin(user && user.id !== undefined
        ? "This account isn't an admin. Only the first account on a server is an admin automatically, so ask an admin to change your role."
        : "Sign-in failed.");
      return false;
    }
    me = user;
    els.meEmail.textContent = user.email || "Server admin";
    els.meEmail.title = user.email || "";
    els.meAvatar.textContent = (user.email || "A").charAt(0).toUpperCase();
    showApp();
    const start = location.hash.slice(1);
    switchTab(els.panels[start] ? start : "users");
    loadWorkspaces();
    refreshRegistration();
    return true;
  }

  els.loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    els.loginError.hidden = true;
    els.loginError.textContent = "";
    const email = els.loginEmail.value.trim();
    const password = els.loginPassword.value;
    if (loginMode !== "admin" && (!email || !password)) {
      showInlineLoginError("Enter your email and password.");
      return;
    }
    if (loginMode === "admin" && !password) {
      showInlineLoginError("Enter the server admin password.");
      return;
    }
    els.loginSubmit.disabled = true;
    if (loginMode === "register") {
      const created = await api("/auth/register", { method: "POST", body: { email, password } });
      if (!created.ok) {
        els.loginSubmit.disabled = false;
        showInlineLoginError(created.status === 403
          ? "Registration is closed on this server. Ask an admin to add you."
          : created.error);
        return;
      }
    }
    const result = loginMode === "admin"
      ? await api("/auth/admin-login", { method: "POST", body: { password } })
      : await api("/auth/login", { method: "POST", body: { email, password } });
    els.loginSubmit.disabled = false;
    if (!result.ok) {
      showInlineLoginError(result.status === 403
        ? result.error + " This server may use a shared admin password instead."
        : result.error || "Sign-in failed.");
      return;
    }
    const token = result.data && result.data.token;
    if (!token) { showInlineLoginError("Sign-in did not return a token."); return; }
    setToken(token);
    setLoginMode("credentials");
    await enterApp();
  });

  function setLoginMode(mode) {
    loginMode = mode;
    const copy = {
      credentials: ["Sign in to manage users and review activity.", "Password", "Sign in", "current-password"],
      register: ["The first account on a new server becomes its admin. Create yours before anyone else can.", "Password", "Create account", "new-password"],
      admin: ["Sign in with the password set in ADMIN_PASSWORD.", "Admin password", "Sign in", "current-password"],
    }[mode];
    els.loginForm.dataset.mode = mode === "admin" ? "admin" : "credentials";
    els.loginSub.textContent = copy[0];
    els.loginPasswordLabel.textContent = copy[1];
    els.loginSubmit.textContent = copy[2];
    els.loginPassword.autocomplete = copy[3];
    els.loginPassword.placeholder = mode === "register" ? "At least 8 characters" : "";
    els.registerToggle.textContent = mode === "register" ? "Already have an account? Sign in" : "New server? Create the first account";
    els.registerToggle.hidden = mode === "admin";
    els.modeToggle.textContent = mode === "admin" ? "Use email and password instead" : "Use server admin password instead";
    els.modeToggle.hidden = mode === "register";
    els.loginError.hidden = true;
    els.loginError.textContent = "";
    try { (mode === "admin" ? els.loginPassword : els.loginEmail).focus(); } catch (err) { /* ignore */ }
  }

  els.modeToggle.addEventListener("click", () => setLoginMode(loginMode === "admin" ? "credentials" : "admin"));
  els.registerToggle.addEventListener("click", () => setLoginMode(loginMode === "register" ? "credentials" : "register"));

  els.logoutBtn.addEventListener("click", () => {
    // Best-effort revoke on the server (needs the Bearer header, so fire it
    // before dropping the token); outcome is irrelevant for the local logout.
    if (getToken()) { api("/auth/logout", { method: "POST" }); }
    clearToken();
    showLogin();
  });

  /* ---- workspaces ---- */

  // Names for the access picker. A 503 means the server has no Postman key.
  async function loadWorkspaces() {
    const result = await api("/workspaces");
    els.keyNotice.hidden = result.status !== 503;
    if (!result.ok || !result.data || !Array.isArray(result.data.workspaces)) { workspaces = null; return; }
    workspaces = result.data.workspaces.map((w) => ({ id: w.id, name: w.name || w.id }));
    renderUsers();
  }

  /* ---- users ---- */

  async function loadUsers() {
    skeletonRows(els.usersBody, 5);
    const result = await api("/admin/users");
    if (!result.ok) {
      if (result.status !== 401) { statusRow(els.usersBody, 5, "Couldn't load users."); fail(result); }
      return;
    }
    if (!Array.isArray(result.data)) { toastErr("Unexpected response from GET /admin/users."); return; }
    allUsers = result.data;
    els.usersCount.textContent = String(allUsers.length);
    renderUsers();
  }

  function renderUsers() {
    els.usersBody.textContent = "";
    const query = els.usersSearch.value.trim().toLowerCase();
    const users = allUsers.filter((u) => !query || String(u.email || "").toLowerCase().includes(query));
    if (!users.length) {
      statusRow(els.usersBody, 5, query ? "No users match that search." : "No users yet. Add the first one with Add user.");
      return;
    }
    for (const user of users) els.usersBody.appendChild(userRow(user));
  }

  els.usersSearch.addEventListener("input", renderUsers);

  function accessDialog(user) {
    const target = user.email || String(user.id);
    const grants = user.workspace_grants;
    const row = (input, text) => {
      const label = el("label", "check-row");
      label.appendChild(input);
      label.appendChild(el("span", null, text));
      return label;
    };
    const radio = (checked) => {
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "access";
      input.checked = checked;
      return input;
    };
    const all = radio(grants === null || grants === undefined);
    const some = radio(!all.checked);
    const list = el("div", "access-list");
    const boxes = [];
    let idsInput = null;
    if (workspaces && workspaces.length) {
      const known = workspaces.slice();
      for (const id of grants || []) if (!known.some((w) => w.id === id)) known.push({ id, name: id });
      for (const w of known) {
        const box = document.createElement("input");
        box.type = "checkbox";
        box.value = w.id;
        box.checked = (grants || []).includes(w.id);
        box.addEventListener("change", () => { some.checked = true; });
        boxes.push(box);
        list.appendChild(row(box, w.name));
      }
    } else {
      const field = el("div", "field");
      const label = el("label", null, "Workspace IDs, separated by commas");
      label.htmlFor = "access-ids";
      idsInput = document.createElement("input");
      idsInput.type = "text";
      idsInput.id = "access-ids";
      idsInput.spellcheck = false;
      idsInput.value = (grants || []).join(", ");
      idsInput.addEventListener("input", () => { some.checked = true; });
      field.appendChild(label);
      field.appendChild(idsInput);
      list.appendChild(field);
    }
    return openDialog({
      title: "Workspace access for " + target,
      okLabel: "Save",
      body: [row(all, "All workspaces"), row(some, "Only selected workspaces"), list],
      onSubmit: async () => {
        let next = null;
        if (some.checked) {
          next = idsInput
            ? idsInput.value.split(",").map((part) => part.trim()).filter(Boolean)
            : boxes.filter((b) => b.checked).map((b) => b.value);
          if (!next.length) return { error: "Choose at least one workspace, or give this user all workspaces." };
        }
        const result = await api("/admin/users/" + encodeURIComponent(user.id), { method: "PATCH", body: { workspace_grants: next } });
        if (!result.ok) return { error: result.error };
        user.workspace_grants = next;
        renderUsers();
        toastOk("Workspace access updated for " + target + ".");
        return null;
      },
    });
  }

  function passwordDialog(user) {
    const target = user.email || String(user.id);
    const field = el("div", "field");
    const label = el("label", null, "New password");
    label.htmlFor = "reset-password";
    const input = document.createElement("input");
    input.type = "password";
    input.id = "reset-password";
    input.autocomplete = "new-password";
    input.placeholder = "At least 8 characters";
    field.appendChild(label);
    field.appendChild(input);
    return openDialog({
      title: "Reset password for " + target,
      okLabel: "Reset password",
      body: [field],
      onSubmit: async () => {
        const password = input.value;
        if ([...password].length < 8) return { error: "Password must be at least 8 characters." };
        const result = await api("/admin/users/" + encodeURIComponent(user.id), { method: "PATCH", body: { password } });
        if (!result.ok) return { error: result.error };
        toastOk("Password updated for " + target + ".");
        return null;
      },
    });
  }

  function deleteDialog(user) {
    const target = user.email || String(user.id);
    return openDialog({
      title: "Delete " + target + "?",
      okLabel: "Delete user",
      danger: true,
      body: [el("p", "dialog-text muted", "They'll lose access immediately. This can't be undone.")],
      onSubmit: async () => {
        const result = await api("/admin/users/" + encodeURIComponent(user.id), { method: "DELETE" });
        if (!result.ok) return { error: result.error };
        toastOk("Deleted " + target + ".");
        loadUsers();
        return null;
      },
    });
  }

  function userRow(user) {
    const row = el("tr");
    const id = String(user.id);
    const isSelf = me !== null && String(me.id) === id;

    const emailCell = labeledCell("Email", "u-email");
    const emailMain = el("span", "u-email-main");
    emailMain.appendChild(el("span", null, user.email || id));
    if (isSelf) emailMain.appendChild(el("span", "you-badge", "You"));
    emailCell.appendChild(emailMain);

    const roleCell = labeledCell("Role", "u-role");
    const roleSelect = document.createElement("select");
    roleSelect.setAttribute("aria-label", "Role for " + (user.email || id));
    for (const role of ROLES) {
      const option = el("option", null, role.charAt(0).toUpperCase() + role.slice(1));
      option.value = role;
      roleSelect.appendChild(option);
    }
    roleSelect.value = typeof user.role === "string" ? user.role : "viewer";
    // The server allows it, but demoting yourself locks you out of this panel.
    roleSelect.disabled = isSelf;
    if (isSelf) roleSelect.title = "You can't change your own role.";
    roleSelect.addEventListener("change", async () => {
      const next = roleSelect.value;
      roleSelect.disabled = true;
      const result = await api("/admin/users/" + encodeURIComponent(id), { method: "PATCH", body: { role: next } });
      roleSelect.disabled = false;
      if (!result.ok) {
        roleSelect.value = typeof user.role === "string" ? user.role : "viewer";
        fail(result);
        return;
      }
      user.role = next;
      toastOk((user.email || id) + " is now " + next + ".");
    });
    roleCell.appendChild(roleSelect);

    const grantsCell = labeledCell("Workspace access", "u-grants");
    const isAdmin = user.role === "admin";
    const grantsBtn = el("button", "access-btn", isAdmin ? "All workspaces" : grantsText(user.workspace_grants));
    grantsBtn.type = "button";
    grantsBtn.disabled = isAdmin;
    if (isAdmin) grantsBtn.title = "Admins can always access every workspace.";
    grantsBtn.addEventListener("click", () => accessDialog(user));
    grantsCell.appendChild(grantsBtn);

    const createdCell = labeledCell("Created", "u-created muted", fmtDate(user.created_at));
    createdCell.title = fmtTime(user.created_at);

    const actionsCell = labeledCell("Actions", "u-actions");
    const actionsRow = el("div", "action-row");

    const resetBtn = el("button", "btn sm", "Reset password");
    resetBtn.type = "button";
    resetBtn.addEventListener("click", () => passwordDialog(user));

    const deleteBtn = el("button", "btn sm danger-ghost", "Delete");
    deleteBtn.type = "button";
    deleteBtn.disabled = isSelf;
    if (isSelf) deleteBtn.title = "You can't delete your own account.";
    deleteBtn.addEventListener("click", () => deleteDialog(user));

    actionsRow.appendChild(resetBtn);
    actionsRow.appendChild(deleteBtn);
    actionsCell.appendChild(actionsRow);

    row.appendChild(emailCell);
    row.appendChild(roleCell);
    row.appendChild(grantsCell);
    row.appendChild(createdCell);
    row.appendChild(actionsCell);
    return row;
  }

  function showAddForm(open) {
    els.addForm.hidden = !open;
    els.addOpen.hidden = open;
    els.addError.hidden = true;
    if (open) els.newEmail.focus();
  }

  els.addOpen.addEventListener("click", () => showAddForm(true));
  els.addCancel.addEventListener("click", () => showAddForm(false));

  els.addForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = els.newEmail.value.trim();
    const password = els.newPassword.value;
    const inlineError = (message) => { els.addError.textContent = message; els.addError.hidden = false; };
    if (!email || !password) { inlineError("Enter an email and a password."); return; }
    els.addError.hidden = true;
    els.addUserSubmit.disabled = true;
    const result = await api("/admin/users", { method: "POST", body: { email, password, role: els.newRole.value } });
    els.addUserSubmit.disabled = false;
    if (!result.ok) { inlineError(result.error); return; }
    els.newEmail.value = "";
    els.newPassword.value = "";
    els.newRole.value = "viewer";
    showAddForm(false);
    toastOk("User " + email + " created.");
    loadUsers();
  });

  els.usersRefresh.addEventListener("click", () => { loadUsers(); loadWorkspaces(); });

  /* ---- settings ---- */

  function showRegistration(open) {
    els.settingsToggle.checked = open;
    els.regNotice.hidden = !open;
  }

  async function refreshRegistration() {
    const result = await api("/admin/settings");
    if (result.ok) showRegistration(Boolean(result.data && result.data.allow_registration));
  }

  async function loadSettings() {
    els.settingsToggle.disabled = true;
    const result = await api("/admin/settings");
    els.settingsToggle.disabled = false;
    if (!result.ok) {
      if (result.status !== 401) fail(result);
      return;
    }
    showRegistration(Boolean(result.data && result.data.allow_registration));
  }

  async function setRegistration(desired) {
    els.settingsToggle.disabled = true;
    els.regClose.disabled = true;
    const result = await api("/admin/settings", { method: "PATCH", body: { allow_registration: desired } });
    els.settingsToggle.disabled = false;
    els.regClose.disabled = false;
    if (!result.ok) {
      showRegistration(!desired);
      fail(result);
      return;
    }
    showRegistration(desired);
    toastOk(desired ? "Registration is open." : "Registration is off.");
  }

  els.settingsToggle.addEventListener("change", () => setRegistration(els.settingsToggle.checked));
  els.regClose.addEventListener("click", () => setRegistration(false));

  /* ---- audit ---- */

  async function loadAudit() {
    skeletonRows(els.auditBody, 5);
    const result = await api("/admin/audit?limit=" + AUDIT_LIMIT);
    if (!result.ok) {
      if (result.status !== 401) { statusRow(els.auditBody, 5, "Couldn't load the audit log."); fail(result); }
      return;
    }
    if (!Array.isArray(result.data)) { toastErr("Unexpected response from GET /admin/audit."); return; }
    allAudit = result.data;
    renderAudit();
  }

  function auditUser(entry) {
    if (entry.email) return entry.email;
    return entry.user_id !== null && entry.user_id !== undefined ? "#" + entry.user_id : "—";
  }

  function renderAudit() {
    els.auditBody.textContent = "";
    const query = els.auditSearch.value.trim().toLowerCase();
    const failedOnly = els.auditStatus.value === "failed";
    const entries = allAudit.filter((entry) => {
      if (failedOnly && !(Number(entry.status) >= 400)) return false;
      if (!query) return true;
      return [auditUser(entry), entry.action, entry.method, entry.path].join(" ").toLowerCase().includes(query);
    });
    els.auditFoot.textContent = allAudit.length >= AUDIT_LIMIT ? "Showing the latest " + AUDIT_LIMIT + " entries." : "";
    if (!entries.length) {
      statusRow(els.auditBody, 5, allAudit.length ? "Nothing matches that filter." : "No activity yet. Requests made through this server appear here.");
      return;
    }
    for (const entry of entries) {
      const row = el("tr");
      const timeCell = labeledCell("Time", "a-time", fmtStamp(entry.ts));
      timeCell.title = fmtTime(entry.ts);
      row.appendChild(timeCell);
      row.appendChild(labeledCell("User", "a-user", auditUser(entry)));
      row.appendChild(labeledCell("Action", "a-action mono", entry.action || "—"));
      const request = ((entry.method || "?") + " " + (entry.path || "")).trim();
      row.appendChild(labeledCell("Request", "a-request mono", request));
      const statusCell = labeledCell("Status", "a-status");
      const badge = el("span", "status " + statusClass(entry.status),
        entry.status === null || entry.status === undefined ? "—" : String(entry.status));
      statusCell.appendChild(badge);
      row.appendChild(statusCell);
      els.auditBody.appendChild(row);
    }
  }

  els.auditSearch.addEventListener("input", renderAudit);
  els.auditStatus.addEventListener("change", renderAudit);
  els.auditRefresh.addEventListener("click", () => loadAudit());

  /* ---- boot ---- */

  (async () => {
    if (getToken()) {
      await enterApp();
    } else {
      showLogin();
    }
  })();
})();