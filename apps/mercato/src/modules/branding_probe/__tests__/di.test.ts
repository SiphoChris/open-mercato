import { asValue, createContainer } from 'awilix'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import type { TenantBrandingProvider } from '@open-mercato/shared/lib/branding/tenantBranding'

const mockFindOneWithDecryption = jest.fn()
jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: (...args: unknown[]) => mockFindOneWithDecryption(...args),
}))

jest.mock('@open-mercato/core/modules/directory/data/entities', () => ({
  Organization: class Organization {},
  Tenant: class Tenant {},
}))

import { register } from '../di'
import { GET as probeStatus } from '../api/status/route'
import { BRANDING_PROBE_NAME_PREFIX, brandingProbeBranding } from '../lib/provider'

const TENANT_ID = '6f1c2f9e-3b0a-4f5e-9c1d-2a7b8c9d0e1f'
const ORG_ID = '11111111-2222-4333-8444-555555555555'

function containerWithDefault(defaultProvider: TenantBrandingProvider): AppContainer {
  const container = createContainer()
  container.register({
    em: asValue({}),
    defaultTenantBrandingProvider: asValue(defaultProvider),
    tenantBrandingProvider: asValue(defaultProvider),
  })
  return container as unknown as AppContainer
}

const PROBE_ENV_KEYS = ['OM_TEST_BRANDING_PROBE_MODE', 'OM_INTEGRATION_TEST'] as const

describe('branding_probe DI', () => {
  const previous = Object.fromEntries(PROBE_ENV_KEYS.map((key) => [key, process.env[key]]))

  afterEach(() => {
    for (const key of PROBE_ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
    mockFindOneWithDecryption.mockReset()
  })

  it.each([
    ['nothing set', {}],
    ['only OM_INTEGRATION_TEST', { OM_INTEGRATION_TEST: 'true' }],
    ['a truthy value other than opt-in', { OM_TEST_BRANDING_PROBE_MODE: 'true' }],
    ['an upper-case opt-in', { OM_TEST_BRANDING_PROBE_MODE: 'OPT-IN' }],
  ])('leaves the default provider in place and hides the status route with %s', async (_label, env) => {
    for (const key of PROBE_ENV_KEYS) delete process.env[key]
    Object.assign(process.env, env)
    const defaultProvider: TenantBrandingProvider = { resolve: async () => null }
    const container = containerWithDefault(defaultProvider)
    register(container)
    expect(container.resolve('tenantBrandingProvider')).toBe(defaultProvider)
    expect((await probeStatus()).status).toBe(404)
  })

  it('brands probe records and delegates everything else when the runner opts in', async () => {
    delete process.env.OM_INTEGRATION_TEST
    process.env.OM_TEST_BRANDING_PROBE_MODE = 'opt-in'
    expect((await probeStatus()).status).toBe(200)
    const defaultProvider = { resolve: jest.fn(async () => null) }
    const container = containerWithDefault(defaultProvider)
    register(container)
    const provider = container.resolve<TenantBrandingProvider>('tenantBrandingProvider')
    expect(provider).not.toBe(defaultProvider)

    mockFindOneWithDecryption.mockResolvedValueOnce({ name: `${BRANDING_PROBE_NAME_PREFIX} 1` })
    await expect(provider.resolve({ tenantId: TENANT_ID, organizationId: null, host: null, surface: 'auth' })).resolves.toBe(brandingProbeBranding)

    mockFindOneWithDecryption.mockResolvedValueOnce({ name: 'Northwind Ltd' })
    await expect(provider.resolve({ tenantId: TENANT_ID, organizationId: ORG_ID, host: null, surface: 'backend' })).resolves.toBeNull()
    expect(defaultProvider.resolve).toHaveBeenCalledTimes(1)
  })
})
