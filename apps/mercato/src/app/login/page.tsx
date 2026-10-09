import { Suspense } from 'react'
import { cookies, headers } from 'next/headers'
import LoginPage from '@open-mercato/core/modules/auth/frontend/login'
import { resolveLoginTenantBranding } from '@open-mercato/core/modules/auth/lib/tenantBranding'
import { toClientTenantBranding } from '@open-mercato/shared/lib/branding/tenantBranding'
import { TenantBrandStyle } from '@open-mercato/ui/theme/TenantBrandStyle'

type LoginRoutePageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}

export default async function LoginRoutePage({ searchParams }: LoginRoutePageProps) {
  const branding = await resolveLoginTenantBranding({
    searchParams: searchParams ? await searchParams : null,
    cookies: await cookies(),
    headers: await headers(),
  })
  return (
    <>
      <TenantBrandStyle brandStyle={branding?.style} />
      {/* LoginPage reads query params with useSearchParams; keep this boundary so
          static builds can prerender the route and hydrate the client-only params. */}
      <Suspense fallback={null}>
        <LoginPage branding={toClientTenantBranding(branding)} />
      </Suspense>
    </>
  )
}
