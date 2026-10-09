/** @jest-environment node */
import { getImgProps } from 'next/dist/shared/lib/get-img-props'
import defaultLoader from 'next/dist/shared/lib/image-loader'
import { imageConfigDefault } from 'next/dist/shared/lib/image-config'
import { parseTenantBranding } from '@open-mercato/shared/lib/branding/tenantBranding'

const ACCEPTED_SOURCES = [
  '/brand/acme.png',
  '/brand/acme.png?v=3',
  '/brand/acme.webp#logo',
  '/brand/acme logo.svg',
  '/brand/acme.svg?branding=dark',
  '/brand/logo.SVG',
  '/api/brand/logo',
  '/api/attachments/image/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/acme.svg?width=320&height=320',
  '/api/attachments/file/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '/api/attachments/image/abc?width=320&height=320',
  'https://cdn.example.com/acme.png',
  'HTTPS://cdn.example.com/acme.png?v=2',
  "https://cdn.example.com/acme's logo.png",
  'https://xn--bcher-kva.example:8443/acme.png',
  'https://[2001:db8::1]/acme.png',
  'data:image/png;base64,aGVsbG8=',
  'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
  'https://my_cdn.example.com/logo.png',
  'https://cdn.example.com./logo.png',
  'https://user:pw@cdn.example.com/logo.png',
  'https://-cdn.example.com/logo.png',
  'https://a..b.com/logo.png',
  `https://${'a'.repeat(70)}.example.com/logo.png`,
  'https://cdn*.example.com/logo.png',
  'https://cdn~.example.com/logo.png',
  'https://cdn.example.com/lo\tgo.png',
  'http://legacy.example.com/logo.png',
  'http://legacy.example.com/logo.png?v=1',
]

const REJECTED_SOURCES = [
  '/a\uD800b.png',
  '/x\uD83D.png',
  '/x\uDC00.png',
  'https://cdn.example.com/a\uD800.png',
  '//cdn.example.com/logo.png',
  'javascript:alert(1)',
  ' /brand/acme.png',
]

const SLOT_SIZES: Array<[number, number]> = [[40, 40], [120, 40], [96, 28], [28, 28], [22, 22], [20, 20], [150, 150]]

const nextDefaultImageConfig = {
  ...imageConfigDefault,
  localPatterns: [{ pathname: '**', search: '' }],
}

function acceptedSource(src: string): string | undefined {
  const parsed = parseTenantBranding({ logos: { light: { src } } })
  return parsed.ok ? parsed.branding?.logos?.light?.src : undefined
}

function renderWithNextImage(src: string, width: number, height: number, unoptimized?: true) {
  return getImgProps(
    { src, alt: 'logo', width, height, unoptimized },
    { defaultLoader, imgConf: nextDefaultImageConfig, showAltText: false, blurComplete: false },
  )
}

describe.each(['development', 'production'])('every accepted logo source renders with next/image in %s', (mode) => {
  const previousEnvironment = process.env.NODE_ENV

  beforeAll(() => {
    Object.assign(process.env, { NODE_ENV: mode })
  })

  afterAll(() => {
    Object.assign(process.env, { NODE_ENV: previousEnvironment })
  })

  it.each(ACCEPTED_SOURCES)('accepts and renders %s', (source) => {
    const src = acceptedSource(source)
    expect(src).toBeDefined()
    for (const [width, height] of SLOT_SIZES) {
      expect(renderWithNextImage(src as string, width, height, true).props.src).toBe(src)
    }
  })

  it('keeps the image optimiser for a caller logo prop, while the same path from a provider bypasses it', () => {
    const callerLogo = renderWithNextImage('/my-logo.png', 40, 40).props
    expect(callerLogo.src).toMatch(/^\/_next\/image\?url=%2Fmy-logo\.png&/)
    expect(callerLogo.srcSet).toEqual(expect.stringContaining('/_next/image?url=%2Fmy-logo.png'))
    const providerLogo = renderWithNextImage(acceptedSource('/my-logo.png') as string, 40, 40, true).props
    expect(providerLogo.src).toBe('/my-logo.png')
    expect(providerLogo.srcSet).toBeUndefined()
  })

  it.each(REJECTED_SOURCES)('rejects %j before it reaches next/image', (source) => {
    expect(acceptedSource(source)).toBeUndefined()
  })
})
