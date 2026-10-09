import { expect, test, type Page } from '@playwright/test';
import { apiRequest, getAuthToken, withCredentialIsolatedRequest } from '@open-mercato/core/helpers/integration/api';
import { login } from '@open-mercato/core/helpers/integration/auth';
import { apiRequestWithSelectedOrg } from '@open-mercato/core/helpers/integration/authFixtures';
import {
  deleteGeneralEntityIfExists,
  expectId,
  getTokenContext,
  readJsonSafe,
} from '@open-mercato/core/helpers/integration/generalFixtures';

type AdminNavBody = {
  brand?: {
    logo?: { src?: string } | null;
  } | null;
};

async function readBackendDocument(page: Page): Promise<string> {
  const response = await page.goto('/backend', { waitUntil: 'commit' });
  expect(response, 'GET /backend should return a document').not.toBeNull();
  return response ? await response.text() : '';
}

/**
 * TC-DIR-020: Tenant branding resolved before first paint
 * Covers:
 * - default tenant branding provider: the selected organization logo is part of the server-rendered
 *   /backend document, not only of the client-fetched GET /api/auth/admin/nav payload
 * - cache invalidation: a logo change through PUT /api/directory/organization-branding reaches both the
 *   server-rendered document and the admin nav payload without waiting for a cache TTL
 * - default auth surface: GET /login keeps the platform logo and renders no tenant brand style
 */
test.describe('TC-DIR-020: Tenant branding before first paint', () => {
  test('server-renders the organization logo and follows logo changes', async ({ page, request }) => {
    test.setTimeout(120_000);
    let token: string | null = null;
    let organizationId: string | null = null;
    const stamp = Date.now();
    const firstLogoUrl = `https://example.com/open-mercato/qa-first-paint-logo-a-${stamp}.svg`;
    const secondLogoUrl = `https://example.com/open-mercato/qa-first-paint-logo-b-${stamp}.svg`;

    try {
      token = await getAuthToken(request, 'superadmin');
      const { tenantId } = getTokenContext(token);

      const createResponse = await apiRequest(request, 'POST', '/api/directory/organizations', {
        token,
        data: { name: `QA TC-DIR-020 ${stamp}`, tenantId },
      });
      expect(createResponse.status(), 'POST /api/directory/organizations should return 201').toBe(201);
      organizationId = expectId(
        (await readJsonSafe<{ id?: string }>(createResponse))?.id,
        'Organization creation response should include id',
      );
      const selectedOrgId = organizationId;

      const firstUpdate = await apiRequestWithSelectedOrg(request, 'PUT', '/api/directory/organization-branding', {
        token,
        selectedOrgId,
        data: { logoUrl: firstLogoUrl },
      });
      expect(firstUpdate.status(), 'PUT /api/directory/organization-branding should return 200').toBe(200);

      await login(page, 'superadmin');
      await page.context().addCookies([{ name: 'om_selected_org', value: selectedOrgId, url: page.url() }]);

      const firstDocument = await readBackendDocument(page);
      expect(firstDocument, 'the selected organization logo is server-rendered').toContain(firstLogoUrl);
      expect(firstDocument, 'the default provider emits no tenant brand style').not.toContain('id="om-tenant-brand-style"');

      const secondUpdate = await apiRequestWithSelectedOrg(request, 'PUT', '/api/directory/organization-branding', {
        token,
        selectedOrgId,
        data: { logoUrl: secondLogoUrl },
      });
      expect(secondUpdate.status(), 'PUT /api/directory/organization-branding should return 200').toBe(200);

      await expect
        .poll(async () => {
          const document = await readBackendDocument(page);
          return document.includes(secondLogoUrl) && !document.includes(firstLogoUrl);
        }, { message: 'the changed logo replaces the cached one in the server-rendered document', timeout: 15_000 })
        .toBe(true);

      await expect
        .poll(async () => {
          const navResponse = await apiRequestWithSelectedOrg(request, 'GET', '/api/auth/admin/nav', { token: token ?? '', selectedOrgId });
          const navBody = await readJsonSafe<AdminNavBody>(navResponse);
          return navBody?.brand?.logo?.src ?? null;
        }, { message: 'the admin nav brand follows the changed logo', timeout: 15_000 })
        .toBe(secondLogoUrl);

      await withCredentialIsolatedRequest(async (anonymousRequest) => {
        const loginResponse = await anonymousRequest.get(`/login?tenant=${encodeURIComponent(tenantId)}`);
        expect(loginResponse.status(), 'GET /login should return 200').toBe(200);
        const loginDocument = await loginResponse.text();
        expect(loginDocument).toContain('open-mercato.svg');
        expect(loginDocument).not.toContain('id="om-tenant-brand-style"');
      });
    } finally {
      await deleteGeneralEntityIfExists(request, token, '/api/directory/organizations', organizationId);
    }
  });
});
