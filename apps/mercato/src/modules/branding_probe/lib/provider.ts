import type { EntityManager } from '@mikro-orm/postgresql'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import type {
  TenantBranding,
  TenantBrandingProvider,
  TenantBrandingResolveInput,
} from '@open-mercato/shared/lib/branding/tenantBranding'
import { Organization, Tenant } from '@open-mercato/core/modules/directory/data/entities'

export const BRANDING_PROBE_NAME_PREFIX = 'QA TC-BRANDING-001'
export const BRANDING_PROBE_MODE_ENV = 'OM_TEST_BRANDING_PROBE_MODE'

/** The probe is inert unless the integration runner opts in explicitly; no other variable enables it. */
export function isBrandingProbeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[BRANDING_PROBE_MODE_ENV] === 'opt-in'
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const brandingProbeBranding: TenantBranding = {
  productName: 'QA Branded Workspace',
  logos: {
    light: { src: '/catch-the-tornado-logo.png?branding-probe=light', alt: 'QA branded light logo' },
    dark: { src: '/catch-the-tornado-logo.png?branding-probe=dark', alt: 'QA branded dark logo' },
  },
  style: {
    version: 1,
    logo: null,
    light: { '--primary': '#124488', '--primary-hover': '#113366', '--primary-foreground': '#ffffff' },
    dark: { '--primary': '#aaccff', '--primary-hover': '#88aadd', '--primary-foreground': '#000000' },
  },
}

async function isProbeRecord(em: EntityManager, input: TenantBrandingResolveInput): Promise<boolean> {
  if (input.surface === 'auth') {
    if (!input.tenantId || !UUID_PATTERN.test(input.tenantId)) return false
    const tenant = await findOneWithDecryption(em, Tenant, { id: input.tenantId, deletedAt: null }, undefined, { tenantId: input.tenantId, organizationId: null })
    return Boolean(tenant?.name?.startsWith(BRANDING_PROBE_NAME_PREFIX))
  }
  if (!input.tenantId || !input.organizationId || !UUID_PATTERN.test(input.tenantId) || !UUID_PATTERN.test(input.organizationId)) return false
  const organization = await findOneWithDecryption(
    em,
    Organization,
    { id: input.organizationId, tenant: input.tenantId, deletedAt: null },
    undefined,
    { tenantId: input.tenantId, organizationId: input.organizationId },
  )
  return Boolean(organization?.name?.startsWith(BRANDING_PROBE_NAME_PREFIX))
}

/**
 * Test-only tenant branding provider: brands tenants and organizations whose name starts with
 * `BRANDING_PROBE_NAME_PREFIX` and delegates everything else to the default provider.
 */
export function createBrandingProbeProvider({
  em,
  defaultTenantBrandingProvider,
}: {
  em: EntityManager
  defaultTenantBrandingProvider: TenantBrandingProvider
}): TenantBrandingProvider {
  return {
    async resolve(input) {
      if (await isProbeRecord(em, input)) return brandingProbeBranding
      return defaultTenantBrandingProvider.resolve(input)
    },
  }
}
