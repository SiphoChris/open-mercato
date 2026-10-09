import { asClass, asFunction } from 'awilix'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import type { TenantBrandingProvider } from '@open-mercato/shared/lib/branding/tenantBranding'
import { DefaultOrganizationScopeService } from './services/organizationScopeService'
import { DefaultOrganizationHierarchyService } from './services/organizationHierarchyService'
import { createOrganizationTenantBrandingProvider } from './lib/tenantBranding'

type OrganizationScopeRbac = ConstructorParameters<typeof DefaultOrganizationScopeService>[1]

export function register(container: AppContainer) {
  container.register({
    organizationHierarchyService: asClass(DefaultOrganizationHierarchyService).scoped(),
    organizationScopeService: asFunction((cradle: { em: EntityManager; rbacService: OrganizationScopeRbac }) =>
      new DefaultOrganizationScopeService(cradle.em, cradle.rbacService, container),
    )
      .scoped()
      .proxy(),
    defaultTenantBrandingProvider: asFunction((cradle: { em: EntityManager }) =>
      createOrganizationTenantBrandingProvider({ em: cradle.em }),
    )
      .scoped()
      .proxy(),
    tenantBrandingProvider: asFunction((cradle: { defaultTenantBrandingProvider: TenantBrandingProvider }) =>
      cradle.defaultTenantBrandingProvider,
    )
      .scoped()
      .proxy(),
  })
}
