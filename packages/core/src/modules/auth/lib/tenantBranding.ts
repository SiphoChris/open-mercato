import type { AwilixContainer } from 'awilix'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { AuthContext } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer, getDiRegistrars } from '@open-mercato/shared/lib/di/container'
import { getTelemetryRuntime } from '@open-mercato/shared/lib/telemetry/runtime'
import { runWithCacheTenant } from '@open-mercato/cache'
import {
  buildTenantBrandingCacheTag,
  readTenantBrandingHost,
  resolveTenantBranding,
  type TenantBrandingContainer,
} from '@open-mercato/shared/lib/branding/resolveTenantBranding'
import {
  DEFAULT_TENANT_BRANDING_PROVIDER_DI_KEY,
  TENANT_BRANDING_PROVIDER_DI_KEY,
  type TenantBranding,
} from '@open-mercato/shared/lib/branding/tenantBranding'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import {
  getSelectedOrganizationFromRequest,
  resolveFeatureCheckContext,
} from '@open-mercato/core/modules/directory/utils/organizationScope'
import { isAllOrganizationsSelection } from '@open-mercato/core/modules/directory/constants'
import { Organization, Tenant } from '@open-mercato/core/modules/directory/data/entities'
import { isTenantBrandingUuid } from '@open-mercato/core/modules/directory/lib/tenantBranding'

type ScopeRequest = Parameters<typeof getSelectedOrganizationFromRequest>[0]
type HeaderReader = { get(name: string): string | null }
type CookieReader = { get(name: string): { value: string } | undefined }
type SearchParamsRecord = Record<string, string | string[] | undefined>
type BrandingCache = {
  get: (key: string) => Promise<unknown>
  set: (key: string, value: unknown, options?: { ttl?: number; tags?: string[] }) => Promise<unknown>
}

const LOGIN_TENANT_COOKIE = 'om_login_tenant'
const BRANDING_CACHE_TTL_MS = 5 * 60 * 1000
const registrarsWithoutLoginBranding = new WeakSet<object>()

export type BrandOrganization = { id: string; name: string }

function optionalCache(container: TenantBrandingContainer | AwilixContainer): BrandingCache | null {
  try {
    const cache = container.resolve('cache') as Partial<BrandingCache> | null | undefined
    return cache && typeof cache.get === 'function' && typeof cache.set === 'function' ? cache as BrandingCache : null
  } catch {
    return null
  }
}

function isBrandOrganization(value: unknown): value is BrandOrganization {
  return Boolean(value) && typeof (value as BrandOrganization).id === 'string' && typeof (value as BrandOrganization).name === 'string'
}

function pickOrganizationId({
  scopedOrganizationId,
  requestedOrganizationId,
  ownOrganizationId,
  allowedOrganizationIds,
}: {
  scopedOrganizationId: string | null
  requestedOrganizationId: string | null
  ownOrganizationId: string | null
  allowedOrganizationIds: string[] | null
}): string | null {
  if (isTenantBrandingUuid(scopedOrganizationId)) return scopedOrganizationId
  if (requestedOrganizationId && isAllOrganizationsSelection(requestedOrganizationId)) return null
  const usable = (id: string | null): id is string => isTenantBrandingUuid(id)
    && (allowedOrganizationIds === null || allowedOrganizationIds.includes(id))
  if (usable(requestedOrganizationId)) return requestedOrganizationId
  return usable(ownOrganizationId) ? ownOrganizationId : null
}

/**
 * The organization the backend brand is resolved for: the scoped organization, else the requested
 * (cookie or query) organization, else the caller's own — each fallback only when the caller's
 * organization access allows it (`allowedOrganizationIds`, `null` meaning every organization) — and
 * only when it belongs to the tenant. A super administrator's home organization while viewing another
 * tenant, an organization the caller may not access, or a client-chosen id never reaches a provider
 * or a cache key. Verified organizations are cached per tenant under the tenant branding tag, so an
 * organization change drops them. Every backend surface uses it, so they agree with
 * `/api/auth/admin/nav`.
 */
export async function resolveBrandOrganization({
  container,
  tenantId,
  scopedOrganizationId,
  requestedOrganizationId,
  ownOrganizationId,
  allowedOrganizationIds,
}: {
  container: TenantBrandingContainer
  tenantId: string | null
  scopedOrganizationId: string | null
  requestedOrganizationId: string | null
  ownOrganizationId: string | null
  allowedOrganizationIds: string[] | null
}): Promise<BrandOrganization | null> {
  const organizationId = pickOrganizationId({ scopedOrganizationId, requestedOrganizationId, ownOrganizationId, allowedOrganizationIds })
  if (!organizationId || !isTenantBrandingUuid(tenantId)) return null
  const cache = optionalCache(container)
  const key = `tenant-branding:organization:${organizationId}`
  try {
    const cached = cache ? await runWithCacheTenant(tenantId, () => cache.get(key)) : null
    if (isBrandOrganization(cached)) return cached
  } catch (err) {
    getTelemetryRuntime()?.reportError(err, { module: 'branding', code: 'branding.cache_failed' })
  }
  let brandOrganization: BrandOrganization
  try {
    const em = container.resolve('em') as EntityManager
    const organization = await findOneWithDecryption(em, Organization, { id: organizationId, tenant: tenantId, deletedAt: null }, undefined, { tenantId, organizationId })
    if (!organization) return null
    brandOrganization = { id: String(organization.id), name: organization.name }
  } catch (err) {
    getTelemetryRuntime()?.reportError(err, { module: 'branding', code: 'branding.organization_lookup_failed' })
    return null
  }
  try {
    if (cache) await runWithCacheTenant(tenantId, () => cache.set(key, brandOrganization, { ttl: BRANDING_CACHE_TTL_MS, tags: [buildTenantBrandingCacheTag(tenantId)] }))
  } catch (err) {
    getTelemetryRuntime()?.reportError(err, { module: 'branding', code: 'branding.cache_failed' })
  }
  return brandOrganization
}

/**
 * Backend shell branding for the organization the request is scoped to — the same scope the
 * backend chrome (`/api/auth/admin/nav`) resolves, so the server-rendered brand and the chrome brand
 * agree. Returns `null` (platform default) on any failure.
 */
export async function resolveBackendTenantBranding({
  auth,
  request,
  host,
  container,
}: {
  auth: AuthContext | null | undefined
  request?: ScopeRequest
  host?: string | null
  container?: AwilixContainer
}): Promise<TenantBranding | null> {
  if (!auth) return null
  try {
    const scopedContainer = container ?? await createRequestContainer()
    let scopedOrganizationId: string | null = auth.orgId ?? null
    let scopedTenantId: string | null = auth.tenantId ?? null
    let allowedOrganizationIds: string[] | null = auth.orgId ? [auth.orgId] : []
    try {
      const context = await resolveFeatureCheckContext({ container: scopedContainer, auth, request })
      scopedOrganizationId = context.organizationId
      scopedTenantId = context.scope.tenantId ?? auth.tenantId ?? null
      allowedOrganizationIds = context.scope.allowedIds
    } catch {
      scopedOrganizationId = auth.orgId ?? null
      scopedTenantId = auth.tenantId ?? null
    }
    const organization = await resolveBrandOrganization({
      container: scopedContainer,
      tenantId: scopedTenantId,
      scopedOrganizationId,
      requestedOrganizationId: request ? getSelectedOrganizationFromRequest(request) : null,
      ownOrganizationId: auth.orgId ?? null,
      allowedOrganizationIds,
    })
    return await resolveTenantBranding(scopedContainer, {
      tenantId: scopedTenantId,
      organizationId: organization?.id ?? null,
      host: host ?? null,
      surface: 'backend',
    })
  } catch (err) {
    getTelemetryRuntime()?.reportError(err, { module: 'branding', code: 'branding.resolve_failed' })
    return null
  }
}

function firstValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null
  return typeof value === 'string' ? value : null
}

function readLoginTenantId(searchParams: SearchParamsRecord | null | undefined, cookies: CookieReader | null | undefined): string | null {
  const candidate = (firstValue(searchParams?.tenant) ?? '').trim() || (cookies?.get(LOGIN_TENANT_COOKIE)?.value ?? '').trim()
  return isTenantBrandingUuid(candidate) ? candidate.toLowerCase() : null
}

/**
 * Whether a login tenant id names an existing tenant. Only positive answers are cached (bounded by
 * the number of tenants), so random ids from anonymous visitors never create cache entries.
 */
async function findExistingTenantId(container: AwilixContainer, tenantId: string): Promise<string | null> {
  const cache = optionalCache(container)
  const key = `tenant-branding:tenant-exists:${tenantId}`
  try {
    if (cache && await runWithCacheTenant(tenantId, () => cache.get(key))) return tenantId
  } catch (err) {
    getTelemetryRuntime()?.reportError(err, { module: 'branding', code: 'branding.cache_failed' })
  }
  const em = container.resolve('em') as EntityManager
  const tenant = await findOneWithDecryption(em, Tenant, { id: tenantId, deletedAt: null }, undefined, { tenantId, organizationId: null })
  if (!tenant) return null
  try {
    if (cache) await runWithCacheTenant(tenantId, () => cache.set(key, true, { ttl: BRANDING_CACHE_TTL_MS, tags: [buildTenantBrandingCacheTag(tenantId)] }))
  } catch (err) {
    getTelemetryRuntime()?.reportError(err, { module: 'branding', code: 'branding.cache_failed' })
  }
  return tenantId
}

/**
 * Only the built-in default is active: both keys resolve to the same provider, and the default never
 * brands login. Anything short of two successful resolutions is not taken as that answer.
 */
function nothingBrandsLogin(container: AwilixContainer): boolean {
  try {
    const active = container.resolve(TENANT_BRANDING_PROVIDER_DI_KEY) as { resolve?: unknown } | null | undefined
    return typeof active?.resolve === 'function' && active === container.resolve(DEFAULT_TENANT_BRANDING_PROVIDER_DI_KEY)
  } catch {
    return false
  }
}

function currentRegistrars(): object | null {
  try {
    return getDiRegistrars()
  } catch {
    return null
  }
}

/**
 * The container to brand login with, or `null` when nothing can brand it. Registrations are fixed
 * for a set of DI registrars, so once a container showed that only the built-in provider is active,
 * later renders skip creating one until the registrars change (for example a reload).
 */
async function loginBrandingContainer(container: AwilixContainer | undefined): Promise<AwilixContainer | null> {
  if (container) return nothingBrandsLogin(container) ? null : container
  const registrars = currentRegistrars()
  if (registrars && registrarsWithoutLoginBranding.has(registrars)) return null
  const created = await createRequestContainer()
  if (!nothingBrandsLogin(created)) return created
  if (registrars) registrarsWithoutLoginBranding.add(registrars)
  return null
}

/**
 * Login page branding. The tenant comes from `?tenant=` or the `om_login_tenant` cookie — untrusted
 * input, so it is passed on only when it is a well-formed UUID of an existing tenant; otherwise the
 * provider sees no tenant. Never throws; `null` (platform default) on any failure.
 */
export async function resolveLoginTenantBranding({
  searchParams,
  cookies,
  headers,
  container,
}: {
  searchParams?: SearchParamsRecord | null
  cookies?: CookieReader | null
  headers?: HeaderReader | null
  container?: AwilixContainer
}): Promise<TenantBranding | null> {
  try {
    const scopedContainer = await loginBrandingContainer(container)
    if (!scopedContainer) return null
    const tenantId = readLoginTenantId(searchParams, cookies)
    return await resolveTenantBranding(scopedContainer, {
      tenantId: tenantId ? await findExistingTenantId(scopedContainer, tenantId) : null,
      organizationId: null,
      host: readTenantBrandingHost(headers),
      surface: 'auth',
    })
  } catch (err) {
    getTelemetryRuntime()?.reportError(err, { module: 'branding', code: 'branding.resolve_failed' })
    return null
  }
}
