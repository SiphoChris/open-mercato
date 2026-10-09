import { runWithCacheTenant } from '@open-mercato/cache'
import type { EntityManager } from '@mikro-orm/postgresql'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { getTelemetryRuntime } from '@open-mercato/shared/lib/telemetry/runtime'
import { buildTenantBrandingCacheTag, type TenantBrandingContainer } from '@open-mercato/shared/lib/branding/resolveTenantBranding'
import { isAllOrganizationsSelection } from '@open-mercato/core/modules/directory/constants'
import { Organization } from '@open-mercato/core/modules/directory/data/entities'
import { isTenantBrandingUuid } from '@open-mercato/core/modules/directory/lib/tenantBranding'

export type BrandOrganization = { id: string; name: string }

type OrganizationCache = {
  get: (key: string) => Promise<unknown>
  set: (key: string, value: unknown, options?: { ttl?: number; tags?: string[] }) => Promise<unknown>
}

const BRAND_ORGANIZATION_CACHE_TTL_MS = 5 * 60 * 1000

function optionalCache(container: TenantBrandingContainer): OrganizationCache | null {
  try {
    const cache = container.resolve('cache') as Partial<OrganizationCache> | null | undefined
    return cache && typeof cache.get === 'function' && typeof cache.set === 'function' ? cache as OrganizationCache : null
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
    if (cache) await runWithCacheTenant(tenantId, () => cache.set(key, brandOrganization, { ttl: BRAND_ORGANIZATION_CACHE_TTL_MS, tags: [buildTenantBrandingCacheTag(tenantId)] }))
  } catch (err) {
    getTelemetryRuntime()?.reportError(err, { module: 'branding', code: 'branding.cache_failed' })
  }
  return brandOrganization
}
