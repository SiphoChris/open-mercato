"use client"
import type { ReactNode } from 'react'
import type { CustomerAuthContext } from '@open-mercato/shared/modules/customer-auth'
import type { ClientTenantBranding, TenantBrandingLogo } from '@open-mercato/shared/lib/branding/tenantBranding'
import { PortalProvider } from './PortalContext'
import PortalShell, { type ShellLogo } from './PortalShell'

type PortalLayoutShellProps = {
  children: ReactNode
  orgSlug: string
  organizationName: string | null
  tenantId: string | null
  organizationId: string | null
  authenticated: boolean
  userName: string | null
  userEmail: string | null
  customerAuth: CustomerAuthContext | null
  /** Server-resolved tenant branding. The portal header is a square slot: `mark` wins over `light`/`dark`. */
  branding?: ClientTenantBranding | null
}

function toShellLogo(logo: TenantBrandingLogo | undefined): ShellLogo | undefined {
  return logo?.src ? { src: logo.src, alt: logo.alt, unoptimized: true } : undefined
}

/**
 * Portal layout shell initialized with server-resolved data.
 *
 * Receives auth + org data as props from the server layout component.
 * No client-side fetching for auth or tenant — identical pattern to
 * the backend AppShell which receives server-resolved data.
 *
 * This eliminates all loading states and layout flashes:
 * - Auth is resolved from the customer JWT cookie on the server
 * - Org name is queried from DB on the server
 * - PortalShell receives stable props from frame 1
 */
export function PortalLayoutShell({
  children,
  orgSlug,
  organizationName,
  tenantId,
  organizationId,
  authenticated,
  userName,
  userEmail,
  customerAuth,
  branding,
}: PortalLayoutShellProps) {
  const logos = branding?.logos
  const logo = toShellLogo(logos?.mark ?? logos?.light)
  const darkLogo = logos?.mark ? undefined : toShellLogo(logos?.dark)
  return (
    <PortalProvider
      orgSlug={orgSlug}
      initialAuth={customerAuth}
      initialTenant={{
        tenantId: tenantId ?? undefined,
        organizationId: organizationId ?? undefined,
        organizationName: organizationName ?? undefined,
      }}
    >
      <PortalShell
        authenticated={authenticated}
        enableEventBridge={authenticated}
        orgSlug={orgSlug}
        organizationName={organizationName ?? undefined}
        userName={userName ?? undefined}
        userEmail={userEmail ?? undefined}
        logo={logo}
        darkLogo={darkLogo}
      >
        {children}
      </PortalShell>
    </PortalProvider>
  )
}
