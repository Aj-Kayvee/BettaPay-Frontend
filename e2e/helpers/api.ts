import type { BrowserContext, Request, Route } from '@playwright/test';

/**
 * Deterministic API mocks for the merchant surfaces.
 *
 * The BettaPay frontend talks to a backend that is not present in the E2E
 * environment (the axios client defaults to a `:3001` origin and the Next.js
 * app only ships a handful of auth/route stubs). Left unmocked, every merchant
 * data call 404s and the pages fall back to their empty states — which makes it
 * impossible to exercise edit/delete/copy or "view history" flows.
 *
 * We intercept the three data endpoints the critical flows depend on and return
 * stable fixtures. Interception is registered on the BrowserContext so it
 * survives navigations and applies to every page/tab the test opens.
 */

export interface FixturePayment {
  id: string;
  txHash: string | null;
  payerAddress: string | null;
  merchantId: string;
  amountUsdc: number;
  amountNgn: number | null;
  fxRate: number | null;
  status: string;
  source: string | null;
  createdAt: string;
}

export interface FixtureSettlement {
  id: string;
  merchantId: string;
  amountUsdc: number;
  amountNgn: number | null;
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED';
  createdAt: string;
  txHash: string | null;
  bankName: string | null;
  accountNumber: string | null;
}

const MERCHANT_ID = 'GCCHHKNI7GRA5QWC7RCTT3OHO7SKAUMKQA6IBWEQEO2SXI3GF376UHDD';

export const PAYMENTS_FIXTURE: FixturePayment[] = [
  {
    id: 'pl_e2e_consulting',
    txHash: null,
    payerAddress: null,
    merchantId: MERCHANT_ID,
    amountUsdc: 250,
    amountNgn: null,
    fxRate: null,
    status: 'active',
    source: 'Consulting Retainer',
    createdAt: '2026-06-01T10:00:00.000Z',
  },
  {
    id: 'pl_e2e_donation',
    txHash: null,
    payerAddress: null,
    merchantId: MERCHANT_ID,
    amountUsdc: 0,
    amountNgn: null,
    fxRate: null,
    status: 'active',
    source: 'Open Donation',
    createdAt: '2026-07-15T14:30:00.000Z',
  },
];

export const SETTLEMENTS_FIXTURE: FixtureSettlement[] = [
  {
    id: 'st_e2e_pending',
    merchantId: MERCHANT_ID,
    amountUsdc: 1200,
    amountNgn: 1_980_000,
    status: 'PENDING',
    createdAt: '2026-07-20T09:00:00.000Z',
    txHash: null,
    bankName: null,
    accountNumber: null,
  },
  {
    id: 'st_e2e_processing',
    merchantId: MERCHANT_ID,
    amountUsdc: 500,
    amountNgn: 825_000,
    status: 'PROCESSING',
    createdAt: '2026-07-18T09:00:00.000Z',
    txHash: null,
    bankName: 'GTBank',
    accountNumber: '0123456789',
  },
  {
    id: 'st_e2e_completed',
    merchantId: MERCHANT_ID,
    amountUsdc: 3400,
    amountNgn: 5_610_000,
    status: 'COMPLETED',
    createdAt: '2026-07-01T09:00:00.000Z',
    txHash: 'b1a2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00',
    bankName: 'GTBank',
    accountNumber: '0123456789',
  },
];

export const MERCHANT_PROFILE_FIXTURE = {
  id: MERCHANT_ID,
  businessName: 'Acme Payments Ltd',
  businessType: 'llc',
  country: 'Nigeria',
  industry: 'Fintech',
  websiteUrl: 'https://acme.example',
  contactEmail: 'owner@acme.example',
  phoneNumber: '+234 800 000 0000',
  logoUrl: null,
};

/**
 * CORS headers that make a fulfilled response acceptable to the browser
 * regardless of whether the request went same-origin or cross-origin to the
 * default `:3001` API base. Echoing the request Origin keeps it valid when the
 * request carries credentials (`withCredentials: true`).
 */
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
  const request = route.request();
  // Answer CORS preflight without a body.
  if (request.method() === 'OPTIONS') {
    await route.fulfill({ status: 204, headers: corsHeaders(request) });
    return;
  }
  await route.fulfill({
    status,
    contentType: 'application/json',
    headers: corsHeaders(request),
    body: JSON.stringify(body),
  });
}

/**
 * Register the merchant data mocks on a browser context. Call this once per
 * context (e.g. in a `beforeEach`) before navigating to a merchant page.
 *
 * Note: the globs are intentionally scoped so they never shadow the real
 * `/api/auth/*` routes, which must keep hitting the Next.js handlers.
 */
export async function mockMerchantApi(context: BrowserContext): Promise<void> {
  await context.route('**/api/payments**', (route) => fulfillJson(route, PAYMENTS_FIXTURE));
  await context.route('**/api/settlements**', (route) => fulfillJson(route, SETTLEMENTS_FIXTURE));
  await context.route('**/api/merchants/**', (route) => {
    const method = route.request().method();
    // A profile update (PATCH/PUT) just needs to resolve 2xx so the page shows
    // its success toast; echo the merchant back.
    if (method === 'PATCH' || method === 'PUT') {
      return fulfillJson(route, MERCHANT_PROFILE_FIXTURE);
    }
    return fulfillJson(route, MERCHANT_PROFILE_FIXTURE);
  });

  // Payment-link mutations go to `/api/payment-links` (the list is served from
  // `/api/payments`), so the create/edit/delete flows need their own stub.
  await context.route('**/api/payment-links**', (route) =>
    fulfillJson(route, { ...PAYMENTS_FIXTURE[0], id: 'pl_e2e_created' }),
  );

  // The security tab changes the password through the real auth surface; a 2xx
  // is all the page needs to raise its "Password updated" toast.
  await context.route('**/api/auth/change-password**', (route) =>
    fulfillJson(route, { ok: true }),
  );
}

/**
 * Override the payments endpoint with a specific list (e.g. an empty list to
 * exercise the empty state, or many links to exercise pagination). Register
 * this AFTER `mockMerchantApi` — Playwright matches the most-recently-added
 * route first.
 */
export async function mockPaymentsList(
  context: BrowserContext,
  payments: FixturePayment[],
): Promise<void> {
  await context.route('**/api/payments**', (route) => fulfillJson(route, payments));
}

/** Fail the payments endpoint to exercise the error/retry surface. */
export async function failPaymentsApi(context: BrowserContext): Promise<void> {
  await context.route('**/api/payments**', (route) =>
    fulfillJson(route, { error: 'Failed to load payment links' }, 500),
  );
}

/** Generate `n` distinct payment-link fixtures (for pagination coverage). */
export function generatePayments(n: number): FixturePayment[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `pl_gen_${i + 1}`,
    txHash: null,
    payerAddress: null,
    merchantId: MERCHANT_ID,
    amountUsdc: (i + 1) * 10,
    amountNgn: null,
    fxRate: null,
    status: 'active',
    source: `Generated Link ${i + 1}`,
    // Descending dates keep a stable, predictable ordering.
    createdAt: `2026-07-${String((i % 27) + 1).padStart(2, '0')}T12:00:00.000Z`,
  }));
}
