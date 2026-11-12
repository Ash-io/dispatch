// Helpers for episodes that use the dispatch-server admin panel (Worker via wrangler dev).
import { startServer } from './common.mjs';

export const ADMIN = { email: 'adaeze@acme.ng', password: 'correct-horse-battery' };
let srv = null;

export async function server(page) {
  srv = await startServer();
  await page.goto(srv.base + '/admin/');
  await page.waitForTimeout(800);
  return srv;
}
export const stop = () => srv?.stop();

export async function signUpAdmin(page) {
  await page.click('#register-toggle');
  await page.fill('#login-email', ADMIN.email);
  await page.fill('#login-password', ADMIN.password);
  await page.click('#login-submit');
  await page.waitForSelector('#view-app:visible');
  await page.waitForTimeout(500);
}

export async function addKey(page, key = 'PMAK-acme-7f3c19d0a4b2', label) {
  await page.click('[data-tab=accounts]');
  const empty = page.locator('#account-add-empty');
  await ((await empty.isVisible()) ? empty : page.locator('#account-add')).click();
  await page.fill('#account-key', key);
  if (label) await page.fill('#account-label', label);
  await page.click('#dialog-ok');
  await page.waitForSelector('#accounts-body tr:has-text("Acme")');
  await page.waitForTimeout(400);
}

export async function addUser(page, email, role, grants = []) {
  await page.click('[data-tab=users]');
  await page.click('#add-user-open');
  await page.fill('#new-email', email); await page.fill('#new-password', 'correct-horse-battery');
  await page.selectOption('#new-role', role); await page.click('#add-user-submit');
  await page.waitForSelector('#dialog[open]');
  for (const g of grants) await page.locator(`#dialog label:has-text("${g}") input`).check();
  await page.click('#dialog-ok');
  await page.waitForTimeout(500);
}
