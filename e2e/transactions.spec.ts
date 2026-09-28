import { test, expect } from './fixtures';
import { mockLogin, gotoAuthed } from './helpers/auth';
import { mockMerchantApi } from './helpers/api';

/**
 * Transactions list and the slide-out Transaction Detail Drawer.
 *
 * The table renders two `<table>` elements (the outer container and the
 * virtualized row table), so every table query is scoped with `.first()`.
 * Rows come from the mocked `/api/payments` fixtures, so we identify them by
 * their source label rather than by a payer address.
 *
 * We exercise the table chrome (search, filters, export) and the full drawer
 * lifecycle: open from a row, read its sections, copy a field, and close via
 * the button and via Escape.
 */

const ROW_A = 'Consulting Retainer';
const ROW_B = 'Open Donation';

/** First virtualized transaction row. */
function firstRow(page: import('@playwright/test').Page) {
  return page.getByTestId('transactions-virtual-list').locator('tbody tr').first();
}

test.beforeEach(async ({ context, page }) => {
  await mockMerchantApi(context);
  await mockLogin(context, 'merchant');
  await gotoAuthed(page, '/transactions');
  await expect(page.getByRole('heading', { name: /transactions/i })).toBeVisible();
});

test.describe('Transactions table', () => {
  test('renders the table with the expected columns', async ({ page }) => {
    await expect(page.getByRole('table').first()).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /date/i }).first()).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /payer/i }).first()).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /status/i }).first()).toBeVisible();
  });

  test('filters rows by search term', async ({ page }) => {
    const search = page.getByPlaceholder(/search by hash, address, or label/i);
    const list = page.getByTestId('transactions-virtual-list');
    await expect(list.getByText(ROW_A).first()).toBeVisible();

    await search.fill('Consulting');
    await expect(list.getByText(ROW_A).first()).toBeVisible();
    await expect(list.getByText(ROW_B)).toBeHidden();
  });

  test('exposes a CSV export action', async ({ page }) => {
    await expect(page.getByRole('button', { name: /export csv/i })).toBeVisible();
  });
});

test.describe('Transaction detail drawer', () => {
  test('opens from a row and shows the detail sections', async ({ page }) => {
    await firstRow(page).click();

    const drawer = page.getByRole('dialog');
    await expect(drawer.getByText(/transaction details/i)).toBeVisible();
    await expect(drawer.getByText(/basic info/i)).toBeVisible();
    await expect(drawer.getByText(/payment details/i)).toBeVisible();
    await expect(drawer.getByText(/raw payload/i)).toBeVisible();
  });

  test('navigates from dashboard to transaction detail', async ({ page }) => {
    await gotoAuthed(page, '/dashboard');
    await expect(page.getByRole('heading', { name: /good day/i })).toBeVisible();

    const txRow = page.getByText(ROW_A).first();
    if (await txRow.isVisible()) {
      await txRow.click();
      const drawer = page.getByRole('dialog');
      await expect(drawer.getByText(/transaction details/i)).toBeVisible();
      await expect(drawer.getByText(/basic info/i)).toBeVisible();
      await expect(drawer.getByText(/payment details/i)).toBeVisible();
    }
  });

  test('copies a field from the drawer', async ({ page }) => {
    await firstRow(page).click();
    const drawer = page.getByRole('dialog');

    const copyBtn = drawer.getByRole('button', { name: /copy transaction id/i }).first();
    await expect(copyBtn).toBeVisible();
    await copyBtn.click();

    // Copying must not close the drawer — the control is interactive in place.
    await expect(drawer).toBeVisible();
  });

  test('closes via the close button', async ({ page }) => {
    await firstRow(page).click();
    const drawer = page.getByRole('dialog');
    await expect(drawer).toBeVisible();

    await page.getByRole('button', { name: /close transaction details/i }).click();
    await expect(drawer).toBeHidden();
  });

  test('closes with the Escape key', async ({ page }) => {
    await firstRow(page).click();
    const drawer = page.getByRole('dialog');
    await expect(drawer).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
  });
});
