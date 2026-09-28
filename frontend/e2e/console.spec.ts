import { test, expect, request } from '@playwright/test';

const API = process.env.E2E_API_URL ?? 'http://localhost:3000';
const GATEWAY = process.env.E2E_GATEWAY_URL ?? 'http://localhost:4001';

/** Arrange through the public API + the mock gateway, then assert through the UI only. */
async function seedGroupWithAgentRun() {
  const api = await request.newContext({ baseURL: API });
  const { accessToken } = await (await api.post('/api/auth/login', { data: { username: 'admin', password: 'admin' } })).json();
  const headers = { authorization: `Bearer ${accessToken}` };
  const accounts: any[] = await (await api.get('/api/accounts', { headers })).json();
  const usable = accounts.filter((a) => ['idle', 'disconnected', 'online'].includes(a.status)).slice(0, 3);
  for (const a of usable) if (a.status !== 'online') await api.post(`/api/accounts/${a.id}/connect`, { headers });
  const [creator, ...members] = usable.map((a) => a.id);
  const { jobId } = await (await api.post('/api/groups', { headers, data: { creatorAccountId: creator, memberAccountIds: members } })).json();
  let job: any;
  await expect.poll(async () => (job = await (await api.get(`/api/jobs/${jobId}`, { headers })).json()).status, { timeout: 15_000 }).toBe('finished');
  await api.patch(`/api/groups/${job.groupId}`, { headers, data: { agentEnabled: true } });
  const group = await (await api.get(`/api/groups/${job.groupId}`, { headers })).json();
  await api.post(`${GATEWAY}/__inject/message`, { data: { groupId: group.gatewayGroupId, text: 'e2e: 有人在吗' } });
  return group.id as string;
}

async function login(page: import('@playwright/test').Page, user: string) {
  await page.goto('/');
  await page.locator('input:not([type=password])').first().fill(user);
  await page.locator('input[type=password]').fill(user);
  await page.keyboard.press('Enter');
  await expect(page.getByText('实时已连接')).toBeVisible();
}

test('admin: login → open group → agent run steps are visible', async ({ page }) => {
  const groupId = await seedGroupWithAgentRun();
  await login(page, 'admin');
  await page.goto(`/groups/${groupId}`);
  await expect(page.getByText('e2e: 有人在吗', { exact: true })).toBeVisible();          // arrives over the WebSocket
  const runLink = page.locator('a[href*="/agent-runs/"]').first();
  await expect(runLink).toBeVisible({ timeout: 15_000 });
  await runLink.click();
  await expect(page.getByRole('cell', { name: 'get_recent_messages', exact: true }).first()).toBeVisible();
  await expect(page.getByRole('cell', { name: 'send_message', exact: true }).first()).toBeVisible();
  await expect(page.getByText('finished', { exact: true }).first()).toBeVisible({ timeout: 15_000 });
});

test('viewer: sees data but no write controls', async ({ page }) => {
  await login(page, 'viewer');
  await page.goto('/accounts');
  await expect(page.getByRole('cell', { name: 'acc_01', exact: true })).toBeVisible();
  for (const label of ['标记离线', '重连', '释放账号']) await expect(page.getByRole('button', { name: label })).toHaveCount(0);
  await page.goto('/groups');
  await expect(page.getByRole('button', { name: '创建' })).toHaveCount(0);
});
