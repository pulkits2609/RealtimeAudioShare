import { test, expect, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('owner issues a single-use invitation, sees who redeemed it, and removes that participant', async ({ browser }) => {
  const secret = process.env.AUDIOSHARE_TEST_SFU_SECRET;
  if (!secret) throw new Error('Run with the isolated test stack.');
  const apiModule = new URL('../../electron/server/dist/session-server.js', import.meta.url);
  const { createSessionServer } = await import(apiModule.href);
  const directory = await mkdtemp(path.join(tmpdir(), 'audioshare-managed-test-'));
  const store = path.join(directory, 'access.json');
  const ownerToken = randomBytes(32).toString('hex');
  const api = createSessionServer({
    livekitApiKey: 'isolated_fixture', livekitApiSecret: secret, livekitUrl: 'http://127.0.0.1:19995',
    ownerToken, accessStorePath: store, allowGuests: false, allowLegacySessions: false,
    allowedOrigins: ['http://127.0.0.1:15173'], sessionRateLimit: 500,
  });
  const pages: Page[] = [];
  try {
    await new Promise<void>((resolve, reject) => { api.http.once('error', reject); api.http.listen(0, '127.0.0.1', resolve); });
    const port = String(api.http.address().port);
    async function join(name: string, token: string) {
      const page = await browser.newPage({ permissions: ['microphone', 'local-network-access'] });
      pages.push(page);
      await page.goto('/');
      await page.getByLabel('Your name', { exact: true }).fill(name);
      await page.getByLabel('Server address', { exact: true }).fill('127.0.0.1');
      await page.getByLabel('Port', { exact: true }).fill(port);
      await page.getByText('Connection options', { exact: true }).click();
      await page.getByLabel('Server access token', { exact: true }).fill(token);
      await page.getByRole('button', { name: 'Join server', exact: true }).click();
      await expect(page.locator('.connection-state:visible')).toHaveText('Connected', { timeout: 25000 });
      return page;
    }
    const owner = await join('Fixture owner', ownerToken);
    await owner.getByRole('button', { name: 'Rooms', exact: true }).click();
    const dialog = owner.getByRole('dialog');
    await dialog.getByLabel('Uses per token', { exact: true }).fill('1');
    const lobby = dialog.locator('.room-manager > .room-row').filter({ hasText: /^lobby · owner/ });
    await lobby.getByRole('button', { name: 'Create invitation', exact: true }).click();
    const invitation = await dialog.getByLabel('Invitation token for lobby', { exact: true }).inputValue();
    const guest = await join('Invited participant', invitation);
    await expect(guest.getByTestId('peer')).toContainText('Fixture owner');
    const exhausted = await fetch(`http://127.0.0.1:${port}/v1/auth/session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Another guest', token: invitation }),
    });
    expect([401, 403]).toContain(exhausted.status);
    await lobby.getByRole('button', { name: 'Token history', exact: true }).click();
    await dialog.getByRole('button', { name: 'View usage', exact: true }).first().click();
    await expect(dialog.locator('.usage-list')).toContainText('Invited participant');
    await lobby.getByRole('button', { name: 'Manage people', exact: true }).click();
    const member = dialog.locator('.room-manager section .room-row').filter({ hasText: /^Invited participant/ });
    await expect(member).toContainText('Connected to this room');
    await member.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(guest.locator('.connection-state:visible')).toHaveText('Not connected', { timeout: 15000 });
    await expect(member).toHaveCount(0);
    expect(await owner.evaluate(() => JSON.stringify(localStorage))).not.toContain(ownerToken);
  } finally {
    await Promise.allSettled(pages.map(page => page.close()));
    await api.close();
    await rm(store, { force: true });
    await rmdir(directory);
  }
});
