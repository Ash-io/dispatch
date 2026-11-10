import { openApp } from '../engine/common.mjs';

// The browser build can't open sockets, so the connection is played into the
// tab's live state: the same state the desktop app fills from Rust.
async function wsState(page, fn, arg) {
  await page.evaluate(async ([src, a]) => {
    const S = await import('/js/store.js');
    const C = await import('/js/ctx.js');
    const t = C.activeTab();
    globalThis.__TAURI__ = { core: { invoke: async () => null } };
    // eslint-disable-next-line no-new-func
    new Function('t', 'a', src)(t, a);
    S.emit('ws', 'tabs');
  }, [fn, arg]);
  await page.waitForTimeout(300);
}

const now = Date.parse('2026-11-09T10:00:00Z');

export default {
  title: 'Live WebSocket connections',
  summary: 'Open a socket, watch frames stream in, and send messages back.',
  intro: "Some APIs don't just answer once, they keep talking. Let's open a WebSocket and chat with it, live.",
  outro: "That's WebSockets: connect, watch, reply, close. Next up, gRPC.",
  doneTitle: 'Live and connected.',
  window: 'Dispatch',
  async setup(page) { await openApp(page); },
  steps: [
    {
      id: 'url', title: 'Use a ws:// or wss:// URL',
      hint: 'Open a new request and type a `wss://` address. **Send** now opens a live connection.',
      say: 'Open a new request, and type an address starting with W S, or W S S. Now Send opens a live connection, instead of a one-off request.',
      async run(c, page) {
        await c.click('#workspace .btn.primary:has-text("New request")', { at: 'new' });
        await c.type('input[placeholder^="Enter a URL"]', 'wss://ws.example.com/rates?pair=USDNGN', { at: 'type', frames: 5 });
        await c.look('.send-btn', { label: 'Opens a live connection', at: 'connect' });
      },
    },
    {
      id: 'connect', title: 'Connect and watch frames',
      hint: 'Click **Send** to connect. Incoming frames stream in with their size and time.',
      say: 'Click Send to connect. Messages from the server stream in as they arrive, with their size and time.',
      zoom: false,
      async run(c, page) {
        await c.click('.send-btn', { label: 'Send', at: 'click', wait: 200 });
        await c.quietly(async () => {
          await wsState(page, `t.wsConn = { status: 'connected', id: 'ws-1', log: [] };`);
          for (let i = 0; i < 4; i++) {
            const rate = (1584.2 + i * 0.35).toFixed(2);
            await wsState(page, `const m = JSON.stringify({ pair: 'USDNGN', rate: a.rate, ts: a.ts }); t.wsConn.log.push({ dir: 'in', text: m, size: m.length, at: a.ts });`, { rate: Number(rate), ts: now + i * 1000 });
          }
        });
        await c.hold({ at: 'stream' });
      },
    },
    {
      id: 'send', title: 'Send a message',
      hint: 'Write a message and press **Send frame**. It shows as an outgoing frame.',
      say: 'To talk back, write a message, and press Send frame. It appears in the log as an outgoing frame, and the reply follows.',
      async run(c, page) {
        const box = page.locator('#workspace textarea, #workspace .cm-content').last();
        await c.fill(box, '{ "action": "subscribe", "pair": "GBPNGN" }', { label: 'Your message', at: 'write' });
        await c.click(page.locator('#workspace button', { hasText: 'Send frame' }).last(), { label: 'Send frame', at: 'press', wait: 300 });
        await c.quietly(async () => {
          await wsState(page, `const m = JSON.stringify({ subscribed: 'GBPNGN', rate: 2011.6, ts: a }); t.wsConn.log.push({ dir: 'in', text: m, size: m.length, at: a });`, now + 6000);
        });
        await c.hold({ at: 'reply' });
      },
    },
    {
      id: 'close', title: 'Close cleanly',
      hint: '**Close** ends the session with a proper close frame.',
      say: 'When you are done, click Close. Dispatch ends the session cleanly, with a proper close frame.',
      async run(c, page) {
        await c.click(page.locator('#workspace button', { hasText: /^(Close|Disconnect)$/ }).first(), { label: 'Close', at: 'close', wait: 200 });
        await c.quietly(async () => { await wsState(page, `t.wsConn.status = 'closed'; t.wsConn.closeCode = 1000; t.wsConn.closeReason = 'Normal closure'; t.wsConn.id = null;`); });
        await c.hold({ at: 'clean' });
      },
    },
  ],
};
