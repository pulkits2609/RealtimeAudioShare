import { expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export async function captureView(page: Page, name: string) {
  const directory = new URL('../verification/meeting-views/', import.meta.url);
  await mkdir(directory, { recursive: true });
  await page.mouse.move(1, 1);
  // Motion's layout transitions use requestAnimationFrame and can still be midway
  // through a reflow even after Playwright has stopped CSS animations.
  await page.evaluate(async () => {
    const geometry = () => [...document.querySelectorAll('.source-tile, .inline-drawer, .meeting-dock')].map(node => {
      const { x, y, width, height } = node.getBoundingClientRect();
      return [x, y, width, height].map(value => value.toFixed(1)).join(',');
    }).join(';');
    let last = geometry(), unchanged = 0;
    for (let i = 0; i < 100 && unchanged < 6; i++) {
      await new Promise(resolve => setTimeout(resolve, 35));
      const next = geometry();
      unchanged = next === last ? unchanged + 1 : 0;
      last = next;
    }
  });
  await page.screenshot({ path: fileURLToPath(new URL(`${name}.png`, directory)), animations: 'disabled', fullPage: name === 'connection' });
}

export async function openSettings(page: Page, section: 'Devices' | 'Device audio' | 'Diagnostics') {
  const settings = page.getByRole('button', { name: 'Settings', exact: true });
  if (!(await settings.isVisible())) await page.getByRole('button', { name: 'More', exact: true }).click();
  await settings.click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: section, exact: true }).click();
  return dialog;
}

export async function closeSettings(page: Page) {
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: /^Close / }).click();
  await expect(dialog).toBeHidden();
}

export async function startSharing(page: Page, kind: 'screen' | 'audio') {
  await page.getByRole('button', { name: kind === 'screen' ? 'Share screen' : 'Share device audio', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: kind === 'screen' ? 'Share screen' : 'Share audio', exact: true }).click();
  await expect(dialog.getByRole('button', { name: kind === 'screen' ? 'Stop screen sharing' : 'Stop sharing', exact: true })).toBeVisible();
  await closeSettings(page);
}
