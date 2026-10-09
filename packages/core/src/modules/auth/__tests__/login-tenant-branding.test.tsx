/**
 * @jest-environment jsdom
 */
import * as React from 'react'
import { render, screen } from '@testing-library/react'
import LoginPage from '../frontend/login'

const mockTranslate = (_key: string, fallback?: string) => fallback ?? _key

const mockRefresh = jest.fn()
const mockRouter = { replace: jest.fn(), push: jest.fn(), refresh: mockRefresh }
let mockSearchParams = new URLSearchParams()

jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => mockSearchParams,
}))

jest.mock('next/image', () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => (
    <img
      alt={String(props.alt ?? '')}
      src={String(props.src ?? '')}
      className={typeof props.className === 'string' ? props.className : undefined}
      data-unoptimized={props.unoptimized ? 'true' : 'false'}
      data-priority={props.priority ? 'true' : 'false'}
      data-loading={typeof props.loading === 'string' ? props.loading : 'default'}
    />
  ),
}))

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children }: { href: unknown; children?: React.ReactNode }) => <a href={typeof href === 'string' ? href : '#'}>{children}</a>,
}))

jest.mock('@open-mercato/shared/lib/i18n/context', () => ({
  useT: () => mockTranslate,
}))

jest.mock('@open-mercato/shared/lib/i18n/translate', () => ({
  translateWithFallback: (_t: unknown, _key: string, fallback: string) => fallback,
}))

jest.mock('@open-mercato/ui/backend/utils/apiCall', () => ({
  apiCall: jest.fn(async () => ({ result: {} })),
}))

jest.mock('@open-mercato/ui/backend/operations/store', () => ({ clearAllOperations: jest.fn() }))
jest.mock('@open-mercato/ui/backend/AuthSessionGuard', () => ({ notifyAuthIdentityChange: jest.fn() }))
jest.mock('@open-mercato/ui/backend/injection/InjectionSpot', () => ({ InjectionSpot: () => null }))
jest.mock('@open-mercato/ui/backend/injection/useRegisteredComponent', () => ({
  useRegisteredComponent: (_handle: string, Fallback: React.ComponentType) => Fallback,
}))

const STORED_TENANT_ID = '6f1c2f9e-3b0a-4f5e-9c1d-2a7b8c9d0e1f'

function clearLoginTenantCookie() {
  document.cookie = 'om_login_tenant=; path=/; max-age=0'
}

beforeEach(() => {
  mockRefresh.mockClear()
  mockSearchParams = new URLSearchParams()
  window.localStorage.clear()
  clearLoginTenantCookie()
})

describe('LoginPage tenant branding', () => {
  it('renders the platform logo and name without branding', () => {
    render(<LoginPage />)
    const logo = screen.getByAltText('Open Mercato logo')
    expect(logo).toHaveAttribute('src', '/open-mercato.svg')
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Open Mercato')
  })

  it('renders the tenant name, light logo and dark logo', () => {
    render(
      <LoginPage
        branding={{
          productName: 'Acme Workspace',
          logos: {
            light: { src: '/brand/acme.svg', alt: 'Acme' },
            dark: { src: '/brand/acme-dark.svg', alt: 'Acme (dark)' },
          },
        }}
      />,
    )
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Acme Workspace')
    const light = screen.getByAltText('Acme')
    const dark = screen.getByAltText('Acme (dark)')
    expect(light).toHaveAttribute('src', '/brand/acme.svg')
    expect(light.className).toContain('dark:hidden')
    expect(dark).toHaveAttribute('src', '/brand/acme-dark.svg')
    expect(dark.className.split(' ')).toEqual(expect.arrayContaining(['hidden', 'dark:inline-block']))
    expect(screen.queryByAltText('Open Mercato logo')).toBeNull()
  })

  it('bypasses the image optimiser for absolute and root-relative logos', () => {
    render(
      <LoginPage
        branding={{
          logos: {
            light: { src: 'HTTPS://cdn.example.com/acme.png', alt: 'Acme' },
            dark: { src: '/brand/acme-dark.svg', alt: 'Acme (dark)' },
          },
        }}
      />,
    )
    expect(screen.getByAltText('Acme')).toHaveAttribute('data-unoptimized', 'true')
    expect(screen.getByAltText('Acme (dark)')).toHaveAttribute('data-unoptimized', 'true')
  })

  it('preloads neither logo variant when a dark logo exists, leaving both lazy so only the visible one loads', () => {
    render(
      <LoginPage
        branding={{
          logos: {
            light: { src: '/brand/acme.svg', alt: 'Acme' },
            dark: { src: '/brand/acme-dark.svg', alt: 'Acme (dark)' },
          },
        }}
      />,
    )
    for (const alt of ['Acme', 'Acme (dark)']) {
      expect(screen.getByAltText(alt)).toHaveAttribute('data-priority', 'false')
      expect(screen.getByAltText(alt)).toHaveAttribute('data-loading', 'default')
    }
  })

  it('preloads the only logo, as the platform logo is preloaded, when there is no dark logo', () => {
    const { unmount } = render(<LoginPage branding={{ logos: { light: { src: '/brand/acme.svg', alt: 'Acme' } } }} />)
    expect(screen.getByAltText('Acme')).toHaveAttribute('data-priority', 'true')
    expect(screen.getByAltText('Acme')).toHaveAttribute('data-loading', 'default')
    unmount()
    render(<LoginPage />)
    expect(screen.getByAltText('Open Mercato logo')).toHaveAttribute('data-priority', 'true')
  })

  it('uses the product name as the logo alt when the provider gives none', () => {
    render(<LoginPage branding={{ productName: 'Acme Workspace', logos: { light: { src: '/brand/acme.svg' } } }} />)
    expect(screen.getByAltText('Acme Workspace')).toHaveAttribute('src', '/brand/acme.svg')
  })

  it('keeps the platform logo, named after the product, when the branding has no logos', () => {
    render(<LoginPage branding={{ productName: 'Acme Workspace' }} />)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Acme Workspace')
    expect(screen.getByAltText('Acme Workspace')).toHaveAttribute('src', '/open-mercato.svg')
  })
})

describe('LoginPage login tenant', () => {
  it('keeps the login tenant behaviour unchanged: a tenant restored from local storage writes no cookie and triggers no refresh', async () => {
    window.localStorage.setItem('om_login_tenant', STORED_TENANT_ID)
    render(<LoginPage branding={null} />)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(document.cookie).not.toContain('om_login_tenant=')
    expect(mockRefresh).not.toHaveBeenCalled()
  })
})
