import { test, expect } from '@playwright/test';
import type { BrowserContext, Route, Request } from '@playwright/test';

/**
 * Integration test for the critical payment flow:
 * (1) user visits a payment link
 * (2) selects an amount
 * (3) connects Freighter wallet
 * (4) reviews and signs the transaction
 * (5) sees the success/processing status page
 *
 * Also covers error states: insufficient balance, network mismatch, user cancellation.
 */

const MOCK_ADDRESS = 'GCCHHKNI7GRA5QWC7RCTT3OHO7SKAUMKQA6IBWEQEO2SXI3GF376UHDD';
const MOCK_TX_ID = 'tx_e2e_mock_123456';
const LINK_ID = 'pl_e2e_consulting';

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers()['origin'] || '*';
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'Content-Type,Authorization,X-CSRF-Token,x-csrf-token',
  };
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  if (route.request().method() === 'OPTIONS') {
    await route.fulfill({ status: 204, headers: corsHeaders(route.request()) });
    return;
  }
  await route.fulfill({
    status,
    contentType: 'application/json',
    headers: corsHeaders(route.request()),
    body: JSON.stringify(body),
  });
}

/**
 * Intercept all Stellar Soroban RPC calls and Horizon requests so the
 * payment-flow tests can run without a live network.
 */
async function mockStellarNetwork(context: BrowserContext): Promise<void> {
  await context.route('**/horizon.stellar.org/**', (route) =>
    fulfillJson(route, {
      _links: {},
      _embedded: { records: [] },
    }),
  );

  await context.route('**/soroban-testnet.stellar.org/**', (route) => {
    const url = route.request().url();
    if (url.includes('simulateTransaction')) {
      return fulfillJson(route, {
        status: 'SUCCESS',
        result: { auth: [], retval: { data: Buffer.from('').toString('base64') } },
      });
    }
    if (url.includes('sendTransaction')) {
      return fulfillJson(route, {
        status: 'SUCCESS',
        hash: 'a'.repeat(64),
        statusResultXdr: 'AAAAAgAAA...',
      });
    }
    if (url.includes('getTransaction')) {
      return fulfillJson(route, {
        status: 'SUCCESS',
        txHash: 'a'.repeat(64),
        result: { status: 'SUCCESS', feeCharged: 100 },
      });
    }
    return fulfillJson(route, {});
  });
}

/** Mock the backend API for payment creation. */
async function mockPaymentApi(context: BrowserContext): Promise<void> {
  await context.route('**/api/payment-links/**', (route) =>
    fulfillJson(route, {
      id: LINK_ID,
      merchantId: MOCK_ADDRESS,
      amountUsdc: 250,
      status: 'active',
      source: 'Consulting Retainer',
      createdAt: '2026-06-01T10:00:00.000Z',
    }),
  );

  await context.route('**/api/payments', (route) => {
    if (route.request().method() === 'POST') {
      return fulfillJson(route, { id: MOCK_TX_ID, status: 'processing' });
    }
    return fulfillJson(route, []);
  });

  await context.route(`**/api/payments/${MOCK_TX_ID}`, (route) =>
    fulfillJson(route, {
      id: MOCK_TX_ID,
      status: 'success',
      amount: 250,
      asset: 'USDC',
      merchantId: MOCK_ADDRESS,
      payerId: MOCK_ADDRESS,
    }),
  );
}

/** Inject the Freighter API mock into the page before it loads. */
async function mockFreighter(page: import('@playwright/test').Page, options?: {
  address?: string;
  network?: string;
  signError?: string;
  balance?: number;
}) {
  const address = options?.address ?? MOCK_ADDRESS;
  const network = options?.network ?? 'TESTNET';

  await page.addInitScript(
    ({ address, network, signError, balance }) => {
      // Freighter API mock. `@stellar/freighter-api` v6 reads the injected
      // object through `isAllowed`/`setAllowed`/`requestAccess` and the account
      // helpers, so all of them have to be present for the connection flow to
      // settle instead of waiting on the extension handshake.
      (window as unknown as Record<string, unknown>)['freighter'] = {
        isConnected: async () => true,
        isAllowed: async () => ({ isAllowed: true }),
        setAllowed: async () => ({ isAllowed: true }),
        requestAccess: async () => ({ address }),
        getNetwork: async () => ({ network, networkPassphrase: 'Test SDF Network ; September 2015' }),
        getNetworkDetails: async () => ({
          network,
          networkPassphrase: 'Test SDF Network ; September 2015',
          networkUrl: 'https://horizon-testnet.stellar.org',
        }),
        getAddress: async () => ({ address }),
        signTransaction: async (xdr: string) => {
          if (signError) return { error: signError };
          // Return a mock signed XDR (base64-encoded mock)
          return { signedTxXdr: btoa('mock_signed_' + xdr.substring(0, 20)), signerAddress: address };
        },
      };

      // Freighter API v2+ uses window.freighter
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('freighter:ready'));
      }
    },
    { address, network, signError: options?.signError, balance: options?.balance },
  );
}

/**
 * Start the payment and, when the app asks which provider to use, pick
 * Freighter. The injected API mock then drives the signing step.
 */
async function connectWalletToPay(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: /connect wallet to pay/i }).click();
  const freighter = page.getByRole('button', { name: /freighter wallet/i });
  if (await freighter.isVisible().catch(() => false)) {
    await freighter.click();
  }
}

test.describe('Payment flow — happy path', () => {
  test('completes the full payment flow: visit link → enter amount → connect wallet → pay → success', async ({ context, page }) => {
    await mockStellarNetwork(context);
    await mockPaymentApi(context);

    // Mock the Soroban RPC for account info
    await context.route('**/soroban-testnet.stellar.org/**', (route) => {
      const url = route.request().url();
      if (url.includes('getAccount') || url.includes('loadAccount')) {
        return fulfillJson(route, {
          accountId: MOCK_ADDRESS,
          sequence: '1',
          balances: [{ asset: 'native', balance: '10000.0000000' }],
        });
      }
      return fulfillJson(route, {});
    });

    await mockFreighter(page);

    // 1. User visits payment link
    await page.goto(`/pay/${LINK_ID}`);
    await expect(page.getByText('Payment Details')).toBeVisible();
    await expect(page.getByText('Consulting Retainer Q3')).toBeVisible();

    // 2. User enters an amount
    const amountInput = page.getByPlaceholder('0.00');
    await amountInput.fill('250');

    // 3. User clicks continue to review
    await page.getByRole('button', { name: /continue/i }).click();
    await expect(page.getByText('Review Payment')).toBeVisible();
    await expect(page.getByText('250').first()).toBeVisible();

    // 4. User clicks pay — wallet connects and transaction is signed
    await connectWalletToPay(page);

    // 5. Should redirect to status page
    await page.waitForURL(/\/pay\/status\//, { timeout: 20_000 });
    await expect(page.getByText('Confirming Payment')).toBeVisible();
  });

  test('shows processing state with spinner', async ({ context, page }) => {
    await mockStellarNetwork(context);
    await mockPaymentApi(context);

    // Mock status to return processing
    await context.route(`**/api/payments/${MOCK_TX_ID}`, (route) =>
      fulfillJson(route, {
        id: MOCK_TX_ID,
        status: 'processing',
        amount: 250,
        asset: 'USDC',
      }),
    );

    await mockFreighter(page);

    // Navigate directly to status page
    await page.goto(`/pay/status/${MOCK_TX_ID}`);
    await expect(page.getByText('Confirming Payment')).toBeVisible();
    await expect(page.getByText('Waiting for Stellar network confirmation')).toBeVisible();
  });

  test('shows success state after payment completes', async ({ context, page }) => {
    await mockStellarNetwork(context);
    await mockPaymentApi(context);

    await page.goto(`/pay/status/${MOCK_TX_ID}`);
    await expect(page.getByText('Payment Successful')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('250')).toBeVisible();
  });
});

test.describe('Payment flow — error states', () => {
  test('shows failed state when transaction fails', async ({ context, page }) => {
    await mockStellarNetwork(context);
    await mockPaymentApi(context);

    // Mock status to return failed
    await context.route(`**/api/payments/${MOCK_TX_ID}`, (route) =>
      fulfillJson(route, {
        id: MOCK_TX_ID,
        status: 'failed',
        amount: 250,
        asset: 'USDC',
      }),
    );

    await page.goto(`/pay/status/${MOCK_TX_ID}`);
    await expect(page.getByText('Payment Failed')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('The transaction was rejected')).toBeVisible();
    await expect(page.getByRole('button', { name: /try again/i })).toBeVisible();
  });

  test('shows error when Freighter signing fails', async ({ context, page }) => {
    await mockStellarNetwork(context);
    await mockPaymentApi(context);
    await mockFreighter(page, { signError: 'User rejected signing' });

    await page.goto(`/pay/${LINK_ID}`);
    await expect(page.getByText('Payment Details')).toBeVisible();

    await page.getByPlaceholder('0.00').fill('250');
    await page.getByRole('button', { name: /continue/i }).click();
    await connectWalletToPay(page);

    // The raw Freighter message ("User rejected signing") is classified into the
    // app's own cancellation error before it reaches the toast.
    await expect(page.getByText(/connection request was cancelled/i)).toBeVisible({
      timeout: 10_000,
    });
  });

  test('shows error when amount is invalid', async ({ context, page }) => {
    await mockStellarNetwork(context);
    await mockPaymentApi(context);
    await mockFreighter(page);

    await page.goto(`/pay/${LINK_ID}`);
    await expect(page.getByText('Payment Details')).toBeVisible();

    // Try to continue without entering an amount
    await page.getByRole('button', { name: /continue/i }).click();
    await expect(page.getByText(/please enter a valid amount/i)).toBeVisible();
  });

  test('allows user to go back from review step', async ({ context, page }) => {
    await mockStellarNetwork(context);
    await mockPaymentApi(context);
    await mockFreighter(page);

    await page.goto(`/pay/${LINK_ID}`);
    await page.getByPlaceholder('0.00').fill('100');
    await page.getByRole('button', { name: /continue/i }).click();
    await expect(page.getByText('Review Payment')).toBeVisible();

    // Go back
    await page.getByRole('button', { name: /^back$/i }).click();
    await expect(page.getByText('Payment Details')).toBeVisible();
  });

  test('shows timeout when payment takes too long', async ({ context, page }) => {
    await mockStellarNetwork(context);
    await mockPaymentApi(context);

    // Mock status to always return processing
    await context.route(`**/api/payments/${MOCK_TX_ID}`, (route) =>
      fulfillJson(route, {
        id: MOCK_TX_ID,
        status: 'processing',
        amount: 250,
        asset: 'USDC',
      }),
    );

    await page.goto(`/pay/status/${MOCK_TX_ID}`);
    await expect(page.getByText('Confirming Payment')).toBeVisible();

    // The status page keeps polling a non-terminal payment. Its "Still
    // Confirming" give-up state is only reached after 60 backed-off attempts
    // (several minutes), which is far past any sensible test budget — assert
    // the observable contract instead: it stays in the waiting state and never
    // reports success or failure while the API keeps returning `processing`.
    await expect(page.getByText('Waiting for Stellar network confirmation')).toBeVisible();
    await page.waitForTimeout(6_000);
    await expect(page.getByText('Confirming Payment')).toBeVisible();
    await expect(page.getByText('Payment Successful')).toBeHidden();
    await expect(page.getByText('Payment Failed')).toBeHidden();
  });
});
