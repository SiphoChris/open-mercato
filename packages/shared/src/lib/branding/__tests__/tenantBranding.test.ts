import { randomUUID } from 'node:crypto'
import { createCacheService, getCurrentCacheTenant, runWithCacheTenant, type CacheStrategy } from '@open-mercato/cache'
import type { BrandStyle } from '../brandStyle'
import { registerTelemetryRuntime, type TelemetryRuntime } from '../../telemetry/runtime'

type MockLogger = { debug: jest.Mock; info: jest.Mock; warn: jest.Mock; error: jest.Mock; child: () => MockLogger }

jest.mock('../../logger', () => {
  const logger: MockLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), child: () => logger }
  return { createLogger: () => logger, mockedLogger: logger }
})

const mockLogger = (jest.requireMock('../../logger') as { mockedLogger: MockLogger }).mockedLogger

import {
  organizationLogoUrlSchema,
  parseTenantBranding,
  toBackendChromeBrand,
  toClientTenantBranding,
  type TenantBranding,
  type TenantBrandingProvider,
  type TenantBrandingResolveInput,
} from '../tenantBranding'
import {
  invalidateTenantBrandingCache,
  readTenantBrandingHost,
  resolveTenantBranding,
} from '../resolveTenantBranding'

const TENANT_ID = '6f1c2f9e-3b0a-4f5e-9c1d-2a7b8c9d0e1f'
const OTHER_TENANT_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const ORG_ID = '11111111-2222-4333-8444-555555555555'
const OTHER_ORG_ID = '99999999-2222-4333-8444-555555555555'
const PROVIDER_TIMEOUT_MS = 3000
const FAILURE_TTL_MS = 30 * 1000

const style: BrandStyle = {
  version: 1,
  logo: null,
  light: { '--primary': '#124488', '--primary-hover': '#113366', '--primary-foreground': '#FFFFFF' },
  dark: { '--primary': '#AACCFF', '--primary-hover': '#88AADD', '--primary-foreground': '#000000' },
}

const unreadableStyle: BrandStyle = {
  ...style,
  light: { '--primary': '#CCCCCC', '--primary-hover': '#BBBBBB', '--primary-foreground': '#DDDDDD' },
}

const acmeBranding: TenantBranding = {
  productName: 'Acme Workspace',
  logos: {
    light: { src: '/brand/acme.svg', alt: 'Acme' },
    dark: { src: 'https://cdn.example.com/acme-dark.png', alt: 'Acme' },
    mark: { src: '/brand/acme-mark.svg' },
  },
  style,
}

const DIRECTORY_ACCEPTED_LOGO_URLS: Array<[string, string]> = [
  ['an underscore host', 'https://my_cdn.example.com/logo.png'],
  ['a trailing-dot host', 'https://cdn.example.com./logo.png'],
  ['credentials', 'https://user:pw@cdn.example.com/logo.png'],
  ['a leading-hyphen label', 'https://-cdn.example.com/logo.png'],
  ['an empty label', 'https://a..b.com/logo.png'],
  ['a 70-character label', `https://${'a'.repeat(70)}.example.com/logo.png`],
  ['a host with an asterisk', 'https://cdn*.example.com/logo.png'],
  ['a host with an exclamation mark', 'https://cdn!.example.com/logo.png'],
  ['a host with a dollar sign', 'https://cdn$.example.com/logo.png'],
  ['a host with a tilde', 'https://cdn~.example.com/logo.png'],
  ['a path with a tab', 'https://cdn.example.com/lo\tgo.png'],
  ['plain http', 'http://legacy.example.com/logo.png'],
  ['an attachment path with a query', '/api/attachments/image/abc?width=320&height=320'],
]

type Registrations = Record<string, unknown>

function makeContainer(registrations: Registrations, factories: Record<string, () => unknown> = {}) {
  return {
    hasRegistration: (name: string) => name in registrations || name in factories,
    resolve: jest.fn((name: string) => {
      if (name in factories) return factories[name]()
      if (name in registrations) return registrations[name]
      throw new Error(`[internal] not registered: ${name}`)
    }),
  }
}

function provider(
  result: (input: TenantBrandingResolveInput) => Promise<TenantBranding | null> | TenantBranding | null,
  options: { varyByHost?: boolean } = {},
): TenantBrandingProvider & { resolve: jest.Mock } {
  return { resolve: jest.fn(async (input: TenantBrandingResolveInput) => result(input)), ...options }
}

function organizationBranding(src: string, name = 'Northwind Ltd'): TenantBranding {
  return { productName: name, logos: { light: { src, alt: `${name} logo`, preserveAspectRatio: false } } }
}

function countingCache(): CacheStrategy & { writes: string[] } {
  const cache = createCacheService({ strategy: 'memory' })
  const writes: string[] = []
  const set: CacheStrategy['set'] = async (key, value, options) => {
    writes.push(key)
    return cache.set(key, value, options)
  }
  return Object.assign(Object.create(cache), { set, writes }) as CacheStrategy & { writes: string[] }
}

function randomHost(): string {
  return `${randomUUID().slice(0, 8)}.example.com`
}

function withTelemetry<T>(run: (reportError: jest.Mock) => Promise<T>): Promise<T> {
  const reportError = jest.fn()
  const unregister = registerTelemetryRuntime({ reportError } as unknown as TelemetryRuntime)
  return run(reportError).finally(unregister)
}

function reportsWithCode(reportError: jest.Mock, code: string): unknown[] {
  return reportError.mock.calls.filter(([, context]) => context?.code === code)
}

const input: TenantBrandingResolveInput = { tenantId: TENANT_ID, organizationId: ORG_ID, host: 'Acme.Example.com', surface: 'backend' }
const hostless: TenantBrandingResolveInput = { ...input, host: null }

beforeEach(() => {
  mockLogger.debug.mockClear()
  mockLogger.warn.mockClear()
})

describe('parseTenantBranding', () => {
  it('accepts a complete branding and strips the unused style logo', () => {
    const withStyleLogo = { ...acmeBranding, style: { ...style, logo: 'data:image/png;base64,aGVsbG8=' } }
    expect(parseTenantBranding(withStyleLogo)).toEqual({ ok: true, branding: acmeBranding, issues: [] })
  })

  it('treats null as no branding and rejects only non-objects', () => {
    expect(parseTenantBranding(null)).toEqual({ ok: true, branding: null, issues: [] })
    expect(parseTenantBranding('Acme')).toEqual({ ok: false })
    expect(parseTenantBranding([acmeBranding])).toEqual({ ok: false })
  })

  it('drops a style failing the WCAG contrast rules and keeps everything else', () => {
    expect(parseTenantBranding({ ...acmeBranding, style: unreadableStyle })).toEqual({
      ok: true,
      branding: { productName: acmeBranding.productName, logos: acmeBranding.logos },
      issues: ['style'],
    })
  })

  it('drops an invalid dark logo or mark on its own', () => {
    const result = parseTenantBranding({
      ...acmeBranding,
      logos: { light: acmeBranding.logos?.light, dark: { src: 'javascript:alert(1)' }, mark: { src: '//cdn.example.com/m.png' } },
    })
    expect(result).toEqual({
      ok: true,
      branding: { productName: 'Acme Workspace', logos: { light: acmeBranding.logos?.light }, style },
      issues: ['logos.dark', 'logos.mark'],
    })
  })

  it('drops the logos group when the light logo is invalid, keeping the name and the style', () => {
    expect(parseTenantBranding({ ...acmeBranding, logos: { light: { src: '//evil.example.com/a.png' }, dark: acmeBranding.logos?.dark } })).toEqual({
      ok: true,
      branding: { productName: 'Acme Workspace', style },
      issues: ['logos.light'],
    })
  })

  it('ignores unknown and mistyped fields instead of failing the branding', () => {
    expect(parseTenantBranding({ productName: 42, colour: '#fff', logos: { light: { src: '/a.png', alt: 7, extra: true }, other: {} } })).toEqual({
      ok: true,
      branding: { logos: { light: { src: '/a.png' } } },
      issues: ['colour', 'productName', 'logos.light.alt', 'logos.light.extra', 'logos.other'],
    })
  })

  it.each(['', '   ', '\t\n'])('drops a blank product name %j', (productName) => {
    expect(parseTenantBranding({ productName, logos: { light: { src: '/a.png' } } })).toEqual({
      ok: true,
      branding: { logos: { light: { src: '/a.png' } } },
      issues: ['productName'],
    })
  })

  it('keeps non-blank product names and alt texts verbatim, whatever their length', () => {
    const longName = `  ${'Acme '.repeat(200)}  `
    const branding = { productName: longName, logos: { light: { src: '/brand/acme.svg', alt: `${longName} logo` } } }
    expect(parseTenantBranding(branding)).toEqual({ ok: true, branding, issues: [] })
  })

  it.each([
    ['javascript', 'javascript:alert(1)'],
    ['upper-case javascript', 'JavaScript:alert(1)'],
    ['leading spaces', '  javascript:alert(1)'],
    ['a tab inside the scheme', 'java\tscript:alert(1)'],
    ['a newline inside the scheme', 'java\nscript:alert(1)'],
    ['a leading NUL', '\u0000javascript:alert(1)'],
    ['vbscript', 'vbscript:msgbox(1)'],
    ['protocol-relative', '//evil.example.com/logo.png'],
    ['slash-backslash', '/\\evil.example.com/logo.png'],
    ['double backslash', '\\\\evil.example.com/logo.png'],
    ['a mixed-case http scheme', 'Http://cdn.example.com/acme.png'],
    ['an http scheme without slashes', 'http:cdn.example.com/acme.png'],
    ['a relative path without a leading slash', 'brand/acme.png'],
    ['a trailing space', '/brand/acme.png '],
    ['an html data url', 'data:text/html;base64,PHNjcmlwdD4='],
    ['a non-base64 svg data url', 'data:image/svg+xml,<svg onload=alert(1)>'],
    ['an empty value', ''],
    ['a lone high surrogate', '/a\uD800b.png'],
    ['a lone trailing high surrogate', '/x\uD83D.png'],
    ['a lone low surrogate in an https url', 'https://cdn.example.com/a\uDC00.png'],
  ])('drops a logo with %s', (_label, src) => {
    const result = parseTenantBranding({ productName: 'Acme', logos: { light: { src } } })
    expect(result).toEqual({ ok: true, branding: { productName: 'Acme' }, issues: ['logos.light'] })
  })

  it.each([
    ['a root-relative path with a query', '/brand/acme.png?v=3', '/brand/acme.png?v=3'],
    ['an attachment url with a query', '/api/attachments/image/abc/acme.svg?width=320', '/api/attachments/image/abc/acme.svg?width=320'],
    ['a url with a quote and a space', "https://cdn.example.com/acme's logo.png", "https://cdn.example.com/acme's logo.png"],
    ['an upper-case scheme', 'HTTPS://cdn.example.com/acme.png', 'https://cdn.example.com/acme.png'],
    ['a punycode host and a port', 'https://xn--bcher-kva.example:8443/acme.png', 'https://xn--bcher-kva.example:8443/acme.png'],
    ['an ipv6 host', 'https://[2001:db8::1]/acme.png', 'https://[2001:db8::1]/acme.png'],
    ['a base64 svg data url', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='],
  ])('accepts a logo with %s in canonical form', (_label, src, canonical) => {
    expect(parseTenantBranding({ logos: { light: { src } } })).toEqual({ ok: true, branding: { logos: { light: { src: canonical } } }, issues: [] })
  })

  it.each(DIRECTORY_ACCEPTED_LOGO_URLS)('keeps a logo with %s verbatim, exactly as the directory validator accepts it', (_label, src) => {
    expect(organizationLogoUrlSchema.safeParse(src).success).toBe(true)
    expect(parseTenantBranding(organizationBranding(src))).toEqual({ ok: true, branding: organizationBranding(src), issues: [] })
  })
})

describe('logo and host helpers', () => {
  it('reads the forwarded host first, lower-cases it and rejects junk', () => {
    expect(readTenantBrandingHost(new Headers({ host: 'internal:3000', 'x-forwarded-host': 'Acme.Example.com:3000' }))).toBe('acme.example.com:3000')
    expect(readTenantBrandingHost(new Headers({ host: 'internal:3000' }))).toBe('internal:3000')
    expect(readTenantBrandingHost(new Headers({ host: 'a.example.com', 'x-forwarded-host': 'a.example.com, proxy.internal' }))).toBe('a.example.com')
    expect(readTenantBrandingHost(new Headers({ host: 'evil.com/<script>' }))).toBeNull()
    expect(readTenantBrandingHost(null)).toBeNull()
  })

  it('maps the logos onto the backend chrome brand, and is null without a light logo', () => {
    expect(toBackendChromeBrand(acmeBranding)).toEqual({
      name: 'Acme Workspace',
      logo: { src: '/brand/acme.svg', alt: 'Acme' },
      darkLogo: { src: 'https://cdn.example.com/acme-dark.png', alt: 'Acme' },
      mark: { src: '/brand/acme-mark.svg' },
    })
    expect(toBackendChromeBrand(null)).toBeNull()
    expect(toBackendChromeBrand({ productName: 'Acme' })).toBeNull()
  })

  it('gives client components the logos and product name only', () => {
    const clientBranding = toClientTenantBranding(acmeBranding)
    expect(clientBranding).toEqual({ productName: acmeBranding.productName, logos: acmeBranding.logos })
    expect(Object.keys(clientBranding ?? {})).toEqual(['productName', 'logos'])
    expect(toClientTenantBranding({ style })).toBeNull()
    expect(toClientTenantBranding(null)).toBeNull()
  })
})

describe('resolveTenantBranding', () => {
  it('returns null when no provider is registered', async () => {
    await expect(resolveTenantBranding(makeContainer({}), input)).resolves.toBeNull()
  })

  it('hides the host from providers that do not vary by host and passes it to those that do', async () => {
    const plain = provider(() => acmeBranding)
    await resolveTenantBranding(makeContainer({ tenantBrandingProvider: plain }), input)
    expect(plain.resolve).toHaveBeenCalledWith(hostless)
    const hosted = provider(() => acmeBranding, { varyByHost: true })
    await resolveTenantBranding(makeContainer({ tenantBrandingProvider: hosted }), input)
    expect(hosted.resolve).toHaveBeenCalledWith({ ...input, host: 'acme.example.com' })
  })

  it('calls the default provider once when it is registered under both keys', async () => {
    const builtIn = provider(() => organizationBranding('/api/attachments/image/logo'))
    const container = makeContainer({ tenantBrandingProvider: builtIn, defaultTenantBrandingProvider: builtIn })
    await expect(resolveTenantBranding(container, input)).resolves.toEqual(organizationBranding('/api/attachments/image/logo'))
    expect(builtIn.resolve).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['throws', () => { throw new Error('upstream unavailable') }],
    ['rejects', () => Promise.reject(new Error('upstream unavailable'))],
    ['returns a non-object', () => 'Acme' as unknown as TenantBranding],
  ])('falls back to the default provider when the registered one %s, and reports it', async (_label, behaviour) => {
    await withTelemetry(async (reportError) => {
      const failing = provider(behaviour as () => TenantBranding)
      const fallback = provider(() => ({ productName: 'Default' }))
      const container = makeContainer({ tenantBrandingProvider: failing, defaultTenantBrandingProvider: fallback })
      await expect(resolveTenantBranding(container, input)).resolves.toEqual({ productName: 'Default' })
      expect(reportsWithCode(reportError, 'branding.provider_failed')).toHaveLength(1)
      expect(mockLogger.warn).toHaveBeenCalledWith('Tenant branding provider failed; falling back', expect.objectContaining({ role: 'registered', surface: 'backend' }))
    })
  })

  it('falls back when the registered provider throws synchronously or never answers', async () => {
    const throwing = { resolve: jest.fn(() => { throw new Error('sync failure') }) } as unknown as TenantBrandingProvider
    const fallback = provider(() => ({ productName: 'Default' }))
    await expect(resolveTenantBranding(makeContainer({ tenantBrandingProvider: throwing, defaultTenantBrandingProvider: fallback }), input)).resolves.toEqual({ productName: 'Default' })
    jest.useFakeTimers()
    try {
      const hanging = provider(() => new Promise<TenantBranding | null>(() => undefined))
      const pending = resolveTenantBranding(makeContainer({ tenantBrandingProvider: hanging, defaultTenantBrandingProvider: fallback }), input)
      await jest.advanceTimersByTimeAsync(PROVIDER_TIMEOUT_MS)
      await expect(pending).resolves.toEqual({ productName: 'Default' })
    } finally {
      jest.useRealTimers()
    }
  })

  it('keeps a branding with one invalid field, logging the dropped fields at debug only', async () => {
    await withTelemetry(async (reportError) => {
      const cache = countingCache()
      const custom = provider(() => ({ ...acmeBranding, style: unreadableStyle, logos: { ...acmeBranding.logos, dark: { src: 'javascript:alert(1)' } } }))
      const fallback = provider(() => ({ productName: 'Default' }))
      const container = makeContainer({ cache, tenantBrandingProvider: custom, defaultTenantBrandingProvider: fallback })
      await expect(resolveTenantBranding(container, input)).resolves.toEqual({
        productName: 'Acme Workspace',
        logos: { light: acmeBranding.logos?.light, mark: acmeBranding.logos?.mark },
      })
      expect(fallback.resolve).not.toHaveBeenCalled()
      expect(cache.writes.some((key) => key.includes('provider-failed'))).toBe(false)
      expect(mockLogger.debug).toHaveBeenCalledWith('Tenant branding provider returned invalid fields; they were dropped', expect.objectContaining({ issues: ['logos.dark', 'style'] }))
      expect(mockLogger.warn).not.toHaveBeenCalled()
      expect(reportError).not.toHaveBeenCalled()
    })
  })

  it('returns null when both providers fail', async () => {
    const container = makeContainer({ tenantBrandingProvider: provider(() => { throw new Error('down') }), defaultTenantBrandingProvider: provider(() => { throw new Error('down') }) })
    await expect(resolveTenantBranding(container, input)).resolves.toBeNull()
  })

  it('treats a throwing provider factory as a failure reported once per window, serving the cached default', async () => {
    await withTelemetry(async (reportError) => {
      const cache = countingCache()
      const fallback = provider(() => ({ productName: 'Default' }))
      const container = makeContainer({ cache, defaultTenantBrandingProvider: fallback }, { tenantBrandingProvider: () => { throw new Error('factory failed') } })
      for (let index = 0; index < 5; index += 1) {
        await expect(resolveTenantBranding(container, { ...input, host: randomHost() })).resolves.toEqual({ productName: 'Default' })
      }
      expect(reportsWithCode(reportError, 'branding.provider_failed')).toHaveLength(1)
      expect(cache.writes).toEqual([
        `tenant-branding:provider-failed:${TENANT_ID}:${ORG_ID}`,
        `tenant-branding:d:backend:${TENANT_ID}:${ORG_ID}`,
      ])
      expect(fallback.resolve).toHaveBeenCalledTimes(1)
    })
  })

  it('reports every default provider exception and never puts the default provider behind a failure window', async () => {
    await withTelemetry(async (reportError) => {
      const cache = countingCache()
      let calls = 0
      const builtIn = provider(() => {
        calls += 1
        if (calls <= 3) throw new Error('database blip')
        return organizationBranding('https://cdn.example.com/logo.png')
      })
      const container = makeContainer({ cache, tenantBrandingProvider: builtIn, defaultTenantBrandingProvider: builtIn })
      for (let index = 0; index < 3; index += 1) {
        await expect(resolveTenantBranding(container, input)).resolves.toBeNull()
      }
      await expect(resolveTenantBranding(container, input)).resolves.toEqual(organizationBranding('https://cdn.example.com/logo.png'))
      expect(builtIn.resolve).toHaveBeenCalledTimes(4)
      expect(reportsWithCode(reportError, 'branding.default_provider_failed')).toHaveLength(3)
      expect(reportsWithCode(reportError, 'branding.provider_failed')).toHaveLength(0)
      expect(cache.writes.some((key) => key.includes('provider-failed'))).toBe(false)
    })
  })

  it('keeps every directory-accepted organization logo through the default provider, one organization never affecting another', async () => {
    await withTelemetry(async (reportError) => {
      const cache = countingCache()
      const organizations = new Map<string, string>(DIRECTORY_ACCEPTED_LOGO_URLS.map(([, src], index) => [`org-${index}`, src]))
      organizations.set('legacy-invalid', 'javascript:alert(1)')
      const builtIn = provider(({ organizationId }) => organizationBranding(organizations.get(organizationId ?? '') ?? '/api/attachments/image/none', organizationId ?? ''))
      const container = makeContainer({ cache, tenantBrandingProvider: builtIn, defaultTenantBrandingProvider: builtIn })

      await expect(resolveTenantBranding(container, { ...input, organizationId: 'legacy-invalid' })).resolves.toEqual({ productName: 'legacy-invalid' })
      for (const [organizationId, src] of organizations) {
        if (organizationId === 'legacy-invalid') continue
        const branding = await resolveTenantBranding(container, { ...input, organizationId })
        expect(toBackendChromeBrand(branding)).toStrictEqual({ name: organizationId, logo: { src, alt: `${organizationId} logo`, preserveAspectRatio: false } })
      }
      expect(reportError).not.toHaveBeenCalled()
      expect(cache.writes.some((key) => key.includes('provider-failed'))).toBe(false)
    })
  })

  it('keeps http organization logos when a registered provider delegates to the default one as documented', async () => {
    const cache = countingCache()
    const builtIn = provider(() => organizationBranding('http://legacy.example.com/logo.png'))
    const documented: TenantBrandingProvider = {
      varyByHost: true,
      async resolve(resolveInput) {
        if (resolveInput.host === 'acme.example.com') return acmeBranding
        return builtIn.resolve(resolveInput)
      },
    }
    const container = makeContainer({ cache, tenantBrandingProvider: documented, defaultTenantBrandingProvider: builtIn })
    for (let index = 0; index < 3; index += 1) {
      await expect(resolveTenantBranding(container, { ...input, host: 'other.example.com' })).resolves.toEqual(organizationBranding('http://legacy.example.com/logo.png'))
    }
    await expect(resolveTenantBranding(container, input)).resolves.toEqual(acmeBranding)
    expect(cache.writes.some((key) => key.includes('provider-failed'))).toBe(false)
  })

  it('keeps registered and default answers apart in the cache, so a registration change never serves the other profile', async () => {
    const cache = createCacheService({ strategy: 'memory' })
    const builtIn = provider(() => organizationBranding('http://legacy.example.com/logo.png'))
    await resolveTenantBranding(makeContainer({ cache, tenantBrandingProvider: builtIn, defaultTenantBrandingProvider: builtIn }), input)
    const custom = provider(() => acmeBranding)
    await expect(resolveTenantBranding(makeContainer({ cache, tenantBrandingProvider: custom, defaultTenantBrandingProvider: builtIn }), input)).resolves.toEqual(acmeBranding)
    expect(custom.resolve).toHaveBeenCalledTimes(1)
  })

  it('isolates a login provider failure to the failing tenant', async () => {
    const cache = createCacheService({ strategy: 'memory' })
    const custom = provider(({ tenantId }) => {
      if (tenantId === TENANT_ID) throw new Error('tenant A data is broken')
      return acmeBranding
    })
    const container = makeContainer({ cache, tenantBrandingProvider: custom })
    const loginFor = (tenantId: string): TenantBrandingResolveInput => ({ tenantId, organizationId: null, host: null, surface: 'auth' })
    for (let index = 0; index < 5; index += 1) {
      await expect(resolveTenantBranding(container, loginFor(TENANT_ID))).resolves.toBeNull()
    }
    await expect(resolveTenantBranding(container, loginFor(OTHER_TENANT_ID))).resolves.toEqual(acmeBranding)
    expect(custom.resolve.mock.calls.filter(([call]) => call.tenantId === TENANT_ID)).toHaveLength(1)
  })

  it('isolates a provider failure to the failing organization of the tenant', async () => {
    const cache = createCacheService({ strategy: 'memory' })
    const custom = provider(({ organizationId }) => {
      if (organizationId === ORG_ID) throw new Error('organization A data is broken')
      return acmeBranding
    })
    const fallback = provider(() => null)
    const container = makeContainer({ cache, tenantBrandingProvider: custom, defaultTenantBrandingProvider: fallback })
    for (let index = 0; index < 5; index += 1) {
      await expect(resolveTenantBranding(container, hostless)).resolves.toBeNull()
    }
    await expect(resolveTenantBranding(container, { ...hostless, organizationId: OTHER_ORG_ID })).resolves.toEqual(acmeBranding)
    expect(custom.resolve.mock.calls.filter(([call]) => call.organizationId === ORG_ID)).toHaveLength(1)
  })

  it('never lets one failing host disable a host-varying provider for other hosts, and reports every such failure', async () => {
    await withTelemetry(async (reportError) => {
      const cache = countingCache()
      const custom = provider(({ host }) => {
        if (host === 'broken.example.com') throw new Error('broken host')
        return host === 'acme.example.com' ? acmeBranding : null
      }, { varyByHost: true })
      const container = makeContainer({ cache, tenantBrandingProvider: custom })
      const loginAt = (host: string): TenantBrandingResolveInput => ({ tenantId: null, organizationId: null, host, surface: 'auth' })
      for (let index = 0; index < 5; index += 1) await resolveTenantBranding(container, loginAt('broken.example.com'))
      await expect(resolveTenantBranding(container, loginAt('acme.example.com'))).resolves.toEqual(acmeBranding)
      expect(cache.writes).toEqual([])
      expect(reportsWithCode(reportError, 'branding.provider_failed')).toHaveLength(5)
    })
  })

  it('skips a failing registered provider for the tenant and organization for the failure window', async () => {
    jest.useFakeTimers()
    try {
      const cache = createCacheService({ strategy: 'memory' })
      const hanging = provider(() => new Promise<TenantBranding | null>(() => undefined))
      const fallback = provider(() => ({ productName: 'Default' }))
      const container = makeContainer({ cache, tenantBrandingProvider: hanging, defaultTenantBrandingProvider: fallback })
      const first = resolveTenantBranding(container, hostless)
      await jest.advanceTimersByTimeAsync(PROVIDER_TIMEOUT_MS)
      await expect(first).resolves.toEqual({ productName: 'Default' })
      await expect(resolveTenantBranding(container, hostless)).resolves.toEqual({ productName: 'Default' })
      expect(hanging.resolve).toHaveBeenCalledTimes(1)
      await jest.advanceTimersByTimeAsync(FAILURE_TTL_MS + 1)
      const retried = resolveTenantBranding(container, hostless)
      await jest.advanceTimersByTimeAsync(PROVIDER_TIMEOUT_MS)
      await retried
      expect(hanging.resolve).toHaveBeenCalledTimes(2)
    } finally {
      jest.useRealTimers()
    }
  })

  it('caches per tenant and re-resolves after the tenant is invalidated', async () => {
    const cache = createCacheService({ strategy: 'memory' })
    const custom = provider(() => acmeBranding)
    const container = makeContainer({ cache, tenantBrandingProvider: custom })
    await resolveTenantBranding(container, hostless)
    await resolveTenantBranding(container, hostless)
    expect(custom.resolve).toHaveBeenCalledTimes(1)
    await resolveTenantBranding(container, { ...hostless, tenantId: OTHER_TENANT_ID })
    expect(custom.resolve).toHaveBeenCalledTimes(2)
    await invalidateTenantBrandingCache(container, OTHER_TENANT_ID)
    await resolveTenantBranding(container, hostless)
    expect(custom.resolve).toHaveBeenCalledTimes(2)
    await invalidateTenantBrandingCache(container, TENANT_ID)
    await resolveTenantBranding(container, hostless)
    expect(custom.resolve).toHaveBeenCalledTimes(3)
  })

  it('caches a null login answer and drops it with any tenant invalidation', async () => {
    const cache = createCacheService({ strategy: 'memory' })
    const custom = provider(() => null)
    const container = makeContainer({ cache, tenantBrandingProvider: custom })
    const loginInput: TenantBrandingResolveInput = { tenantId: null, organizationId: null, host: null, surface: 'auth' }
    await resolveTenantBranding(container, loginInput)
    await resolveTenantBranding(container, loginInput)
    expect(custom.resolve).toHaveBeenCalledTimes(1)
    await invalidateTenantBrandingCache(container, TENANT_ID)
    await resolveTenantBranding(container, loginInput)
    expect(custom.resolve).toHaveBeenCalledTimes(2)
  })

  it('ignores a corrupted cache entry and resolves again', async () => {
    const cache = createCacheService({ strategy: 'memory' })
    const custom = provider(() => acmeBranding)
    const container = makeContainer({ cache, tenantBrandingProvider: custom })
    await resolveTenantBranding(container, hostless)
    const [key] = await runWithCacheTenant(TENANT_ID, () => cache.keys('tenant-branding:r:*'))
    await runWithCacheTenant(TENANT_ID, () => cache.set(key, { branding: { logos: { light: { src: 'javascript:alert(1)' } } } }))
    await expect(resolveTenantBranding(container, hostless)).resolves.toEqual(acmeBranding)
    expect(custom.resolve).toHaveBeenCalledTimes(2)
  })

  it('invalidates the tenant entries and the tenant-less entries', async () => {
    const calls: Array<{ tenant: string | null; tags: string[] }> = []
    const deleteByTags = jest.fn(async (tags: string[]) => {
      calls.push({ tenant: getCurrentCacheTenant(), tags })
      return 0
    })
    await invalidateTenantBrandingCache(makeContainer({ cache: { get: jest.fn(), set: jest.fn(), deleteByTags } }), TENANT_ID)
    expect(calls).toEqual([
      { tenant: TENANT_ID, tags: [`tenant-branding:tenant:${TENANT_ID}`] },
      { tenant: null, tags: ['tenant-branding:tenant:global'] },
    ])
  })
})

describe('cache growth under anonymous input', () => {
  const ATTEMPTS = 200

  it('keeps one entry per tenant whatever host a caller sends when the provider ignores hosts', async () => {
    const cache = countingCache()
    const container = makeContainer({ cache, tenantBrandingProvider: provider(() => null) })
    for (let index = 0; index < ATTEMPTS; index += 1) {
      await resolveTenantBranding(container, { ...input, host: randomHost() })
      await resolveTenantBranding(container, { tenantId: null, organizationId: null, host: randomHost(), surface: 'auth' })
    }
    expect(cache.writes).toHaveLength(2)
  })

  it('writes nothing keyed by a client-supplied host, even for a provider that brands every host', async () => {
    const cache = countingCache()
    const hosted = provider(({ host }) => (host === 'acme.example.com' ? acmeBranding : null), { varyByHost: true })
    const container = makeContainer({ cache, tenantBrandingProvider: hosted })
    for (let index = 0; index < ATTEMPTS; index += 1) {
      await resolveTenantBranding(container, { tenantId: null, organizationId: null, host: randomHost(), surface: 'auth' })
      await resolveTenantBranding(container, { ...input, host: randomHost() })
    }
    expect(cache.writes).toEqual([])
  })

  it('writes one failure marker per verified tenant, none for host-dependent failures, and serves the cached default meanwhile', async () => {
    const cache = countingCache()
    const failingHosted = provider(() => { throw new Error('down') }, { varyByHost: true })
    const fallback = provider(() => ({ productName: 'Default' }))
    for (let index = 0; index < ATTEMPTS; index += 1) {
      await resolveTenantBranding(makeContainer({ cache, tenantBrandingProvider: failingHosted, defaultTenantBrandingProvider: fallback }), { ...input, host: randomHost() })
    }
    expect(cache.writes).toEqual([`tenant-branding:d:backend:${TENANT_ID}:${ORG_ID}`])
    expect(fallback.resolve).toHaveBeenCalledTimes(1)
    const failing = provider(() => { throw new Error('down') })
    const container = makeContainer({ cache, tenantBrandingProvider: failing })
    for (let index = 0; index < ATTEMPTS; index += 1) {
      await resolveTenantBranding(container, { tenantId: index % 2 === 0 ? TENANT_ID : OTHER_TENANT_ID, organizationId: null, host: null, surface: 'auth' })
    }
    expect(cache.writes.filter((key) => key.includes('provider-failed'))).toHaveLength(2)
    expect(failing.resolve).toHaveBeenCalledTimes(2)
  })
})
