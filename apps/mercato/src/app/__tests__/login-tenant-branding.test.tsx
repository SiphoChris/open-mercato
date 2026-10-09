import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const cookieStore = { get: jest.fn(() => undefined) }
const headerStore = { get: jest.fn(() => null) }

jest.mock('next/headers', () => ({
  cookies: jest.fn(async () => cookieStore),
  headers: jest.fn(async () => headerStore),
}))

type LoginPageProps = { branding: Record<string, unknown> | null }
const loginPageProps = jest.fn<void, [LoginPageProps]>()
jest.mock('@open-mercato/core/modules/auth/frontend/login', () => ({
  __esModule: true,
  default: (props: LoginPageProps) => {
    loginPageProps(props)
    return <div data-testid="login-page" />
  },
}))

const mockResolveLoginTenantBranding = jest.fn()
jest.mock('@open-mercato/core/modules/auth/lib/tenantBranding', () => ({
  resolveLoginTenantBranding: (...args: unknown[]) => mockResolveLoginTenantBranding(...args),
}))

import LoginRoutePage from '../login/page'

const tenantStyle = {
  version: 1 as const,
  logo: null,
  light: { '--primary': '#124488', '--primary-hover': '#113366', '--primary-foreground': '#FFFFFF' },
  dark: { '--primary': '#AACCFF', '--primary-hover': '#88AADD', '--primary-foreground': '#000000' },
}

const acmeTenantId = '6f1c2f9e-3b0a-4f5e-9c1d-2a7b8c9d0e1f'

describe('login route tenant branding', () => {
  beforeEach(() => {
    loginPageProps.mockClear()
    mockResolveLoginTenantBranding.mockReset()
  })

  it('resolves the branding from the request and hands it to the login page', async () => {
    const branding = { productName: 'Acme Workspace', logos: { light: { src: '/brand/acme.svg' } }, style: tenantStyle }
    mockResolveLoginTenantBranding.mockResolvedValue(branding)

    const markup = renderToStaticMarkup(await LoginRoutePage({ searchParams: Promise.resolve({ tenant: acmeTenantId }) }))

    expect(mockResolveLoginTenantBranding).toHaveBeenCalledWith({
      searchParams: { tenant: acmeTenantId },
      cookies: cookieStore,
      headers: headerStore,
    })
    expect(markup).toContain('<style id="om-tenant-brand-style">')
    expect(markup).not.toContain('"style"')
    expect(loginPageProps).toHaveBeenCalledWith({
      branding: { productName: 'Acme Workspace', logos: { light: { src: '/brand/acme.svg' } } },
    })
    const [[clientProps]] = loginPageProps.mock.calls
    expect(Object.keys(clientProps.branding)).toEqual(['productName', 'logos'])
  })

  it('renders the default login page when nothing is resolved', async () => {
    mockResolveLoginTenantBranding.mockResolvedValue(null)

    const markup = renderToStaticMarkup(await LoginRoutePage({}))

    expect(markup).toBe('<div data-testid="login-page"></div>')
    expect(loginPageProps).toHaveBeenCalledWith({ branding: null })
  })
})
