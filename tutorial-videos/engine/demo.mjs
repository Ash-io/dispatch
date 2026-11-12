// Demo data the episodes start from, loaded through the app's own Import dialog.
const S = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';
const url = (raw) => {
  const [base, q] = raw.split('?');
  const parts = base.replace('{{baseUrl}}/', '').split('/');
  return { raw, host: ['{{baseUrl}}'], path: parts, ...(q ? { query: q.split('&').map((kv) => { const [key, value] = kv.split('='); return { key, value }; }) } : {}) };
};
const json = (o) => ({ mode: 'raw', raw: JSON.stringify(o, null, 2), options: { raw: { language: 'json' } } });

export const paymentsCollection = {
  info: { _postman_id: 'payments-demo', name: 'Payments API', schema: S },
  auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}', type: 'string' }] },
  variable: [{ key: 'baseUrl', value: 'https://api.example.com/v1' }],
  item: [
    { name: 'Auth', item: [
      { name: 'Get token', request: { method: 'POST', auth: { type: 'noauth' }, header: [{ key: 'Content-Type', value: 'application/json' }], url: url('{{baseUrl}}/oauth/token'), body: json({ client_id: '{{clientId}}', client_secret: '{{clientSecret}}' }) },
        event: [{ listen: 'test', script: { exec: ["pm.test('Status is 200', () => pm.response.to.have.status(200));", "pm.environment.set('token', pm.response.json().json.client_id);"] } }] },
    ] },
    { name: 'Transactions', item: [
      { name: 'List transactions', request: { method: 'GET', header: [], url: url('{{baseUrl}}/transactions?page=1&limit=20') } ,
        event: [{ listen: 'test', script: { exec: ["pm.test('Status is 200', () => pm.response.to.have.status(200));"] } }] },
      { name: 'Create transaction', request: { method: 'POST', header: [{ key: 'Content-Type', value: 'application/json' }], url: url('{{baseUrl}}/transactions'), body: json({ amount: 250000, currency: 'NGN', narration: 'Invoice 2041' }) },
        event: [{ listen: 'test', script: { exec: ["pm.test('Created', () => pm.response.to.have.status(200));"] } }] },
      { name: 'Get transaction', request: { method: 'GET', header: [], url: { ...url('{{baseUrl}}/transactions/:id'), variable: [{ key: 'id', value: 'TX-1001' }] } },
        response: [{ name: 'Successful', originalRequest: { method: 'GET', url: url('{{baseUrl}}/transactions/TX-1001') }, status: 'OK', code: 200, header: [{ key: 'Content-Type', value: 'application/json' }], body: JSON.stringify({ id: 'TX-1001', amount: 250000, currency: 'NGN', status: 'successful' }, null, 2) },
          { name: 'Not found', originalRequest: { method: 'GET', url: url('{{baseUrl}}/transactions/TX-0000') }, status: 'Not Found', code: 404, header: [{ key: 'Content-Type', value: 'application/json' }], body: JSON.stringify({ error: 'transaction_not_found' }, null, 2) }] },
    ] },
    { name: 'Users', item: [
      { name: 'List users', request: { method: 'GET', header: [], url: url('{{baseUrl}}/users?page=1') } },
    ] },
    { name: 'Health check', request: { method: 'GET', auth: { type: 'noauth' }, header: [], url: url('{{baseUrl}}/status/200') } },
  ],
};

export const sandboxEnv = { name: 'Sandbox', values: [
  { key: 'baseUrl', value: 'https://api.example.com/v1', enabled: true },
  { key: 'clientId', value: 'sandbox-client', enabled: true },
  { key: 'clientSecret', value: 'sk_test_51f0', enabled: true, type: 'secret' },
  { key: 'token', value: '', enabled: true },
], _postman_variable_scope: 'environment' };

export const productionEnv = { name: 'Production', values: [
  { key: 'baseUrl', value: 'https://staging.example.com/v1', enabled: true },
  { key: 'clientId', value: 'live-client', enabled: true },
  { key: 'clientSecret', value: '', enabled: true, type: 'secret' },
  { key: 'token', value: '', enabled: true },
], _postman_variable_scope: 'environment' };

// Pastes each document into Import, as a user would.
export async function importDocs(page, docs) {
  for (const doc of docs) {
    await page.getByRole('button', { name: /^Import/ }).first().click();
    const ta = page.locator('dialog textarea, .modal textarea').first();
    await ta.waitFor();
    await ta.fill(typeof doc === 'string' ? doc : JSON.stringify(doc));
    await page.locator('dialog button.primary, .modal button.primary').last().click();
    await page.waitForTimeout(600);
    const dlg = page.locator('dialog[open] button.primary');
    if (await dlg.count()) { await dlg.last().click().catch(() => {}); await page.waitForTimeout(400); }
  }
}

export const seedAll = (page) => importDocs(page, [paymentsCollection, sandboxEnv, productionEnv]);
