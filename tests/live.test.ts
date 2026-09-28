// Optional live smoke test against the public, anonymous MCP endpoint. Read-only: it lists tools
// and templates and creates nothing. Runs only when a person sets CC_SDK_LIVE=1.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpMcpTransport } from '../src/index.js';

const live = process.env.CC_SDK_LIVE === '1';
const endpoint = process.env.CC_SDK_LIVE_ENDPOINT ?? 'https://centralcity.ai/mcp/open';

test('live /mcp/open: modern tools/list and a read-only tool call', { skip: !live }, async () => {
  const transport = new HttpMcpTransport({
    endpoint,
    clientInfo: { name: '@centralcity/sdk live smoke', version: '0.0.0' },
  });
  const listed = await transport.request<{ tools: Array<{ name: string }> }>('tools/list');
  const names = listed.tools.map((tool) => tool.name);
  for (const name of ['city_list_templates', 'city_plan_team', 'city_create_agent', 'city_create_workspace'])
    assert.ok(names.includes(name), name);
  const templates = await transport.callTool<{ templates: Array<{ ref: string }> }>(
    'city_list_templates',
    {},
  );
  assert.ok(templates.templates.some((t) => t.ref === 'template:extractor@1.0.0'));
});

test('live /mcp/open: legacy protocol with initialize', { skip: !live }, async () => {
  const transport = new HttpMcpTransport({ endpoint, protocol: 'legacy' });
  const listed = await transport.request<{ tools: unknown[] }>('tools/list');
  assert.ok(listed.tools.length >= 5);
});
