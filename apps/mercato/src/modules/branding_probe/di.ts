import { asFunction } from 'awilix'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import type { TenantBrandingProvider } from '@open-mercato/shared/lib/branding/tenantBranding'
import { createBrandingProbeProvider, isBrandingProbeEnabled } from './lib/provider'

/**
 * Registers the test-only branding provider only when the integration runner sets
 * OM_TEST_BRANDING_PROBE_MODE=opt-in. Development, production and other test runs keep the default provider.
 */
export function register(container: AppContainer) {
  if (!isBrandingProbeEnabled()) return
  container.register({
    tenantBrandingProvider: asFunction((cradle: { em: EntityManager; defaultTenantBrandingProvider: TenantBrandingProvider }) =>
      createBrandingProbeProvider({ em: cradle.em, defaultTenantBrandingProvider: cradle.defaultTenantBrandingProvider }),
    )
      .scoped()
      .proxy(),
  })
}
