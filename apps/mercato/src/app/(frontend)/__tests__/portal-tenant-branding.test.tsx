import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const headerStore = {
  get: jest.fn((name: string) => {
    if (name === 'x-next-url') return '/acme/portal/login'
    if (name === 'host') return 'acme.example.com'
    return null
  }),
}
jest.mock('next/headers', () => ({
  headers: jest.fn(async () => headerStore),
  cookies: jest.fn(),
}))

jest.mock('@open-mercato/core/modules/customer_accounts/lib/customerAuthServer', () => ({
  getCustomerAuthFromCookies: jest.fn(async () => null),
}))

jest.mock('@open-mercato/core/modules/directory/data/entities', () => ({
  Organization: class Organization {},
}))

jest.mock('@open-mercato/core/modules/customer_accounts/data/entities', () => ({
  CustomerUser: class CustomerUser {},
}))

type PortalShellProps = { children: React.ReactNode; branding?: Record<string, unknown> | null }
const portalShellProps = jest.fn<void, [PortalShellProps]>()
jest.mock('@open-mercato/ui/portal/PortalLayoutShell', () => ({
  PortalLayoutShell: (props: PortalShellProps) => {
    portalShellProps(props)
    return <div data-testid="portal-shell">{props.children}</div>
  },
}))

jest.mock('@open-mercato/shared/lib/i18n/server', () => ({
  resolveTranslations: async () => ({
    t: (_key: string, fallback: string) => fallback,
    translate: (_key: string, fallback: string) => fallback,
  }),
}))

jest.mock('@open-mercato/ui/backend/detail', () => ({
  AccessDeniedMessage: () => <div data-testid="access-denied" />,
}))

jest.mock('next/link', () => (props: { href: string; children?: React.ReactNode }) => <a href={props.href}>{props.children}</a>)

const mockEm = {
  findOne: jest.fn(async (_entity: unknown, query: { slug?: string }) => (
    query.slug === 'acme' ? { id: 'org-acme', name: 'Acme', slug: 'acme', tenant: { id: 'tenant-acme' } } : null
  )),
}

const mockProvider = { varyByHost: true, resolve: jest.fn() }

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: jest.fn(async () => ({
    resolve: (key: string) => {
      if (key === 'em') return mockEm
      if (key === 'featureTogglesService') return { getBoolConfig: async () => ({ ok: true, value: true }) }
      if (key === 'tenantBrandingProvider') return mockProvider
      return null
    },
  })),
}))

import FrontendLayout from '../layout'

const tenantStyle = {
  version: 1 as const,
  logo: null,
  light: { '--primary': '#124488', '--primary-hover': '#113366', '--primary-foreground': '#FFFFFF' },
  dark: { '--primary': '#AACCFF', '--primary-hover': '#88AADD', '--primary-foreground': '#000000' },
}

describe('frontend portal tenant branding', () => {
  beforeEach(() => {
    portalShellProps.mockClear()
    mockProvider.resolve.mockReset()
  })

  it('resolves the portal branding for the URL organization and renders it before first paint', async () => {
    const branding = {
      logos: { light: { src: '/brand/acme.svg', alt: 'Acme' }, dark: { src: '/brand/acme-dark.svg', alt: 'Acme' } },
      style: tenantStyle,
    }
    mockProvider.resolve.mockResolvedValue(branding)

    const markup = renderToStaticMarkup(await FrontendLayout({ children: <div>child</div> }) as React.ReactElement)

    expect(mockProvider.resolve).toHaveBeenCalledWith({
      tenantId: 'tenant-acme',
      organizationId: 'org-acme',
      host: 'acme.example.com',
      surface: 'portal',
    })
    expect(markup).toContain('<style id="om-tenant-brand-style">')
    expect(portalShellProps).toHaveBeenCalledWith(expect.objectContaining({
      orgSlug: 'acme',
      branding: { logos: branding.logos },
    }))
    const [[shellProps]] = portalShellProps.mock.calls
    expect(Object.keys(shellProps.branding)).toEqual(['logos'])
  })

  it('falls back to the platform default when the provider throws', async () => {
    mockProvider.resolve.mockRejectedValue(new Error('provider down'))

    const markup = renderToStaticMarkup(await FrontendLayout({ children: <div>child</div> }) as React.ReactElement)

    expect(markup).not.toContain('<style')
    expect(markup).toContain('child')
    expect(portalShellProps).toHaveBeenCalledWith(expect.objectContaining({ orgSlug: 'acme', branding: null }))
  })
})
