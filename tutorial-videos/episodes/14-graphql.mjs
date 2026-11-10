import { openApp } from '../engine/common.mjs';
import { subtab } from '../engine/ui.mjs';
import { buildSchema, graphqlSync } from 'graphql';

const schema = buildSchema(`
  type Query { orders(status: OrderStatus, first: Int = 10): [Order!]!  order(id: ID!): Order  me: Customer }
  enum OrderStatus { PENDING PAID SHIPPED CANCELLED }
  type Order { id: ID!  total: Int!  currency: String!  status: OrderStatus!  customer: Customer!  items: [LineItem!]! }
  type LineItem { sku: String!  quantity: Int!  price: Int! }
  type Customer { id: ID!  name: String!  email: String!  city: String }
`);
const rootValue = {
  orders: () => [
    { id: 'ORD-7781', total: 1250000, currency: 'NGN', status: 'PAID', customer: { id: 'C1', name: 'Chiamaka Obi', email: 'chiamaka@example.com', city: 'Lagos' }, items: [] },
    { id: 'ORD-7782', total: 480000, currency: 'NGN', status: 'PAID', customer: { id: 'C2', name: 'Femi Adeyemi', email: 'femi@example.com', city: 'Ibadan' }, items: [] },
  ],
};
const reply = (req) => {
  let body = {}; try { body = JSON.parse(req.postData() || '{}'); } catch {}
  return graphqlSync({ schema, source: body.query || '{ __typename }', rootValue, variableValues: body.variables });
};

export default {
  title: 'GraphQL with autocomplete',
  summary: 'Load the schema, get field suggestions and checks as you type, and explore the API.',
  intro: "With GraphQL, knowing the schema is half the work. Dispatch loads it for you, then helps as you type.",
  outro: "Schema loaded, query checked, answer back. Next, let's meet the A I assistant.",
  doneTitle: 'Query, answered.',
  async setup(page) {
    await openApp(page, { reply });
    await page.locator('#workspace .btn.primary:has-text("New request")').click();
    await page.locator('select.method-select').selectOption('POST');
    await page.locator('input[placeholder^="Enter a URL"]').fill('https://api.example.com/graphql');
    await page.waitForTimeout(300);
  },
  steps: [
    {
      id: 'body', title: 'Choose a GraphQL body',
      hint: 'In **Body**, pick **GraphQL**.',
      say: 'Point a request at your GraphQL endpoint. Then in the Body tab, choose GraphQL.',
      async run(c, page) {
        await c.click(subtab(page, 'Body'), { label: 'Body', at: 'body' });
        await c.click(page.locator('#workspace button, #workspace label', { hasText: /^GraphQL$/ }).first(), { label: 'GraphQL', at: 'choose', wait: 400 });
      },
    },
    {
      id: 'schema', title: 'Load the schema',
      hint: '**Load schema** introspects the endpoint, with your headers and auth.',
      say: 'Click Load schema. Dispatch asks the server for its schema, using the same headers and auth as your request.',
      async run(c, page) {
        await c.click(page.locator('#workspace button', { hasText: /Load schema/ }).first(), { label: 'Load schema', at: 'load', wait: 900 });
      },
    },
    {
      id: 'type', title: 'Type with suggestions',
      hint: 'Fields complete as you type. [⌃]+[Space] asks for suggestions anywhere.',
      say: 'Now start typing. Fields are suggested as you go, and Control Space brings up suggestions anywhere.',
      async run(c, page) {
        const ed = page.locator('#workspace textarea.code').first();
        await c.click(ed, { at: 'typing', wait: 200 });
        await c.quietly(async () => { await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('Backspace'); await page.keyboard.type('{\n  orders(status: PAID) {\n    id\n    total\n    cus', { delay: 10 }); await page.waitForTimeout(500); });
        await c.hold({ at: 'suggested' });
        await c.quietly(async () => { await page.keyboard.press('Enter'); await page.keyboard.type(' { name city }\n  }\n}', { delay: 10 }); await page.waitForTimeout(400); });
      },
    },
    {
      id: 'check', title: 'Mistakes are flagged',
      hint: 'Unknown fields, missing arguments and bad selections are underlined.',
      say: 'Mistakes are caught before you send. Unknown fields, missing arguments and bad selections are underlined, with a note explaining why.',
      async run(c, page) {
        await c.quietly(async () => { await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp'); await page.keyboard.press('End'); await page.keyboard.type('\n    discount', { delay: 10 }); await page.waitForTimeout(700); });
        await c.look(page.locator('#workspace .code-wrap').first(), { label: '"discount" isn\'t a field', at: 'underlined' });
        await c.quietly(async () => { for (let i = 0; i < 13; i++) await page.keyboard.press('Backspace'); await page.waitForTimeout(500); });
      },
    },
    {
      id: 'send', title: 'Send and explore',
      hint: 'Send it. The **schema explorer** lists every type and field.',
      say: 'Send it, and the answer comes back as usual. The schema explorer lets you browse every type and field.',
      zoom: false,
      async run(c, page) {
        await c.quietly(async () => { await page.locator('#workspace textarea.code').first().fill('{\n  orders(status: PAID) {\n    id\n    total\n    customer { name city }\n  }\n}'); await page.waitForTimeout(400); });
        await c.click('.send-btn', { label: 'Send', at: 'send', wait: 900 });
        const ex = page.locator('#workspace button', { hasText: /explor/i }).first();
        if (await ex.count()) await c.click(ex, { label: 'Schema explorer', at: 'explorer', wait: 500 });
        else await c.hold({ at: 'explorer' });
      },
    },
  ],
};
