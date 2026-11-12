// Small helpers for finding things in the Dispatch UI.

export const row = (page, name) => page.locator('#sidebar .tree-row', { has: page.locator(`span.name[title="${name}"]`) }).first();

// Hovers a sidebar row and returns its ⋯ button.
export async function collMenu(page, name) {
  const r = row(page, name);
  await r.hover(); await page.waitForTimeout(150);
  return r.locator('button[title="More"]');
}

export const menuItem = (page, text) => page.locator('.menu button', { hasText: text }).first();

// Opens a request (expanding its collection and folder) quietly.
export async function openRequest(page, coll, folder, name) {
  const isOpen = async (n) => (await row(page, n).locator('svg.chev.open').count()) > 0;
  if (!(await isOpen(coll))) { await row(page, coll).click(); await page.waitForTimeout(250); }
  if (folder && !(await isOpen(folder))) { await row(page, folder).click(); await page.waitForTimeout(250); }
  await row(page, name).click(); await page.waitForTimeout(450);
}

// Waits for import toasts to clear so they don't appear in shots.
export async function settle(page) {
  await page.evaluate(() => document.querySelectorAll('.toasts > *').forEach((t) => t.remove()));
  await page.waitForTimeout(200);
}

export const subtab = (page, text) => page.locator('#workspace .subtab', { hasText: text }).first();
export const btn = (page, name, scope = 'body') => page.locator(scope).getByRole('button', { name }).first();

// Pick an option in a native <select> quietly (the UI shows the result).
export async function selectEnv(page, name) {
  await page.locator('select.env-select').selectOption({ label: name });
  await page.waitForTimeout(300);
}
