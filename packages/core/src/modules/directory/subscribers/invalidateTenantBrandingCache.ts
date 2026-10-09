import { invalidateTenantBrandingCache } from '@open-mercato/shared/lib/branding/resolveTenantBranding'

export const metadata = {
  event: 'directory.organization.*',
  persistent: false,
  id: 'directory:invalidate-tenant-branding-cache',
}

export default async function handle(
  payload: unknown,
  ctx: { resolve: <T = unknown>(name: string) => T },
): Promise<void> {
  const data = (payload ?? {}) as Record<string, unknown>
  const tenantId = typeof data.tenantId === 'string' ? data.tenantId : null
  if (!tenantId) return
  await invalidateTenantBrandingCache({ resolve: (name: string) => ctx.resolve(name) }, tenantId)
}
