import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

jest.mock('@/.mercato/generated/backend-route-metadata.generated', () => ({
  backendRouteMetadata: [],
}))

jest.mock('@open-mercato/shared/modules/registry', () => ({
  findRouteManifestMatch: jest.fn(() => undefined),
}))

const cookieStore = { get: jest.fn(() => undefined), toString: () => '' }
const headerStore = { get: jest.fn((name: string) => (name === 'host' ? 'acme.example.com' : null)) }

jest.mock('next/headers', () => ({
  cookies: jest.fn(async () => cookieStore),
  headers: jest.fn(async () => headerStore),
}))

jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromCookies: jest.fn(async () => ({ sub: 'user-1', tenantId: 'tenant-1', orgId: 'org-1', features: [] })),
}))

const appShellProps = jest.fn()
jest.mock('@open-mercato/ui/backend/AppShell', () => ({
  AppShell: (props: { children: React.ReactNode }) => {
    appShellProps(props)
    return React.createElement('div', { 'data-testid': 'app-shell' }, props.children)
  },
}))

jest.mock('@open-mercato/shared/lib/i18n/server', () => ({
  resolveSupportedLocalesForRequest: jest.fn(async () => ['en']),
  resolveTranslations: jest.fn(async () => ({
    translate: (_key: string, fallback?: string) => fallback ?? '',
    locale: 'en',
    dict: {},
  })),
}))

jest.mock('@open-mercato/shared/lib/i18n/locale', () => ({
  resolveForcedLocale: jest.fn(() => null),
}))

jest.mock('@open-mercato/shared/lib/i18n/context', () => ({
  I18nProvider: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}))

jest.mock('@open-mercato/core/modules/auth/lib/profile-sections', () => ({
  profilePathPrefixes: [],
}))

jest.mock('@open-mercato/shared/lib/version', () => ({ APP_VERSION: 'test' }))

jest.mock('@open-mercato/shared/lib/boolean', () => ({
  parseBooleanToken: jest.fn(() => null),
  parseBooleanWithDefault: jest.fn(() => false),
}))

jest.mock('@open-mercato/ui/backend/injection/PageInjectionBoundary', () => ({
  PageInjectionBoundary: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}))

jest.mock('@open-mercato/telemetry/browser', () => ({ BrowserTelemetry: () => null }))
jest.mock('@open-mercato/telemetry/browser/server', () => ({ resolveBrowserTelemetryConfig: jest.fn(() => null) }))
jest.mock('@/components/DemoFeedbackWidget', () => ({ DemoFeedbackWidget: () => null }))
jest.mock('@/components/OrganizationSwitcher', () => ({ __esModule: true, default: () => null }))
jest.mock('@/components/BackendHeaderChrome', () => ({ BackendHeaderChrome: () => null }))

const mockResolveBackendTenantBranding = jest.fn()
jest.mock('@open-mercato/core/modules/auth/lib/tenantBranding', () => ({
  resolveBackendTenantBranding: (...args: unknown[]) => mockResolveBackendTenantBranding(...args),
}))

const tenantStyle = {
  version: 1 as const,
  logo: null,
  light: { '--primary': '#124488', '--primary-hover': '#113366', '--primary-foreground': '#FFFFFF' },
  dark: { '--primary': '#AACCFF', '--primary-hover': '#88AADD', '--primary-foreground': '#000000' },
}

async function renderLayout() {
  const layout = await import('../layout')
  const tree = await layout.default({ children: null, params: Promise.resolve({}) })
  return renderToStaticMarkup(tree)
}

describe('Backend layout tenant branding', () => {
  beforeEach(() => {
    appShellProps.mockClear()
    mockResolveBackendTenantBranding.mockReset()
  })

  it('renders the platform defaults when the provider resolves nothing', async () => {
    mockResolveBackendTenantBranding.mockResolvedValue(null)
    const markup = await renderLayout()

    expect(markup).not.toContain('<style')
    expect(appShellProps).toHaveBeenCalledWith(expect.objectContaining({ productName: 'Open Mercato', initialBrand: null }))
    expect(mockResolveBackendTenantBranding).toHaveBeenCalledWith(expect.objectContaining({
      auth: expect.objectContaining({ tenantId: 'tenant-1' }),
      request: { cookies: cookieStore },
      host: 'acme.example.com',
    }))
  })

  it('passes the tenant brand to the shell and server-renders the brand style', async () => {
    mockResolveBackendTenantBranding.mockResolvedValue({
      productName: 'Acme Workspace',
      logos: {
        light: { src: '/brand/acme.svg', alt: 'Acme' },
        dark: { src: '/brand/acme-dark.svg', alt: 'Acme' },
      },
      style: tenantStyle,
    })
    const markup = await renderLayout()

    expect(markup).toContain('<style id="om-tenant-brand-style">:root:not(.dark){--primary:#124488;')
    expect(appShellProps).toHaveBeenCalledWith(expect.objectContaining({
      productName: 'Acme Workspace',
      initialBrand: {
        name: 'Acme Workspace',
        logo: { src: '/brand/acme.svg', alt: 'Acme' },
        darkLogo: { src: '/brand/acme-dark.svg', alt: 'Acme' },
      },
    }))
  })

  it('keeps the platform product name when the branding shows no logo, as the chrome brand does', async () => {
    mockResolveBackendTenantBranding.mockResolvedValue({ productName: 'Northwind Ltd' })
    await renderLayout()

    expect(appShellProps).toHaveBeenCalledWith(expect.objectContaining({ productName: 'Open Mercato', initialBrand: null }))
  })
})
