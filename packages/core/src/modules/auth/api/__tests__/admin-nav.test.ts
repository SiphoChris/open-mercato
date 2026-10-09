/** @jest-environment node */
type MockLogger = { debug: jest.Mock; info: jest.Mock; warn: jest.Mock; error: jest.Mock; child: () => MockLogger }

jest.mock('@open-mercato/shared/lib/logger', () => {
  const actual = jest.requireActual('@open-mercato/shared/lib/logger')
  const logger: MockLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), child: () => logger }
  return { ...actual, createLogger: () => logger, mockedLogger: logger }
})

const mockLogger = (jest.requireMock('@open-mercato/shared/lib/logger') as { mockedLogger: MockLogger }).mockedLogger

import { GET } from '@open-mercato/core/modules/auth/api/admin/nav'
import * as backendChrome from '@open-mercato/core/modules/auth/lib/backendChrome'
import { createCacheService, runWithCacheTenant } from '@open-mercato/cache'
import type { TenantBranding } from '@open-mercato/shared/lib/branding/tenantBranding'

type AuthContext = {
  sub: string
  tenantId: string | null
  orgId: string | null
  roles: string[]
  isApiKey?: boolean
  userId?: string
}

type TranslationContext = {
  locale: string
  translate: (key: string, fallback?: string) => string
}

type BackendRouteManifest = {
  moduleId: string
  pattern: string
  title: string
  pageTitleKey?: string
  pageGroupKey?: string
  group?: string
  order?: number
}

type DynamicEntity = {
  entityId: string
  label: string
}

type SidebarItem = {
  href: string
  title: string
  defaultTitle: string
  enabled: boolean
  hidden?: boolean
  order?: number
  children?: SidebarItem[]
}

type SidebarGroup = {
  id: string
  name: string
  defaultName: string
  items: SidebarItem[]
}

const mockGetAuthFromRequest = jest.fn<Promise<AuthContext | null>, [Request]>()
const mockGetBackendRouteManifests = jest.fn<BackendRouteManifest[], []>()
const mockResolveTranslations = jest.fn<Promise<TranslationContext>, []>()
const mockEmFind = jest.fn<Promise<unknown[]>, [unknown, unknown, unknown?]>()
const mockGetEffectiveFeatures = jest.fn<Promise<string[]>, [string, { tenantId: string | null; organizationId: string | null }]>()
const mockUserHasAllFeatures = jest.fn<Promise<boolean>, [string, string[], { tenantId: string | null; organizationId: string | null }]>()
const mockCacheSet = jest.fn<Promise<void>, [string, unknown, { tags: string[]; ttl?: number }]>()
const mockCacheGet = jest.fn<Promise<unknown>, [string]>()
type MockBrandingProvider = {
  varyByHost?: boolean
  resolve: (input: { host: string | null }) => Promise<TenantBranding | null>
}
const mockTenantBrandingProvider: { current: MockBrandingProvider | null } = { current: null }

function lastNavCacheKeyRead(): string {
  const navKeys = mockCacheGet.mock.calls.map(([key]) => key).filter((key) => key.startsWith('nav:sidebar:'))
  return navKeys[navKeys.length - 1]
}
const mockApplySidebarPreference = jest.fn(<T extends SidebarGroup>(groups: T[]) => groups)
const mockFindSidebarPreference = jest.fn<Promise<null>, [unknown, { userId: string; tenantId: string | null; organizationId: string | null; locale: string }]>()
const mockLoadFirstRoleSidebarPreference = jest.fn<Promise<null>, [unknown, { roleIds: string[]; tenantId: string | null; locale: string }]>()
const mockResolveFeatureCheckContext = jest.fn<
  Promise<{ organizationId: string | null; scope: { tenantId: string | null; selectedId: string | null }; allowedOrganizationIds: string[] | null }>,
  [unknown]
>()
const mockGetSelectedOrganizationFromRequest = jest.fn<string | null, [Request]>()

jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromRequest: (req: Request) => mockGetAuthFromRequest(req),
}))

jest.mock('@open-mercato/shared/lib/i18n/server', () => ({
  resolveTranslations: () => mockResolveTranslations(),
}))

jest.mock('@open-mercato/shared/modules/registry', () => ({
  getBackendRouteManifests: () => mockGetBackendRouteManifests(),
}))

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: async () => ({
    resolve: (key: string) => {
      if (key === 'em') {
        return { find: mockEmFind }
      }
      if (key === 'rbacService') {
        return {
          getEffectiveFeatures: mockGetEffectiveFeatures,
          userHasAllFeatures: mockUserHasAllFeatures,
        }
      }
      if (key === 'cache') {
        return { get: mockCacheGet, set: mockCacheSet }
      }
      if (key === 'tenantBrandingProvider') return mockTenantBrandingProvider.current
      return null
    },
  }),
}))

jest.mock('@open-mercato/core/modules/auth/services/sidebarPreferencesService', () => ({
  applySidebarPreference: <T extends SidebarGroup>(groups: T[]) => mockApplySidebarPreference(groups),
  findSidebarPreference: (em: unknown, scope: { userId: string; tenantId: string | null; organizationId: string | null; locale: string }) =>
    mockFindSidebarPreference(em, scope),
  loadFirstRoleSidebarPreference: (em: unknown, scope: { roleIds: string[]; tenantId: string | null; locale: string }) =>
    mockLoadFirstRoleSidebarPreference(em, scope),
}))

const mockFindOneWithDecryption = jest.fn<Promise<unknown>, [unknown, unknown, { id?: string; tenant?: string }]>()

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  ...jest.requireActual('@open-mercato/shared/lib/encryption/find'),
  findOneWithDecryption: (em: unknown, entity: unknown, where: { id?: string; tenant?: string }) => mockFindOneWithDecryption(em, entity, where),
}))

jest.mock('@open-mercato/core/modules/directory/utils/organizationScope', () => ({
  getSelectedOrganizationFromRequest: (req: Request) => mockGetSelectedOrganizationFromRequest(req),
  resolveFeatureCheckContext: (args: unknown) => mockResolveFeatureCheckContext(args),
}))

function makeRequest() {
  return new Request('http://localhost/api/auth/admin/nav', { method: 'GET' })
}

function setupRoutesForUserEntities(pageGroupKey: string, additionalRoutes: BackendRouteManifest[] = []): void {
  mockGetBackendRouteManifests.mockReturnValue([
    {
      moduleId: 'entities',
      pattern: '/backend/entities/user',
      title: 'User Entities',
      pageTitleKey: 'entities.nav.userEntities',
      pageGroupKey,
      group: 'Data Designer',
      order: 10,
    },
    ...additionalRoutes,
  ])
}

function setupCustomEntities(entities: DynamicEntity[]): void {
  mockEmFind.mockResolvedValueOnce(entities as unknown[])
}

async function getGroupsFromResponse(): Promise<SidebarGroup[]> {
  const response = await GET(makeRequest())
  expect(response.status).toBe(200)
  const payload = (await response.json()) as { groups: SidebarGroup[] }
  return payload.groups
}

function findUserEntitiesItem(groups: SidebarGroup[]): SidebarItem | undefined {
  for (const group of groups) {
    const item = group.items.find((candidate) => candidate.href === '/backend/entities/user')
    if (item) return item
  }
  return undefined
}

describe('GET /api/auth/admin/nav', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetAuthFromRequest.mockResolvedValue({
      sub: 'user-1',
      tenantId: 'tenant-1',
      orgId: 'org-1',
      roles: [],
    })
    mockResolveTranslations.mockResolvedValue({
      locale: 'pl',
      translate: (_key: string, fallback?: string) => fallback ?? '',
    })
    mockGetEffectiveFeatures.mockResolvedValue([
      'auth.users.view',
      'customer_accounts.view',
    ])
    mockUserHasAllFeatures.mockResolvedValue(true)
    mockFindSidebarPreference.mockResolvedValue(null)
    mockLoadFirstRoleSidebarPreference.mockResolvedValue(null)
    mockCacheGet.mockResolvedValue(null)
    mockCacheSet.mockResolvedValue(undefined)
    mockGetSelectedOrganizationFromRequest.mockReturnValue(null)
    mockResolveFeatureCheckContext.mockResolvedValue({
      organizationId: 'org-1',
      scope: { tenantId: 'tenant-1', selectedId: 'org-1' },
      allowedOrganizationIds: ['org-1'],
    })
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('attaches dynamic user entity links for the new data-designer group layout', async () => {
    setupRoutesForUserEntities('settings.sections.dataDesigner')
    setupCustomEntities([{ entityId: 'contacts', label: 'Contacts' }])

    const groups = await getGroupsFromResponse()
    const anchor = findUserEntitiesItem(groups)

    expect(anchor).toBeDefined()
    expect(anchor?.children?.map((item) => item.href)).toContain('/backend/entities/user/contacts/records')
  })

  it('keeps legacy compatibility for entities.nav.group', async () => {
    setupRoutesForUserEntities('entities.nav.group')
    setupCustomEntities([{ entityId: 'accounts', label: 'Accounts' }])

    const groups = await getGroupsFromResponse()
    const anchor = findUserEntitiesItem(groups)

    expect(anchor).toBeDefined()
    expect(anchor?.children?.map((item) => item.href)).toContain('/backend/entities/user/accounts/records')
  })

  it('does not duplicate dynamic links when the same href already exists', async () => {
    setupRoutesForUserEntities('settings.sections.dataDesigner', [
      {
        moduleId: 'entities',
        pattern: '/backend/entities/user/orders/records',
        title: 'Orders Existing Link',
        pageGroupKey: 'settings.sections.dataDesigner',
        group: 'Data Designer',
        order: 11,
      },
    ])
    setupCustomEntities([{ entityId: 'orders', label: 'Orders Dynamic Link' }])

    const groups = await getGroupsFromResponse()
    const anchor = findUserEntitiesItem(groups)
    const matchingChildren = anchor?.children?.filter((item) => item.href === '/backend/entities/user/orders/records') ?? []

    expect(anchor).toBeDefined()
    expect(matchingChildren).toHaveLength(1)
  })

  it('returns navigation without throwing when the user entities anchor is missing', async () => {
    mockGetBackendRouteManifests.mockReturnValue([
      {
        moduleId: 'dashboard',
        pattern: '/backend/dashboard',
        title: 'Dashboard',
        group: 'Dashboard',
        order: 1,
      },
    ])
    setupCustomEntities([{ entityId: 'assets', label: 'Assets' }])

    const groups = await getGroupsFromResponse()
    const hrefs = groups.flatMap((group) => group.items.map((item) => item.href))

    expect(hrefs).toContain('/backend/dashboard')
    expect(hrefs).not.toContain('/backend/entities/user/assets/records')
  })

  it('includes customer portal settings routes from concrete effective features', async () => {
    mockGetEffectiveFeatures.mockResolvedValue(['customer_accounts.view'])
    mockGetBackendRouteManifests.mockReturnValue([
      {
        moduleId: 'customer_accounts',
        pattern: '/backend/customer_accounts/users',
        title: 'Users',
        pageGroupKey: 'customer_accounts.settings.section',
        group: 'Customer Portal',
        order: 1,
        requireFeatures: ['customer_accounts.view'],
      } as BackendRouteManifest & { requireFeatures: string[] },
    ])
    setupCustomEntities([])

    const groups = await getGroupsFromResponse()
    const customerPortalGroup = groups.find((group) => group.id === 'customer_accounts.settings.section')

    expect(customerPortalGroup?.items.map((item) => item.href)).toContain('/backend/customer_accounts/users')
  })

  it('builds grouped navigation from backend route manifests instead of full module registry', async () => {
    mockGetBackendRouteManifests.mockReturnValue([
      {
        moduleId: 'dashboard',
        pattern: '/backend/dashboard',
        title: 'Dashboard',
        group: 'Dashboard',
        order: 1,
      },
    ])
    setupCustomEntities([])

    const groups = await getGroupsFromResponse()

    expect(groups.find((group) => group.id === 'Dashboard')?.items.map((item) => item.href)).toContain('/backend/dashboard')
  })

  it('orders items inside a group by the declared pageOrder, not by module registration order', async () => {
    mockGetBackendRouteManifests.mockReturnValue([
      {
        moduleId: 'later_page',
        pattern: '/backend/later/page-b',
        title: 'Beta page',
        pageGroupKey: 'shared.nav.group',
        group: 'Shared',
        order: 71,
      },
      {
        moduleId: 'earlier_page',
        pattern: '/backend/earlier/page-a',
        title: 'Alpha page',
        pageGroupKey: 'shared.nav.group',
        group: 'Shared',
        order: 70,
      },
    ])
    setupCustomEntities([])

    const groups = await getGroupsFromResponse()
    const sharedGroup = groups.find((group) => group.id === 'shared.nav.group')

    expect(sharedGroup?.items.map((item) => item.href)).toEqual([
      '/backend/earlier/page-a',
      '/backend/later/page-b',
    ])
  })

  it('serializes the declared order on nav items and their children', async () => {
    mockGetBackendRouteManifests.mockReturnValue([
      {
        moduleId: 'wms',
        pattern: '/backend/wms',
        title: 'Warehouse',
        pageGroupKey: 'wms.nav.group',
        group: 'WMS',
        order: 95,
      },
      {
        moduleId: 'wms',
        pattern: '/backend/wms/zones',
        title: 'Zones',
        pageGroupKey: 'wms.nav.group',
        group: 'WMS',
        order: 120,
      },
      {
        moduleId: 'wms',
        pattern: '/backend/wms/inventory',
        title: 'Inventory',
        pageGroupKey: 'wms.nav.group',
        group: 'WMS',
        order: 100,
      },
    ])
    setupCustomEntities([])

    const groups = await getGroupsFromResponse()
    const warehouse = groups.find((group) => group.id === 'wms.nav.group')?.items[0]

    expect(warehouse?.order).toBe(95)
    expect(warehouse?.children?.map((child) => [child.href, child.order])).toEqual([
      ['/backend/wms/inventory', 100],
      ['/backend/wms/zones', 120],
    ])
  })

  it('serializes the weight it sorted by when pagePriority and pageOrder disagree', async () => {
    mockGetBackendRouteManifests.mockReturnValue([
      {
        moduleId: 'trailing_page',
        pattern: '/backend/trailing/page',
        title: 'Trailing page',
        pageGroupKey: 'shared.nav.group',
        group: 'Shared',
        order: 5,
        priority: 50,
      },
      {
        moduleId: 'leading_page',
        pattern: '/backend/leading/page',
        title: 'Leading page',
        pageGroupKey: 'shared.nav.group',
        group: 'Shared',
        order: 20,
        priority: 1,
      },
    ])
    setupCustomEntities([])

    const groups = await getGroupsFromResponse()
    const sharedItems = groups.find((group) => group.id === 'shared.nav.group')?.items

    expect(sharedItems?.map((item) => [item.href, item.order])).toEqual([
      ['/backend/leading/page', 1],
      ['/backend/trailing/page', 50],
    ])
  })

  it('returns the extended backend chrome payload fields for client hydration', async () => {
    mockGetAuthFromRequest.mockResolvedValue({
      sub: 'user-1',
      tenantId: 'tenant-1',
      orgId: 'org-1',
      roles: ['admin'],
    })
    mockGetEffectiveFeatures.mockResolvedValue([
      'customer_accounts.view',
      'auth.users.view',
    ])
    mockGetBackendRouteManifests.mockReturnValue([
      {
        moduleId: 'auth',
        pattern: '/backend/settings/auth/users',
        title: 'Users',
        pageGroupKey: 'auth.settings.section',
        group: 'Auth',
        order: 1,
        pageContext: 'settings',
      } as BackendRouteManifest & { pageContext: 'settings' },
    ])
    setupCustomEntities([])

    const response = await GET(makeRequest())
    expect(response.status).toBe(200)
    const payload = (await response.json()) as {
      settingsSections: Array<{ id: string; items: Array<{ href: string }> }>
      settingsPathPrefixes: string[]
      profileSections: Array<{ id: string }>
      profilePathPrefixes: string[]
      grantedFeatures: string[]
      roles: string[]
    }

    expect(payload.settingsSections[0]?.items.map((item) => item.href)).toContain('/backend/settings/auth/users')
    expect(payload.settingsPathPrefixes).toContain('/backend/settings/auth')
    expect(payload.profileSections.length).toBeGreaterThan(0)
    expect(payload.profilePathPrefixes).toContain('/backend/profile/')
    expect(payload.grantedFeatures).toEqual(expect.arrayContaining([
      'customer_accounts.view',
      'auth.users.view',
    ]))
    expect(payload.roles).toEqual(['admin'])
  })

  it('hydrates the backend chrome payload from concrete effective features', async () => {
    mockGetAuthFromRequest.mockResolvedValue({
      sub: 'user-1',
      tenantId: 'tenant-1',
      orgId: 'org-1',
      roles: ['admin'],
    })
    mockGetEffectiveFeatures.mockResolvedValue([
      'customer_accounts.view',
      'auth.users.view',
    ])
    mockGetBackendRouteManifests.mockReturnValue([
      {
        moduleId: 'auth',
        pattern: '/backend/settings/auth/users',
        title: 'Users',
        pageGroupKey: 'auth.settings.section',
        group: 'Auth',
        order: 1,
        pageContext: 'settings',
      } as BackendRouteManifest & { pageContext: 'settings' },
    ])
    setupCustomEntities([])

    const response = await GET(makeRequest())
    expect(response.status).toBe(200)
    const payload = (await response.json()) as { grantedFeatures: string[] }

    expect(payload.grantedFeatures).toEqual([
      'customer_accounts.view',
      'auth.users.view',
    ])
  })

  it('passes the request through every scope resolution during hydrated nav generation', async () => {
    mockGetBackendRouteManifests.mockReturnValue([
      {
        moduleId: 'dashboard',
        pattern: '/backend/dashboard',
        title: 'Dashboard',
        group: 'Dashboard',
        order: 1,
      },
    ])
    setupCustomEntities([])

    const request = makeRequest()
    const response = await GET(request)

    expect(response.status).toBe(200)
    expect(mockResolveFeatureCheckContext).toHaveBeenCalledTimes(2)
    for (const [callArgs] of mockResolveFeatureCheckContext.mock.calls) {
      expect(callArgs).toEqual(expect.objectContaining({ request }))
    }
  })

  it('uses a versioned cache key that distinguishes concrete and all-organization cookie selections', async () => {
    mockGetBackendRouteManifests.mockReturnValue([])
    mockResolveFeatureCheckContext.mockImplementation(async (args) => {
      const scopeArgs = args as { selectedId?: string | null; request?: Request }
      const cookieSelection = scopeArgs.request?.headers.get('cookie')?.match(/(?:^|;\s*)om_selected_org=([^;]+)/)?.[1]
      const requestedSelection = scopeArgs.selectedId === undefined
        ? cookieSelection ? decodeURIComponent(cookieSelection) : null
        : scopeArgs.selectedId
      return {
        organizationId: 'org-1',
        scope: {
          tenantId: 'tenant-1',
          selectedId: requestedSelection === '__all__' ? null : requestedSelection ?? 'org-1',
        },
        allowedOrganizationIds: ['org-1'],
      }
    })
    setupCustomEntities([])

    await GET(new Request('http://localhost/api/auth/admin/nav', {
      headers: { cookie: 'om_selected_org=org-1' },
    }))
    const concreteSelectionKey = lastNavCacheKeyRead()
    expect(concreteSelectionKey).toMatch(/^nav:sidebar:v7:[^:]+:pl:user-1:tenant-1:org-1:org-1$/)
    expect(concreteSelectionKey).not.toContain('nav:sidebar:v6:')

    mockCacheGet.mockClear()
    setupCustomEntities([])

    await GET(new Request('http://localhost/api/auth/admin/nav', {
      headers: { cookie: 'om_selected_org=__all__' },
    }))
    const allOrganizationsKey = lastNavCacheKeyRead()
    expect(allOrganizationsKey).toMatch(/^nav:sidebar:v7:[^:]+:pl:user-1:tenant-1:org-1:__all__$/)
    expect(allOrganizationsKey).not.toBe(concreteSelectionKey)
  })

  describe('brand outside the nav cache', () => {
    const TENANT_UUID = '6f1c2f9e-3b0a-4f5e-9c1d-2a7b8c9d0e1f'
    const ORG_UUID = '11111111-2222-4333-8444-555555555555'
    const acme: TenantBranding = { productName: 'Acme', logos: { light: { src: '/brand/acme.png' } } }
    let realCache = createCacheService({ strategy: 'memory' })

    beforeEach(() => {
      realCache = createCacheService({ strategy: 'memory' })
      mockCacheGet.mockImplementation((key) => realCache.get(key))
      mockCacheSet.mockImplementation(async (key, value, options) => { await realCache.set(key, value, options) })
      mockGetBackendRouteManifests.mockReturnValue([])
      mockEmFind.mockResolvedValue([])
      mockGetAuthFromRequest.mockResolvedValue({ sub: 'user-1', tenantId: TENANT_UUID, orgId: ORG_UUID, roles: [] })
      mockResolveFeatureCheckContext.mockResolvedValue({
        organizationId: ORG_UUID,
        scope: { tenantId: TENANT_UUID, selectedId: ORG_UUID },
        allowedOrganizationIds: [ORG_UUID],
      })
    })

    afterEach(() => {
      mockTenantBrandingProvider.current = null
    })

    async function brandAt(host: string): Promise<unknown> {
      const response = await GET(new Request('http://localhost/api/auth/admin/nav', { headers: { host } }))
      return ((await response.json()) as { brand: unknown }).brand
    }

    function clearBrandingEntries(): Promise<number> {
      return runWithCacheTenant(TENANT_UUID, () => realCache.deleteByTags([`tenant-branding:tenant:${TENANT_UUID}`]))
    }

    it('follows the branding resolver when a provider succeeds, fails and recovers, never serving a brand from the nav cache', async () => {
      let healthy = true
      mockTenantBrandingProvider.current = {
        resolve: async () => {
          if (!healthy) throw new Error('provider down')
          return acme
        },
      }
      await expect(brandAt('acme.example.com')).resolves.toEqual({ name: 'Acme', logo: { src: '/brand/acme.png' } })
      healthy = false
      await clearBrandingEntries()
      await expect(brandAt('acme.example.com')).resolves.toBeNull()
      healthy = true
      await clearBrandingEntries()
      await expect(brandAt('acme.example.com')).resolves.toEqual({ name: 'Acme', logo: { src: '/brand/acme.png' } })

      const navWrites = mockCacheSet.mock.calls.filter(([key]) => key.startsWith('nav:sidebar:'))
      expect(navWrites).toHaveLength(1)
      expect((navWrites[0][1] as { brand: unknown }).brand).toBeNull()
      expect(mockLogger.warn).toHaveBeenCalledWith('Tenant branding provider failed; falling back', expect.objectContaining({ surface: 'backend' }))
    })

    it("on a nav cache hit, never hands the provider a selected organization outside the caller's access", async () => {
      const INACCESSIBLE_ORG_UUID = '22222222-3333-4444-8555-666666666666'
      mockResolveFeatureCheckContext.mockResolvedValue({
        organizationId: null,
        scope: { tenantId: TENANT_UUID, selectedId: null, allowedIds: [] },
        allowedOrganizationIds: [],
      })
      mockGetSelectedOrganizationFromRequest.mockReturnValue(INACCESSIBLE_ORG_UUID)
      mockFindOneWithDecryption.mockImplementation(async (_em, _entity, where) => (
        where.tenant === TENANT_UUID && where.id === INACCESSIBLE_ORG_UUID ? { id: INACCESSIBLE_ORG_UUID, name: 'Restricted Ltd' } : null
      ))
      const resolveBrand = jest.fn(async (_input: { host: string | null }) => null)
      mockTenantBrandingProvider.current = { resolve: resolveBrand }

      await brandAt('acme.example.com')
      await clearBrandingEntries()
      await brandAt('acme.example.com')

      expect(mockCacheSet.mock.calls.filter(([key]) => key.startsWith('nav:sidebar:'))).toHaveLength(1)
      expect(resolveBrand).toHaveBeenLastCalledWith(expect.objectContaining({ tenantId: TENANT_UUID, organizationId: null }))
    })

    it('keeps one nav cache entry whatever hosts and brands a host-varying provider answers', async () => {
      mockTenantBrandingProvider.current = {
        varyByHost: true,
        resolve: async ({ host }) => (host === 'acme.example.com' ? acme : null),
      }
      await expect(brandAt('Acme.Example.com')).resolves.toEqual({ name: 'Acme', logo: { src: '/brand/acme.png' } })
      for (let index = 0; index < 20; index += 1) {
        await expect(brandAt(`random-${index}-${Math.random().toString(36).slice(2)}.example.com`)).resolves.toBeNull()
      }
      await expect(brandAt('acme.example.com')).resolves.toEqual({ name: 'Acme', logo: { src: '/brand/acme.png' } })
      expect(new Set(mockCacheGet.mock.calls.map(([key]) => key).filter((key) => key.startsWith('nav:sidebar:'))).size).toBe(1)
      expect(mockCacheSet.mock.calls.filter(([key]) => key.startsWith('nav:sidebar:'))).toHaveLength(1)
    })
  })

  it('uses per-feature RBAC checks for sidebar inclusion, not only the raw ACL snapshot', async () => {
    mockGetEffectiveFeatures.mockResolvedValue([])
    mockUserHasAllFeatures.mockImplementation(async (_userId, required) => {
      return required.every((feature) => feature === 'customer_accounts.view')
    })
    mockGetBackendRouteManifests.mockReturnValue([
      {
        moduleId: 'customer_accounts',
        pattern: '/backend/customer_accounts/users',
        title: 'Users',
        pageGroupKey: 'customer_accounts.settings.section',
        group: 'Customer Portal',
        order: 1,
        requireFeatures: ['customer_accounts.view'],
      } as BackendRouteManifest & { requireFeatures: string[] },
    ])
    setupCustomEntities([])

    const groups = await getGroupsFromResponse()
    const customerPortalGroup = groups.find((group) => group.id === 'customer_accounts.settings.section')

    expect(customerPortalGroup?.items.map((item) => item.href)).toContain('/backend/customer_accounts/users')
    expect(mockUserHasAllFeatures).toHaveBeenCalled()
  })

  describe('cache key survives a deploy that changes the module surface', () => {
    async function cacheKeyForRoutes(routes: BackendRouteManifest[]): Promise<string> {
      mockGetBackendRouteManifests.mockReturnValue(routes)
      setupCustomEntities([])
      const response = await GET(makeRequest())
      expect(response.status).toBe(200)
      const [key] = mockCacheSet.mock.calls[mockCacheSet.mock.calls.length - 1]
      return key
    }

    const dashboardRoute: BackendRouteManifest = {
      moduleId: 'dashboard',
      pattern: '/backend/dashboard',
      title: 'Dashboard',
      group: 'Dashboard',
      order: 1,
    }

    it('reads and writes the same key within one deploy', async () => {
      const writtenKey = await cacheKeyForRoutes([dashboardRoute])

      expect(mockCacheGet).toHaveBeenCalledWith(writtenKey)
    })

    it('writes a different key once a new module contributes backend routes', async () => {
      const before = await cacheKeyForRoutes([dashboardRoute])
      const after = await cacheKeyForRoutes([
        dashboardRoute,
        { moduleId: 'search', pattern: '/backend/search', title: 'Search', group: 'Search', order: 2 },
      ])

      expect(after).not.toBe(before)
    })

    it('bounds any surface change the fingerprint cannot see with a TTL', async () => {
      await cacheKeyForRoutes([dashboardRoute])

      const [, , options] = mockCacheSet.mock.calls[mockCacheSet.mock.calls.length - 1]
      expect(options.ttl).toBe(30 * 60 * 1000)
    })
  })

  it('returns 401 when not authenticated', async () => {
    mockGetAuthFromRequest.mockResolvedValue(null)
    const response = await GET(makeRequest())
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' })
  })

  describe('security: scope fallback when resolveFeatureCheckContext throws', () => {
    const minimalChromePayload = {
      groups: [],
      settingsSections: [],
      settingsPathPrefixes: [],
      profileSections: [],
      profilePathPrefixes: [],
      grantedFeatures: [],
      roles: [],
    }

    let resolveBackendChromePayloadSpy: jest.SpyInstance

    beforeEach(() => {
      mockGetBackendRouteManifests.mockReturnValue([])
      resolveBackendChromePayloadSpy = jest
        .spyOn(backendChrome, 'resolveBackendChromePayload')
        .mockResolvedValue(minimalChromePayload)
    })

    afterEach(() => {
      resolveBackendChromePayloadSpy.mockRestore()
    })

    it('resets attacker-supplied orgId and tenantId to auth values when scope resolution throws', async () => {
      mockResolveFeatureCheckContext.mockRejectedValueOnce(new Error('scope resolution failed'))

      const req = new Request(
        'http://localhost/api/auth/admin/nav?orgId=attacker-org&tenantId=attacker-tenant',
        { method: 'GET' },
      )
      const response = await GET(req)

      expect(response.status).toBe(200)
      expect(resolveBackendChromePayloadSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          selectedOrganizationId: 'org-1',
          selectedTenantId: 'tenant-1',
        }),
      )
    })

    it('never forwards attacker-controlled tenantId to chrome payload when scope resolution fails', async () => {
      mockResolveFeatureCheckContext.mockRejectedValueOnce(new Error('db timeout'))

      const req = new Request(
        'http://localhost/api/auth/admin/nav?orgId=any-org&tenantId=victim-tenant',
        { method: 'GET' },
      )
      await GET(req)

      expect(resolveBackendChromePayloadSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ selectedTenantId: 'victim-tenant' }),
      )
    })

    it('still returns a successful response after scope resolution failure', async () => {
      mockResolveFeatureCheckContext.mockRejectedValueOnce(new Error('network error'))

      const response = await GET(makeRequest())

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject(minimalChromePayload)
    })
  })
})
