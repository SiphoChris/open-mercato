import { expect, test } from '@playwright/test';
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api';
import { apiRequestWithSelectedOrg } from '@open-mercato/core/helpers/integration/authFixtures';
import {
  deleteGeneralEntityIfExists,
  expectId,
  getTokenContext,
  readJsonSafe,
} from '@open-mercato/core/helpers/integration/generalFixtures';

type AdminNavBody = {
  brand?: {
    name?: string;
    logo?: { src?: string; alt?: string; preserveAspectRatio?: boolean } | null;
  } | null;
  currentOrganization?: { id?: string; name?: string } | null;
};

type ApiRequestContext = Parameters<typeof apiRequest>[0];

async function createOrganization(request: ApiRequestContext, token: string, tenantId: string, name: string): Promise<string> {
  const response = await apiRequest(request, 'POST', '/api/directory/organizations', { token, data: { name, tenantId } });
  expect(response.status(), 'POST /api/directory/organizations should return 201').toBe(201);
  return expectId((await readJsonSafe<{ id?: string }>(response))?.id, 'Organization creation response should include id');
}

async function setLogo(request: ApiRequestContext, token: string, organizationId: string, logoUrl: string): Promise<void> {
  const response = await apiRequestWithSelectedOrg(request, 'PUT', '/api/directory/organization-branding', {
    token,
    selectedOrgId: organizationId,
    data: { logoUrl },
  });
  expect(response.status(), 'PUT /api/directory/organization-branding should return 200').toBe(200);
}

async function readNav(request: ApiRequestContext, token: string, tenantId: string, organizationId: string): Promise<AdminNavBody> {
  const response = await apiRequestWithSelectedOrg(
    request,
    'GET',
    `/api/auth/admin/nav?orgId=${encodeURIComponent(organizationId)}&tenantId=${encodeURIComponent(tenantId)}`,
    { token, selectedOrgId: organizationId },
  );
  expect(response.status(), 'GET /api/auth/admin/nav should return 200').toBe(200);
  return (await readJsonSafe<AdminNavBody>(response)) ?? {};
}

/**
 * TC-DIR-019: Backend nav brand through the default tenant branding provider
 * Source spec: .ai/specs/2026-10-05-tenant-branding-provider.md (G1, G8, G11)
 * Covers, with no tenant branding provider registered by the app:
 * - GET /api/auth/admin/nav: the `brand` comes from the selected organization's name and logo through
 *   `defaultTenantBrandingProvider`, on the first request and on a nav cache hit (the nav payload is
 *   cached without its brand, which is attached per request)
 * - PUT /api/directory/organization-branding: a logo change reaches the nav brand without waiting for
 *   a cache TTL (directory.organization.* invalidates the tenant's branding entries)
 * - an organization without a logo yields no brand, as before the provider existed
 */
test.describe('TC-DIR-019: Backend nav brand through the default tenant branding provider', () => {
  test('brands the nav payload from the organization logo, on cache misses and hits, and follows logo changes', async ({ request }) => {
    let token: string | null = null;
    let organizationId: string | null = null;
    const stamp = Date.now();
    const organizationName = `QA TC-DIR-019 ${stamp}`;
    const firstLogoUrl = `https://example.com/open-mercato/qa-default-provider-logo-a-${stamp}.svg`;
    const secondLogoUrl = `https://example.com/open-mercato/qa-default-provider-logo-b-${stamp}.svg`;

    try {
      token = await getAuthToken(request, 'superadmin');
      const { tenantId } = getTokenContext(token);
      organizationId = await createOrganization(request, token, tenantId, organizationName);
      const selectedOrganizationId = organizationId;
      const authToken = token;
      await setLogo(request, authToken, selectedOrganizationId, firstLogoUrl);

      const expectedBrand = (src: string) => ({
        name: organizationName,
        logo: { src, alt: `${organizationName} logo`, preserveAspectRatio: false },
      });
      const first = await readNav(request, authToken, tenantId, selectedOrganizationId);
      expect(first.brand, 'the default provider brands the nav payload from the organization').toEqual(expectedBrand(firstLogoUrl));
      const cached = await readNav(request, authToken, tenantId, selectedOrganizationId);
      expect(cached.brand, 'a nav cache hit carries the same brand').toEqual(expectedBrand(firstLogoUrl));

      await setLogo(request, authToken, selectedOrganizationId, secondLogoUrl);
      await expect.poll(async () => (await readNav(request, authToken, tenantId, selectedOrganizationId)).brand?.logo?.src ?? null, {
        message: 'the nav brand follows the changed logo without waiting for a cache TTL',
        timeout: 15_000,
      }).toBe(secondLogoUrl);
    } finally {
      await deleteGeneralEntityIfExists(request, token, '/api/directory/organizations', organizationId);
    }
  });

  test('yields no brand for an organization without a logo', async ({ request }) => {
    let token: string | null = null;
    let organizationId: string | null = null;
    const organizationName = `QA TC-DIR-019 no logo ${Date.now()}`;

    try {
      token = await getAuthToken(request, 'superadmin');
      const { tenantId } = getTokenContext(token);
      organizationId = await createOrganization(request, token, tenantId, organizationName);

      const nav = await readNav(request, token, tenantId, organizationId);
      expect(nav.brand ?? null, 'an organization without a logo yields no brand').toBeNull();
      expect(nav.currentOrganization?.id, 'the organization is still the one in scope').toBe(organizationId);
    } finally {
      await deleteGeneralEntityIfExists(request, token, '/api/directory/organizations', organizationId);
    }
  });
});
