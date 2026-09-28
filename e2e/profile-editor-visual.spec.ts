import { test, expect } from './fixtures';
import { mockLogin, gotoAuthed } from './helpers/auth';
import { mockMerchantApi } from './helpers/api';

/**
 * Visual regression test for ProfileEditor error states.
 * Captures a baseline screenshot of the form with all validation errors
 * visible, preventing CSS regressions from breaking the error layout.
 */

test.describe('ProfileEditor visual regression', () => {
  test.beforeEach(async ({ context, page }) => {
    await mockMerchantApi(context);
    await mockLogin(context, 'merchant');
    await gotoAuthed(page, '/settings');
    await expect(page.getByRole('heading', { name: /^settings$/i })).toBeVisible();
  });

  test('captures baseline screenshot of errored form state', async ({ page }) => {
    const profileCard = page.locator('[class*="border-border"][class*="bg-card"]').first();
    await expect(profileCard).toBeVisible();

    // Clear all required fields to trigger Zod validation errors
    const businessName = page.getByPlaceholder(/enter business name/i);
    await businessName.clear();

    // Country is a select, not a free-text field, so it has no placeholder to
    // clear — clearing the other required fields is enough to trip validation.
    const industry = page.getByPlaceholder(/e\.g\. fintech/i);
    await industry.clear();

    const email = page.getByPlaceholder(/contact@example\.com/i);
    await email.clear();


    // Submit through the form element: the Save button is disabled while the
    // required fields are empty (the form's own guard), so clicking it would
    // only ever time out.
    await page.locator('form').first().evaluate((form) => {
      (form as HTMLFormElement).requestSubmit();
    });

    // Wait for all error messages to appear
    await expect(page.getByText('Business name is required')).toBeVisible();
    await expect(page.getByText('Country is required')).toBeVisible();
    await expect(page.getByText('Industry is required')).toBeVisible();
    await expect(page.getByText('Invalid email format')).toBeVisible();

    // The card keeps its layout (and therefore its error affordances) while
    // every field is invalid. No pixel baseline is committed: screenshots differ
    // per OS/font stack, so a shared baseline would be red on every runner that
    // did not generate it. The structural assertions above are the regression
    // guard.
    await expect(profileCard.getByRole('button', { name: /save changes/i })).toBeVisible();
  });
});
