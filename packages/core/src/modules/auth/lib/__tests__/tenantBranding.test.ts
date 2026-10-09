/** @jest-environment node */

const TENANT_ID = '6f1c2f9e-3b0a-4f5e-9c1d-2a7b8c9d0e1f'
const OTHER_TENANT_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const ORG_ID = '11111111-2222-4333-8444-555555555555'
const SELECTED_ORG_ID = '99999999-2222-4333-8444-555555555555'
const UNKNOWN_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c40'

const mockResolveFeatureCheckContext = jest.fn()
const mockGetSelectedOrganizationFromRequest = jest.fn()

jest.mock('@open-mercato/core/modules/directory/utils/organizationScope', () => ({
  resolveFeatureCheckContext: (...args: unknown[]) => mockResolveFeatureCheckContext(...args),
  getSelectedOrganizationFromRequest: (...args: unknown[]) => mockGetSelectedOrganizationFromRequest(...args),
}))

const mockFindOneWithDecryption = jest.fn()
jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: (...args: unknown[]) => mockFindOneWithDecryption(...args),
}))

const mockCreateRequestContainer = jest.fn()
const mockRegistrars: { current: object } = { current: [] }
jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: (...args: unknown[]) => mockCreateRequestContainer(...args),
  getDiRegistrars: () => mockRegistrars.current,
}))

import { createCacheService } from '@open-mercato/cache'
import { invalidateTenantBrandingCache } from '@open-mercato/shared/lib/branding/resolveTenantBranding'
import { registerTelemetryRuntime, type TelemetryRuntime } from '@open-mercato/shared/lib/telemetry/runtime'
import { createOrganizationTenantBrandingProvider } from '@open-mercato/core/modules/directory/lib/tenantBranding'
import onTenantChange from '@open-mercato/core/modules/directory/subscribers/invalidateTenantBrandingCacheOnTenantChange'
import {
  resolveBackendTenantBranding,
  resolveBrandOrganization,
  resolveLoginTenantBranding,
} from '../tenantBranding'

const em = {} as never
const acme = { productName: 'Acme', logos: { light: { src: '/brand/acme.svg' } } }
const organizationsByTenant: Record<string, string[]> = { [TENANT_ID]: [ORG_ID, SELECTED_ORG_ID] }

function containerWith(registrations: Record<string, unknown>) {
  const all: Record<string, unknown> = { em, ...registrations }
  return {
    hasRegistration: (name: string) => name in all,
    resolve: (name: string) => {
      if (name in all) return all[name]
      throw new Error(`[internal] not registered: ${name}`)
    },
  } as never
}

function builtInContainer() {
  const builtIn = createOrganizationTenantBrandingProvider({ em })
  return containerWith({ tenantBrandingProvider: builtIn, defaultTenantBrandingProvider: builtIn })
}

function organizationContainer(registrations: Record<string, unknown> = {}) {
  const all: Record<string, unknown> = { em: {}, ...registrations }
  return { resolve: (name: string) => all[name] }
}

type BrandOrganizationInput = {
  scoped?: string | null
  requested?: string | null
  own?: string | null
  allowed?: string[] | null
  tenantId?: string | null
  container?: ReturnType<typeof organizationContainer>
}

function brandOrganizationId({ scoped = null, requested = null, own = null, allowed = null, tenantId = TENANT_ID, container = organizationContainer() }: BrandOrganizationInput) {
  return resolveBrandOrganization({
    container,
    tenantId,
    scopedOrganizationId: scoped,
    requestedOrganizationId: requested,
    ownOrganizationId: own,
    allowedOrganizationIds: allowed,
  }).then((organization) => organization?.id ?? null)
}

function login(tenant?: string, container?: never) {
  return resolveLoginTenantBranding({ searchParams: tenant ? { tenant } : {}, container })
}

beforeEach(() => {
  jest.clearAllMocks()
  mockRegistrars.current = []
  mockCreateRequestContainer.mockRejectedValue(new Error('[internal] no database in unit tests'))
  mockGetSelectedOrganizationFromRequest.mockReturnValue(null)
  mockFindOneWithDecryption.mockImplementation(async (_em: unknown, _entity: unknown, where: { id?: string; tenant?: string }) => {
    if (where.tenant) return organizationsByTenant[where.tenant]?.includes(where.id ?? '') ? { id: where.id, name: 'Northwind Ltd' } : null
    return where.id === TENANT_ID ? { id: TENANT_ID } : null
  })
  mockResolveFeatureCheckContext.mockResolvedValue({
    organizationId: ORG_ID,
    scope: { selectedId: ORG_ID, filterIds: [ORG_ID], allowedIds: [ORG_ID], tenantId: TENANT_ID },
    allowedOrganizationIds: [ORG_ID],
  })
})

describe('resolveBrandOrganization', () => {
  it('loads the scoped organization, else the requested one, in the tenant', async () => {
    await expect(brandOrganizationId({ scoped: ORG_ID, requested: SELECTED_ORG_ID })).resolves.toBe(ORG_ID)
    await expect(brandOrganizationId({ requested: SELECTED_ORG_ID })).resolves.toBe(SELECTED_ORG_ID)
    const [, , where] = mockFindOneWithDecryption.mock.calls[0]
    expect(where).toEqual({ id: ORG_ID, tenant: TENANT_ID, deletedAt: null })
  })

  it('never pairs an organization with a tenant it does not belong to, scoped or not', async () => {
    await expect(brandOrganizationId({ scoped: ORG_ID, tenantId: OTHER_TENANT_ID })).resolves.toBeNull()
    await expect(brandOrganizationId({ requested: SELECTED_ORG_ID, tenantId: OTHER_TENANT_ID })).resolves.toBeNull()
    await expect(brandOrganizationId({ requested: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c40' })).resolves.toBeNull()
  })

  it('honours the organization access: a requested organization outside it falls back to the own organization, else to none', async () => {
    await expect(brandOrganizationId({ requested: SELECTED_ORG_ID, own: ORG_ID, allowed: [] })).resolves.toBeNull()
    await expect(brandOrganizationId({ requested: SELECTED_ORG_ID, own: ORG_ID, allowed: [ORG_ID] })).resolves.toBe(ORG_ID)
    await expect(brandOrganizationId({ requested: SELECTED_ORG_ID, own: ORG_ID, allowed: [SELECTED_ORG_ID] })).resolves.toBe(SELECTED_ORG_ID)
    await expect(brandOrganizationId({ requested: SELECTED_ORG_ID, own: ORG_ID, allowed: null })).resolves.toBe(SELECTED_ORG_ID)
  })

  it('ignores the all-organizations sentinel and never queries malformed ids', async () => {
    await expect(brandOrganizationId({ requested: '__all__' })).resolves.toBeNull()
    await expect(brandOrganizationId({ requested: 'not-a-uuid' })).resolves.toBeNull()
    await expect(brandOrganizationId({ scoped: ORG_ID, tenantId: null })).resolves.toBeNull()
    expect(mockFindOneWithDecryption).not.toHaveBeenCalled()
    await expect(brandOrganizationId({ scoped: "x' OR 1=1", requested: SELECTED_ORG_ID })).resolves.toBe(SELECTED_ORG_ID)
  })

  it('looks a verified organization up once per cache lifetime, and again after the tenant is invalidated', async () => {
    const container = organizationContainer({ cache: createCacheService({ strategy: 'memory' }) })
    for (let index = 0; index < 5; index += 1) {
      await expect(brandOrganizationId({ scoped: ORG_ID, container })).resolves.toBe(ORG_ID)
    }
    expect(mockFindOneWithDecryption).toHaveBeenCalledTimes(1)
    await invalidateTenantBrandingCache(container, TENANT_ID)
    await expect(brandOrganizationId({ scoped: ORG_ID, container })).resolves.toBe(ORG_ID)
    expect(mockFindOneWithDecryption).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['a rejecting read', { get: jest.fn(async () => { throw new Error('cache down') }), set: jest.fn(async () => undefined) }],
    ['a rejecting write', { get: jest.fn(async () => null), set: jest.fn(async () => { throw new Error('cache down') }) }],
  ])('keeps the verified organization and reports the cache fault on %s', async (_label, cache) => {
    const reportError = jest.fn()
    const unregister = registerTelemetryRuntime({ reportError } as unknown as TelemetryRuntime)
    try {
      await expect(brandOrganizationId({ scoped: ORG_ID, container: containerWith({ cache }) })).resolves.toBe(ORG_ID)
      expect(reportError).toHaveBeenCalledWith(expect.any(Error), { module: 'branding', code: 'branding.cache_failed' })
      expect(reportError).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ code: 'branding.organization_lookup_failed' }))
    } finally {
      unregister()
    }
  })

  it('falls back to no organization, and reports, when the lookup fails', async () => {
    const reportError = jest.fn()
    const unregister = registerTelemetryRuntime({ reportError } as unknown as TelemetryRuntime)
    try {
      mockFindOneWithDecryption.mockRejectedValue(new Error('database down'))
      await expect(brandOrganizationId({ scoped: ORG_ID })).resolves.toBeNull()
      expect(reportError).toHaveBeenCalledWith(expect.any(Error), { module: 'branding', code: 'branding.organization_lookup_failed' })
    } finally {
      unregister()
    }
  })
})

describe('resolveBackendTenantBranding', () => {
  it('passes the scoped tenant and organization to the provider', async () => {
    const provider = { varyByHost: true, resolve: jest.fn(async () => acme) }
    const branding = await resolveBackendTenantBranding({
      auth: { sub: 'user-1', tenantId: TENANT_ID, orgId: ORG_ID } as never,
      request: { cookies: { get: () => undefined } },
      host: 'acme.example.com',
      container: containerWith({ tenantBrandingProvider: provider }),
    })
    expect(branding).toEqual(acme)
    expect(provider.resolve).toHaveBeenCalledWith({ tenantId: TENANT_ID, organizationId: ORG_ID, host: 'acme.example.com', surface: 'backend' })
  })

  it("never pairs a super administrator's home organization with the tenant they view", async () => {
    mockResolveFeatureCheckContext.mockResolvedValue({
      organizationId: ORG_ID,
      scope: { selectedId: null, filterIds: null, allowedIds: null, tenantId: OTHER_TENANT_ID },
      allowedOrganizationIds: null,
    })
    const provider = { resolve: jest.fn(async () => acme) }
    await resolveBackendTenantBranding({ auth: { sub: 'user-1', tenantId: TENANT_ID, orgId: ORG_ID } as never, container: containerWith({ tenantBrandingProvider: provider }) })
    expect(provider.resolve).toHaveBeenCalledWith(expect.objectContaining({ tenantId: OTHER_TENANT_ID, organizationId: null }))
  })

  it("ignores a selected-organization cookie outside the caller's organization access", async () => {
    mockResolveFeatureCheckContext.mockResolvedValue({
      organizationId: null,
      scope: { selectedId: null, filterIds: [], allowedIds: [], tenantId: TENANT_ID },
      allowedOrganizationIds: [],
    })
    mockGetSelectedOrganizationFromRequest.mockReturnValue(SELECTED_ORG_ID)
    const provider = { resolve: jest.fn(async () => acme) }
    await resolveBackendTenantBranding({
      auth: { sub: 'user-1', tenantId: TENANT_ID, orgId: null } as never,
      request: { cookies: { get: () => undefined } },
      container: containerWith({ tenantBrandingProvider: provider }),
    })
    expect(provider.resolve).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT_ID, organizationId: null }))
  })

  it('is null without a session and when the container cannot be created', async () => {
    await expect(resolveBackendTenantBranding({ auth: null })).resolves.toBeNull()
    await expect(resolveBackendTenantBranding({ auth: { sub: 'user-1', tenantId: TENANT_ID, orgId: ORG_ID } as never })).resolves.toBeNull()
  })
})

describe('resolveLoginTenantBranding', () => {
  it('brands an existing tenant from the query or the cookie, without an organization or a host', async () => {
    const provider = { resolve: jest.fn(async () => acme) }
    const container = containerWith({ tenantBrandingProvider: provider })
    await expect(resolveLoginTenantBranding({ searchParams: { tenant: [TENANT_ID.toUpperCase(), 'x'] }, headers: new Headers({ host: 'Acme.Example.com' }), container })).resolves.toEqual(acme)
    expect(provider.resolve).toHaveBeenCalledWith({ tenantId: TENANT_ID, organizationId: null, host: null, surface: 'auth' })
    const cookies = { get: (name: string) => (name === 'om_login_tenant' ? { value: TENANT_ID } : undefined) }
    await resolveLoginTenantBranding({ cookies, container })
    expect(provider.resolve).toHaveBeenLastCalledWith(expect.objectContaining({ tenantId: TENANT_ID }))
  })

  it('passes the host only to providers that vary by host', async () => {
    const provider = { varyByHost: true, resolve: jest.fn(async () => acme) }
    await resolveLoginTenantBranding({ headers: new Headers({ host: 'Acme.Example.com' }), container: containerWith({ tenantBrandingProvider: provider }) })
    expect(provider.resolve).toHaveBeenCalledWith({ tenantId: null, organizationId: null, host: 'acme.example.com', surface: 'auth' })
  })

  it('never hands an unknown or malformed tenant id from the request to the provider', async () => {
    const provider = { resolve: jest.fn(async () => null) }
    const container = containerWith({ tenantBrandingProvider: provider })
    await expect(login(UNKNOWN_ID, container)).resolves.toBeNull()
    expect(provider.resolve).toHaveBeenCalledWith({ tenantId: null, organizationId: null, host: null, surface: 'auth' })
    mockFindOneWithDecryption.mockClear()
    await login("acme' OR 1=1", container)
    expect(mockFindOneWithDecryption).not.toHaveBeenCalled()
  })

  it('looks nothing up while only the built-in provider is active', async () => {
    await expect(login(TENANT_ID, builtInContainer())).resolves.toBeNull()
    expect(mockFindOneWithDecryption).not.toHaveBeenCalled()
  })

  it('creates a request container once, then none while only the built-in provider is active, until the registrars change', async () => {
    mockCreateRequestContainer.mockImplementation(async () => builtInContainer())
    for (let index = 0; index < 5; index += 1) await expect(login(TENANT_ID)).resolves.toBeNull()
    expect(mockCreateRequestContainer).toHaveBeenCalledTimes(1)
    mockRegistrars.current = []
    await login(TENANT_ID)
    expect(mockCreateRequestContainer).toHaveBeenCalledTimes(2)
  })

  it('remembers nothing after a failed container creation or a resolution that found no provider', async () => {
    mockCreateRequestContainer.mockRejectedValueOnce(new Error('[internal] database unavailable'))
    mockCreateRequestContainer.mockResolvedValueOnce({ resolve: () => undefined, hasRegistration: () => false })
    mockCreateRequestContainer.mockImplementation(async () => containerWith({ tenantBrandingProvider: { resolve: async () => acme } }))
    await expect(login(TENANT_ID)).resolves.toBeNull()
    await expect(login(TENANT_ID)).resolves.toBeNull()
    await expect(login(TENANT_ID)).resolves.toEqual(acme)
    expect(mockCreateRequestContainer).toHaveBeenCalledTimes(3)
  })

  it('creates a request container for every login render while a registered provider can brand login', async () => {
    mockCreateRequestContainer.mockImplementation(async () => containerWith({ tenantBrandingProvider: { resolve: async () => acme } }))
    for (let index = 0; index < 3; index += 1) await expect(login(TENANT_ID)).resolves.toEqual(acme)
    expect(mockCreateRequestContainer).toHaveBeenCalledTimes(3)
  })

  it('caches tenant existence for known tenants only', async () => {
    const container = containerWith({ tenantBrandingProvider: { resolve: jest.fn(async () => null) }, cache: createCacheService({ strategy: 'memory' }) })
    for (let index = 0; index < 3; index += 1) {
      await login(TENANT_ID, container)
      await login(UNKNOWN_ID, container)
    }
    const lookups = mockFindOneWithDecryption.mock.calls.map(([, , where]) => (where as { id: string }).id)
    expect(lookups.filter((id) => id === TENANT_ID)).toHaveLength(1)
    expect(lookups.filter((id) => id === UNKNOWN_ID)).toHaveLength(3)
  })

  it('stops branding login for a tenant once a tenant event drops its cached existence', async () => {
    const provider = { resolve: jest.fn(async () => null) }
    const cache = createCacheService({ strategy: 'memory' })
    const container = containerWith({ tenantBrandingProvider: provider, cache })
    await login(TENANT_ID, container)
    expect(provider.resolve).toHaveBeenLastCalledWith(expect.objectContaining({ tenantId: TENANT_ID }))
    mockFindOneWithDecryption.mockResolvedValue(null)
    await onTenantChange({ id: TENANT_ID, organizationId: null, tenantId: null }, { resolve: <T,>(name: string) => (name === 'cache' ? cache : null) as T })
    await login(TENANT_ID, container)
    expect(provider.resolve).toHaveBeenLastCalledWith(expect.objectContaining({ tenantId: null }))
    expect(mockFindOneWithDecryption).toHaveBeenCalledTimes(2)
  })
})
