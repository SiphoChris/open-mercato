import { expect, test, type Browser, type Page } from '@playwright/test';
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api';
import { login } from '@open-mercato/core/helpers/integration/auth';
import {
  deleteGeneralEntityIfExists,
  expectId,
  getTokenContext,
  readJsonSafe,
} from '@open-mercato/core/helpers/integration/generalFixtures';

const PROBE_PREFIX = 'QA TC-BRANDING-001';
const PRODUCT_NAME = 'QA Branded Workspace';
const LIGHT_ALT = 'QA branded light logo';
const DARK_ALT = 'QA branded dark logo';
const TENANT_STYLE_MARKER = 'id="om-tenant-brand-style"';
const PORTAL_LAYOUT_MARKER = 'data-portal-handle="page:portal:layout"';
const PROBE_LOGO_PRELOAD = /<link[^>]*rel="preload"[^>]*branding-probe=/;
const LIGHT_PRIMARY = '#124488';
const DARK_PRIMARY = '#aaccff';

async function readInitialDocument(page: Page, path: string): Promise<string> {
  const response = await page.goto(path, { waitUntil: 'domcontentloaded' });
  expect(response, `GET ${path} should return a document`).not.toBeNull();
  expect(response?.status(), `GET ${path} should render`).toBe(200);
  return response ? await response.text() : '';
}

async function readPrimaryToken(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--primary').trim().toLowerCase());
}

function visibleLogo(page: Page, alt: string) {
  return page.locator(`img[alt="${alt}"]:visible`);
}

async function expectBrandedSurface(page: Page, path: string, scheme: 'light' | 'dark'): Promise<void> {
  await page.emulateMedia({ colorScheme: scheme });
  const document = await readInitialDocument(page, path);
  expect(document, `${path} server-renders the tenant brand style`).toContain(TENANT_STYLE_MARKER);
  expect(document, `${path} server-renders the light logo`).toContain('branding-probe=light');
  expect(document, `${path} server-renders the dark logo`).toContain('branding-probe=dark');
  expect(document, `${path} preloads neither logo variant, so the hidden one is never fetched`).not.toMatch(PROBE_LOGO_PRELOAD);
  const shownAlt = scheme === 'dark' ? DARK_ALT : LIGHT_ALT;
  const hiddenAlt = scheme === 'dark' ? LIGHT_ALT : DARK_ALT;
  await expect(visibleLogo(page, shownAlt).first(), `${path} shows the ${scheme} logo`).toBeVisible();
  await expect(visibleLogo(page, hiddenAlt), `${path} shows no logo for the other scheme`).toHaveCount(0);
  await expect
    .poll(() => visibleLogo(page, shownAlt).first().evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0), {
      message: `${path} loads the ${scheme} logo`,
    })
    .toBe(true);
  expect(await readPrimaryToken(page), `${path} applies the tenant ${scheme} primary colour`).toBe(scheme === 'dark' ? DARK_PRIMARY : LIGHT_PRIMARY);
}

async function withAnonymousPage<T>(browser: Browser, run: (page: Page) => Promise<T>): Promise<T> {
  const context = await browser.newContext();
  try {
    return await run(await context.newPage());
  } finally {
    await context.close();
  }
}

/**
 * TC-BRANDING-001: A registered tenant branding provider brands every surface before first paint
 * Requires the monorepo-only branding_probe module and OM_TEST_BRANDING_PROBE_MODE=opt-in, which the
 * integration runner sets; it registers a
 * provider that brands tenants and organizations named with the probe prefix, using raster logos
 * with a query string. The spec skips when the probe is not registered (create-mercato-app
 * scaffolds do not ship the module).
 * Covers:
 * - GET /login?tenant=<id>: tenant style, light and dark logos and product name in the initial HTML;
 *   the logo matching the colour scheme is the visible one and loads
 * - GET /<org-slug>/portal: the same for the portal shell
 * - GET /backend with the probe organization selected: the same for the backend shell
 */
test.describe('TC-BRANDING-001: Registered tenant branding provider', () => {
  test('brands login, portal and backend in the initial document, in light and dark mode', async ({ browser, page, request }) => {
    test.setTimeout(120_000);
    const probe = await request.get('/api/branding_probe/status');
    test.skip(probe.status() === 404, 'branding_probe is not registered (expected outside the monorepo integration run)');

    let token: string | null = null;
    let tenantId: string | null = null;
    let organizationId: string | null = null;
    const stamp = Date.now();
    const slug = `qa-tc-branding-001-${stamp}`;

    try {
      token = await getAuthToken(request, 'superadmin');
      const { tenantId: ownTenantId } = getTokenContext(token);

      const tenantResponse = await apiRequest(request, 'POST', '/api/directory/tenants', {
        token,
        data: { name: `${PROBE_PREFIX} ${stamp}` },
      });
      expect(tenantResponse.status(), 'POST /api/directory/tenants should return 201').toBe(201);
      tenantId = expectId((await readJsonSafe<{ id?: string }>(tenantResponse))?.id, 'Tenant creation response should include id');

      const organizationResponse = await apiRequest(request, 'POST', '/api/directory/organizations', {
        token,
        data: { name: `${PROBE_PREFIX} ${stamp}`, slug, tenantId: ownTenantId },
      });
      expect(organizationResponse.status(), 'POST /api/directory/organizations should return 201').toBe(201);
      organizationId = expectId((await readJsonSafe<{ id?: string }>(organizationResponse))?.id, 'Organization creation response should include id');
      const selectedOrganizationId = organizationId;
      const brandedTenantId = tenantId;

      await withAnonymousPage(browser, async (anonymousPage) => {
        const loginPath = `/login?tenant=${encodeURIComponent(brandedTenantId)}`;
        await expectBrandedSurface(anonymousPage, loginPath, 'light');
        await expect(anonymousPage.getByRole('heading', { level: 1 })).toHaveText(PRODUCT_NAME);
        await expectBrandedSurface(anonymousPage, loginPath, 'dark');

        const portalPath = `/${slug}/portal`;
        const portalDocument = await readInitialDocument(anonymousPage, portalPath);
        expect(portalDocument, 'the portal layout renders for the probe organization').toContain(PORTAL_LAYOUT_MARKER);
        await expectBrandedSurface(anonymousPage, portalPath, 'light');
        await expectBrandedSurface(anonymousPage, portalPath, 'dark');
      });

      await withAnonymousPage(browser, async (anonymousPage) => {
        const unbrandedLogin = await readInitialDocument(anonymousPage, '/login');
        expect(unbrandedLogin, 'a login without a tenant keeps the platform branding').not.toContain(TENANT_STYLE_MARKER);
        expect(unbrandedLogin).not.toContain(PRODUCT_NAME);
      });

      await login(page, 'superadmin');
      await page.context().addCookies([{ name: 'om_selected_org', value: selectedOrganizationId, url: page.url() }]);
      await expectBrandedSurface(page, '/backend', 'light');
      await expect(page.getByText(PRODUCT_NAME, { exact: true }).locator('visible=true').first()).toBeVisible();
      await expectBrandedSurface(page, '/backend', 'dark');
    } finally {
      await deleteGeneralEntityIfExists(request, token, '/api/directory/organizations', organizationId);
      await deleteGeneralEntityIfExists(request, token, '/api/directory/tenants', tenantId);
    }
  });
});
