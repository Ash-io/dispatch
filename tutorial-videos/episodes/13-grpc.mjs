import { openApp } from '../engine/common.mjs';
import { menuItem } from '../engine/ui.mjs';

export default {
  title: 'Call gRPC services',
  summary: 'Load services by reflection or .proto files, write the message as JSON, and invoke.',
  intro: "gRPC is fast, but it's not plain J SON over H T T P. Dispatch speaks it too. Let's call a service.",
  outro: "And that's gRPC, unary and streaming. Next, GraphQL with real autocomplete.",
  doneTitle: 'gRPC, called.',
  async setup(page) { await openApp(page); },
  steps: [
    {
      id: 'new', title: 'New gRPC request',
      hint: 'Sidebar **+** › **New gRPC request**, or [⌘]+[K].',
      say: 'Click the plus button, and choose New gRPC request.',
      async run(c, page) {
        await c.click('#sidebar button[title="New"]', { at: 'plus' });
        await c.click(menuItem(page, 'New gRPC'), { label: 'New gRPC request', at: 'grpc', wait: 500 });
      },
    },
    {
      id: 'target', title: 'Point it at the server',
      hint: 'Enter `host:port`. Use `grpcs://` for TLS.',
      say: 'Enter the server address, host and port. For T L S, start it with G R P C S.',
      async run(c, page) {
        await c.type('#workspace input.grpc-target', 'localhost:50051', { at: 'address', frames: 3 });
      },
    },
    {
      id: 'load', title: 'Load the services',
      hint: '**Use server reflection**, or pick your **.proto** files.',
      say: 'Now load the services. Use server reflection if the server supports it, or choose your proto files.',
      async run(c, page) {
        await c.click(page.getByRole('button', { name: 'Use server reflection' }), { label: 'Use server reflection', at: 'reflection', wait: 500 });
        await c.click('#workspace select.grpc-method', { label: 'Pick a method', at: 'proto', clickOpts: { trial: true } });
        await c.quietly(async () => { const s = page.locator('#workspace select.grpc-method'); const v = await s.locator('option').nth(1).getAttribute('value'); await s.selectOption(v); await page.waitForTimeout(400); });
      },
    },
    {
      id: 'message', title: 'Write the message as JSON',
      hint: 'Start from the generated template. Add **Metadata** if needed.',
      say: 'Write the request message as J SON. Dispatch gives you a template to start from, and metadata goes in its own tab.',
      async run(c, page) {
        await c.fill(page.locator('#workspace .cm-content').first(), '{\n  "id": "ORD-7781"\n}', { label: 'Message', at: 'json' });
        await c.look(page.locator('#workspace .subtab', { hasText: 'Metadata' }).first(), { label: 'Metadata', at: 'metadata' });
      },
    },
    {
      id: 'invoke', title: 'Invoke',
      hint: 'Replies, status, headers and trailers. Streaming replies show as they arrive.',
      say: 'Click Invoke. You get the reply, the status, headers and trailers. For server streaming methods, each message shows as it arrives.',
      zoom: false,
      async run(c, page) {
        await c.click('#workspace .send-btn', { label: 'Invoke', at: 'invoke', wait: 900 });
        await c.hold({ at: 'status' });
      },
    },
  ],
};
