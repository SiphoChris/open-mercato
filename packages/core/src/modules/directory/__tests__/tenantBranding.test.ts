/** @jest-environment node */

type MockLogger = { debug: jest.Mock; info: jest.Mock; warn: jest.Mock; error: jest.Mock; child: () => MockLogger }

jest.mock('@open-mercato/shared/lib/logger', () => {
  const actual = jest.requireActual('@open-mercato/shared/lib/logger')
  const logger: MockLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), child: () => logger }
  return { ...actual, createLogger: () => logger, mockedLogger: logger }
})

const mockLogger = (jest.requireMock('@open-mercato/shared/lib/logger') as { mockedLogger: MockLogger }).mockedLogger

const mockFindOneWithDecryption = jest.fn()

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: (...args: unknown[]) => mockFindOneWithDecryption(...args),
}))

import { createOrganizationTenantBrandingProvider } from '../lib/tenantBranding'
import { createCacheService, runWithCacheTenant } from '@open-mercato/cache'
import { resolveTenantBranding } from '@open-mercato/shared/lib/branding/resolveTenantBranding'
import { organizationLogoUrlSchema, toBackendChromeBrand } from '@open-mercato/shared/lib/branding/tenantBranding'
import { registerTelemetryRuntime, type TelemetryRuntime } from '@open-mercato/shared/lib/telemetry/runtime'

const TENANT_ID = '6f1c2f9e-3b0a-4f5e-9c1d-2a7b8c9d0e1f'
const ORG_ID = '11111111-2222-4333-8444-555555555555'
const OTHER_ORG_ID = '22222222-3333-4444-8555-666666666666'

const em = {} as never

beforeEach(() => {
  mockFindOneWithDecryption.mockReset()
})

describe('createOrganizationTenantBrandingProvider', () => {
  const provider = createOrganizationTenantBrandingProvider({ em })

  it('reproduces the organization logo brand of the backend chrome', async () => {
    mockFindOneWithDecryption.mockResolvedValue({
      id: ORG_ID,
      name: 'Northwind Ltd',
      logoUrl: '/api/attachments/image/abc',
      logoPreserveAspectRatio: true,
    })

    await expect(provider.resolve({ tenantId: TENANT_ID, organizationId: ORG_ID, host: null, surface: 'backend' })).resolves.toEqual({
      productName: 'Northwind Ltd',
      logos: {
        light: { src: '/api/attachments/image/abc', alt: 'Northwind Ltd logo', preserveAspectRatio: true },
      },
    })
    const [, , where, , scope] = mockFindOneWithDecryption.mock.calls[0]
    expect(where).toEqual({ id: ORG_ID, tenant: TENANT_ID, deletedAt: null })
    expect(scope).toEqual({ tenantId: TENANT_ID, organizationId: ORG_ID })
  })

  it('returns null for an organization without a logo', async () => {
    mockFindOneWithDecryption.mockResolvedValue({ id: ORG_ID, name: 'Northwind Ltd', logoUrl: null })
    await expect(provider.resolve({ tenantId: TENANT_ID, organizationId: ORG_ID, host: null, surface: 'backend' })).resolves.toBeNull()
  })

  it.each(['portal', 'auth'] as const)('keeps the platform default on the %s surface', async (surface) => {
    await expect(provider.resolve({ tenantId: TENANT_ID, organizationId: ORG_ID, host: null, surface })).resolves.toBeNull()
    expect(mockFindOneWithDecryption).not.toHaveBeenCalled()
  })

  it.each([
    ['a non-uuid organization cookie', TENANT_ID, 'not-a-uuid'],
    ['a non-uuid tenant', 'tenant-1', ORG_ID],
    ['the all-organizations sentinel', TENANT_ID, '__all__'],
  ])('never queries the database for %s', async (_label, tenantId, organizationId) => {
    await expect(provider.resolve({ tenantId, organizationId, host: null, surface: 'backend' })).resolves.toBeNull()
    expect(mockFindOneWithDecryption).not.toHaveBeenCalled()
  })

  it('needs both a tenant and an organization', async () => {
    await expect(provider.resolve({ tenantId: null, organizationId: ORG_ID, host: null, surface: 'backend' })).resolves.toBeNull()
    await expect(provider.resolve({ tenantId: TENANT_ID, organizationId: null, host: null, surface: 'backend' })).resolves.toBeNull()
    expect(mockFindOneWithDecryption).not.toHaveBeenCalled()
  })
})

const DIRECTORY_ACCEPTED_LOGO_URLS: Array<[string, string]> = [
  ['an underscore host', 'https://my_cdn.example.com/logo.png'],
  ['a trailing-dot host', 'https://cdn.example.com./logo.png'],
  ['credentials', 'https://user:pw@cdn.example.com/logo.png'],
  ['a leading-hyphen label', 'https://-cdn.example.com/logo.png'],
  ['an empty label', 'https://a..b.com/logo.png'],
  ['a 70-character label', `https://${'a'.repeat(70)}.example.com/logo.png`],
  ['a host with an asterisk', 'https://cdn*.example.com/logo.png'],
  ['a host with an exclamation mark', 'https://cdn!.example.com/logo.png'],
  ['a host with a dollar sign', 'https://cdn$.example.com/logo.png'],
  ['a host with a tilde', 'https://cdn~.example.com/logo.png'],
  ['a path with a tab', 'https://cdn.example.com/lo	go.png'],
  ['an http logo', 'http://legacy.example.com/logo.png'],
  ['an attachment logo with a query', '/api/attachments/image/abc?width=320&height=320'],
]

describe('default provider through the resolver', () => {
  function previousChromeBrand(organization: { name: string; logoUrl: string; logoPreserveAspectRatio?: boolean }) {
    return {
      name: organization.name,
      logo: {
        src: organization.logoUrl,
        alt: `${organization.name} logo`,
        preserveAspectRatio: !!organization.logoPreserveAspectRatio,
      },
    }
  }

  it.each([
    ['a preserved-aspect https logo', { name: 'Northwind Ltd', logoUrl: 'https://cdn.example.com/logo.png', logoPreserveAspectRatio: true }],
    ['a 500-character name', { name: 'N'.repeat(500), logoUrl: '/api/attachments/image/abc' }],
    ['an attachment file logo with a query', { name: 'Northwind Ltd', logoUrl: '/api/attachments/file/abc?width=320&height=320' }],
    ['a padded name and a url with a quote and a space', { name: '  Padded  ', logoUrl: "https://cdn.example.com/o'brien logo.png" }],
    ['markup in the name and a 2000-character url', { name: '<b>Acme</b> & Co', logoUrl: `https://cdn.example.com/${'x'.repeat(2000)}.svg` }],
    ...DIRECTORY_ACCEPTED_LOGO_URLS.map(([label, logoUrl]) => [label, { name: 'Northwind Ltd', logoUrl }] as [string, { name: string; logoUrl: string }]),
  ])('yields exactly the previous backend chrome brand for %s', async (_label, organization) => {
    expect(organizationLogoUrlSchema.safeParse(organization.logoUrl).success).toBe(true)
    mockFindOneWithDecryption.mockResolvedValue({ id: ORG_ID, ...organization })
    const defaultProvider = createOrganizationTenantBrandingProvider({ em })
    const container = {
      resolve: (name: string) => {
        if (name === 'tenantBrandingProvider' || name === 'defaultTenantBrandingProvider') return defaultProvider
        throw new Error(`[internal] not registered: ${name}`)
      },
    }
    const branding = await resolveTenantBranding(container, { tenantId: TENANT_ID, organizationId: ORG_ID, host: null, surface: 'backend' })
    expect(toBackendChromeBrand(branding)).toStrictEqual(previousChromeBrand(organization))
  })

  it.each(['', '   '])('keeps the logo but drops the blank organization name %j', async (name) => {
    mockFindOneWithDecryption.mockResolvedValue({ id: ORG_ID, name, logoUrl: '/api/attachments/image/abc' })
    const defaultProvider = createOrganizationTenantBrandingProvider({ em })
    const container = { resolve: () => defaultProvider }
    const branding = await resolveTenantBranding(container, { tenantId: TENANT_ID, organizationId: ORG_ID, host: null, surface: 'backend' })
    expect(toBackendChromeBrand(branding)).toStrictEqual({ name: undefined, logo: { src: '/api/attachments/image/abc', alt: `${name} logo`, preserveAspectRatio: false } })
  })
})

describe('two organizations of one tenant', () => {
  it('brands each organization on its own: an unrenderable legacy logo never blanks another organization', async () => {
    const reportError = jest.fn()
    const unregister = registerTelemetryRuntime({ reportError } as unknown as TelemetryRuntime)
    try {
      const rows: Record<string, { name: string; logoUrl: string }> = {
        [ORG_ID]: { name: 'Legacy Ltd', logoUrl: 'javascript:alert(1)' },
        [OTHER_ORG_ID]: { name: 'Northwind Ltd', logoUrl: 'https://my_cdn.example.com/logo.png' },
      }
      mockFindOneWithDecryption.mockImplementation(async (_em: unknown, _entity: unknown, where: { id: string }) => ({ id: where.id, ...rows[where.id] }))
      const cache = createCacheService({ strategy: 'memory' })
      const defaultProvider = createOrganizationTenantBrandingProvider({ em })
      const registrations: Record<string, unknown> = { cache, tenantBrandingProvider: defaultProvider, defaultTenantBrandingProvider: defaultProvider }
      const container = { hasRegistration: (name: string) => name in registrations, resolve: (name: string) => registrations[name] }

      for (let index = 0; index < 3; index += 1) {
        const legacy = await resolveTenantBranding(container, { tenantId: TENANT_ID, organizationId: ORG_ID, host: null, surface: 'backend' })
        expect(toBackendChromeBrand(legacy)).toBeNull()
        const valid = await resolveTenantBranding(container, { tenantId: TENANT_ID, organizationId: OTHER_ORG_ID, host: null, surface: 'backend' })
        expect(toBackendChromeBrand(valid)).toStrictEqual({
          name: 'Northwind Ltd',
          logo: { src: 'https://my_cdn.example.com/logo.png', alt: 'Northwind Ltd logo', preserveAspectRatio: false },
        })
      }
      const failureMarkers = await runWithCacheTenant(TENANT_ID, () => cache.keys('tenant-branding:provider-failed:*'))
      expect(failureMarkers).toEqual([])
      expect(reportError).not.toHaveBeenCalled()
      expect(mockLogger.warn).not.toHaveBeenCalled()
      expect(mockLogger.debug).toHaveBeenCalledWith('Tenant branding provider returned invalid fields; they were dropped', expect.objectContaining({ issues: ['logos.light'] }))
    } finally {
      unregister()
    }
  })
})
