import { invalidateTenantBrandingCache } from '@open-mercato/shared/lib/branding/resolveTenantBranding'

export const metadata = {
  event: 'directory.tenant.*',
  persistent: false,
  id: 'directory:invalidate-tenant-branding-cache-on-tenant-change',
}

export default async function handle(
  payload: unknown,
  ctx: { resolve: <T = unknown>(name: string) => T },
): Promise<void> {
  const data = (payload ?? {}) as Record<string, unknown>
  const tenantId = typeof data.tenantId === 'string' ? data.tenantId : typeof data.id === 'string' ? data.id : null
  if (!tenantId) return
  await invalidateTenantBrandingCache({ resolve: (name: string) => ctx.resolve(name) }, tenantId)
}
