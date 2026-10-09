import type { EntityManager } from '@mikro-orm/postgresql'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import type {
  TenantBranding,
  TenantBrandingProvider,
  TenantBrandingResolveInput,
} from '@open-mercato/shared/lib/branding/tenantBranding'
import { Organization } from '@open-mercato/core/modules/directory/data/entities'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isTenantBrandingUuid(value: string | null | undefined): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

/**
 * The built-in branding: the selected organization's logo in the backend shell, and nothing on the
 * portal and auth surfaces. Registered as `defaultTenantBrandingProvider` and, unless an app
 * overrides it, as `tenantBrandingProvider`.
 */
export function createOrganizationTenantBrandingProvider({ em }: { em: EntityManager }): TenantBrandingProvider {
  return {
    async resolve({ tenantId, organizationId, surface }: TenantBrandingResolveInput): Promise<TenantBranding | null> {
      if (surface !== 'backend' || !isTenantBrandingUuid(tenantId) || !isTenantBrandingUuid(organizationId)) return null
      const organization = await findOneWithDecryption(
        em,
        Organization,
        { id: organizationId, tenant: tenantId, deletedAt: null },
        undefined,
        { tenantId, organizationId },
      )
      if (!organization?.logoUrl) return null
      return {
        productName: organization.name,
        logos: {
          light: {
            src: organization.logoUrl,
            alt: `${organization.name} logo`,
            preserveAspectRatio: !!organization.logoPreserveAspectRatio,
          },
        },
      }
    },
  }
}
