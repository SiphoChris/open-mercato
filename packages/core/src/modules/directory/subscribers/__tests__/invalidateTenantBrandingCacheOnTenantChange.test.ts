type MockLogger = { debug: jest.Mock; info: jest.Mock; warn: jest.Mock; error: jest.Mock; child: () => MockLogger }

jest.mock('@open-mercato/shared/lib/logger', () => {
  const actual = jest.requireActual('@open-mercato/shared/lib/logger')
  const logger: MockLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), child: () => logger }
  return { ...actual, createLogger: () => logger, mockedLogger: logger }
})

const mockLogger = (jest.requireMock('@open-mercato/shared/lib/logger') as { mockedLogger: MockLogger }).mockedLogger

import handler, { metadata } from '@open-mercato/core/modules/directory/subscribers/invalidateTenantBrandingCacheOnTenantChange'
import { getCurrentCacheTenant } from '@open-mercato/cache'

function makeCtx(cache: { deleteByTags: jest.Mock } | null) {
  return {
    resolve: <T = unknown>(name: string): T => {
      if (name === 'cache' && cache) return { get: jest.fn(), set: jest.fn(), ...cache } as unknown as T
      throw new Error(`[internal] unexpected DI key: ${name}`)
    },
  }
}

describe('directory/invalidateTenantBrandingCacheOnTenantChange subscriber', () => {
  it('listens to every tenant mutation', () => {
    expect(metadata).toEqual({
      event: 'directory.tenant.*',
      persistent: false,
      id: 'directory:invalidate-tenant-branding-cache-on-tenant-change',
    })
  })

  it('drops the changed tenant entries, read from the tenant event id', async () => {
    const calls: Array<{ tenant: string | null; tags: string[] }> = []
    const deleteByTags = jest.fn(async (tags: string[]) => {
      calls.push({ tenant: getCurrentCacheTenant(), tags })
      return 1
    })
    await handler({ id: 'tenant-123', organizationId: null, tenantId: null }, makeCtx({ deleteByTags }))
    expect(calls).toEqual([
      { tenant: 'tenant-123', tags: ['tenant-branding:tenant:tenant-123'] },
      { tenant: null, tags: ['tenant-branding:tenant:global'] },
    ])
  })

  it('ignores payloads without a tenant and a missing or failing cache', async () => {
    const deleteByTags = jest.fn(async () => { throw new Error('down') })
    await handler({ organizationId: null, tenantId: null }, makeCtx({ deleteByTags }))
    expect(deleteByTags).not.toHaveBeenCalled()
    await expect(handler({ id: 'tenant-123' }, makeCtx(null))).resolves.toBeUndefined()
    await expect(handler({ id: 'tenant-123' }, makeCtx({ deleteByTags }))).resolves.toBeUndefined()
    expect(mockLogger.warn).toHaveBeenCalledWith('Tenant branding cache invalidation failed', expect.objectContaining({ err: expect.any(Error) }))
  })
})
