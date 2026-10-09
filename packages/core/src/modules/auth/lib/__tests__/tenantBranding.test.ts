/** @jest-environment node */

const TENANT_ID = '6f1c2f9e-3b0a-4f5e-9c1d-2a7b8c9d0e1f'
const OTHER_TENANT_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const ORG_ID = '11111111-2222-4333-8444-555555555555'
const SELECTED_ORG_ID = '99999999-2222-4333-8444-555555555555'

const mockFindOneWithDecryption = jest.fn()
jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: (...args: unknown[]) => mockFindOneWithDecryption(...args),
}))

import { createCacheService } from '@open-mercato/cache'
import { invalidateTenantBrandingCache } from '@open-mercato/shared/lib/branding/resolveTenantBranding'
import { registerTelemetryRuntime, type TelemetryRuntime } from '@open-mercato/shared/lib/telemetry/runtime'
import { resolveBrandOrganization } from '../tenantBranding'

const organizationsByTenant: Record<string, string[]> = { [TENANT_ID]: [ORG_ID, SELECTED_ORG_ID] }

function containerWith(registrations: Record<string, unknown> = {}) {
  const all: Record<string, unknown> = { em: {}, ...registrations }
  return { resolve: (name: string) => all[name] }
}

type BrandOrganizationInput = {
  scoped?: string | null
  requested?: string | null
  own?: string | null
  allowed?: string[] | null
  tenantId?: string | null
  container?: ReturnType<typeof containerWith>
}

function brandOrganizationId({ scoped = null, requested = null, own = null, allowed = null, tenantId = TENANT_ID, container = containerWith() }: BrandOrganizationInput) {
  return resolveBrandOrganization({
    container,
    tenantId,
    scopedOrganizationId: scoped,
    requestedOrganizationId: requested,
    ownOrganizationId: own,
    allowedOrganizationIds: allowed,
  }).then((organization) => organization?.id ?? null)
}

beforeEach(() => {
  mockFindOneWithDecryption.mockReset()
  mockFindOneWithDecryption.mockImplementation(async (_em: unknown, _entity: unknown, where: { id: string; tenant: string }) => (
    organizationsByTenant[where.tenant]?.includes(where.id) ? { id: where.id, name: 'Northwind Ltd' } : null
  ))
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
    const container = containerWith({ cache: createCacheService({ strategy: 'memory' }) })
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
