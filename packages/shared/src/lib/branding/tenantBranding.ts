import { z } from 'zod'
import { brandStyleSchema, type BrandStyle } from './brandStyle'
import type { BackendChromeBrand } from '../../modules/navigation/backendChrome'

export const TENANT_BRANDING_PROVIDER_DI_KEY = 'tenantBrandingProvider'
export const DEFAULT_TENANT_BRANDING_PROVIDER_DI_KEY = 'defaultTenantBrandingProvider'

export type TenantBrandingSurface = 'backend' | 'portal' | 'auth'

export type TenantBrandingLogo = {
  src: string
  alt?: string
  preserveAspectRatio?: boolean
}

export type TenantBrandingLogos = {
  light: TenantBrandingLogo
  dark?: TenantBrandingLogo
  mark?: TenantBrandingLogo
}

export type TenantBranding = {
  productName?: string
  logos?: TenantBrandingLogos
  style?: BrandStyle
}

/** The part of a branding that client components receive; the style is server-rendered only. */
export type ClientTenantBranding = {
  productName?: string
  logos?: TenantBrandingLogos
}

export type TenantBrandingResolveInput = {
  tenantId: string | null
  organizationId: string | null
  /** Normalised request host. Always `null` unless the provider declares `varyByHost: true`. */
  host: string | null
  surface: TenantBrandingSurface
}

export interface TenantBrandingProvider {
  resolve(input: TenantBrandingResolveInput): Promise<TenantBranding | null>
  /**
   * Opt in to receiving the request host. Results that depend on the host are never cached by the
   * resolver, so a provider that varies by host caches its own host lookups.
   */
  varyByHost?: boolean
}

const MAX_DATA_LOGO_LENGTH = 64 * 1024
const MAX_URL_LOGO_LENGTH = 8192
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
const ABSOLUTE_HTTPS_SOURCE = /^(https):\/\//i
const DATA_LOGO_PATTERN = /^data:image\/(?:png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/
const ROOT_RELATIVE_SOURCE = /^\/(?![/\\])/
const LOGO_SLOTS = ['light', 'dark', 'mark'] as const

type LogoSlot = typeof LOGO_SLOTS[number]

/**
 * The organization logo URL rule of the directory module (`organizations.logo_url`): an `http(s)`
 * URL or an attachment path. The directory validators use this schema, and every source it accepts
 * also renders as a tenant branding logo.
 */
export const organizationLogoUrlSchema = z.union([
  z.string().trim().url().max(2048).refine(
    (value) => value.startsWith('https://') || value.startsWith('http://'),
    { message: 'Logo URL must use http or https.' },
  ),
  z.string().trim().regex(/^\/api\/attachments\/(?:image|file)\/[A-Za-z0-9%_.~/?=&-]+$/).max(2048),
])

function canonicalizeLogoSource(value: string): string | null {
  if (CONTROL_CHARACTERS.test(value)) return null
  if (value.startsWith('data:')) {
    return value.length <= MAX_DATA_LOGO_LENGTH && DATA_LOGO_PATTERN.test(value) ? value : null
  }
  if (value.length > MAX_URL_LOGO_LENGTH) return null
  const absolute = ABSOLUTE_HTTPS_SOURCE.exec(value)
  if (absolute) {
    const canonical = `https${value.slice(absolute[1].length)}`
    try {
      return new URL(canonical).protocol === 'https:' ? canonical : null
    } catch {
      return null
    }
  }
  return ROOT_RELATIVE_SOURCE.test(value) ? value : null
}

/**
 * The logo source to render, or `null`. Accepted: a root-relative path (`/…`, not `//` or `/\`), an
 * `https://` URL that parses (scheme lower-cased), a base64 image data URL, and every source the
 * directory accepts for organization logos (`organizationLogoUrlSchema`, `http://` included), so
 * organization logos render as before, also when a provider delegates.
 */
function acceptLogoSource(value: string): string | null {
  if (!value || value !== value.trim() || !value.isWellFormed()) return null
  return canonicalizeLogoSource(value) ?? (organizationLogoUrlSchema.safeParse(value).success ? value : null)
}

type TenantBrandingParseResult =
  | { ok: true; branding: TenantBranding | null; issues: string[] }
  | { ok: false }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseLogo(value: unknown, slot: LogoSlot, issues: string[]): TenantBrandingLogo | null {
  const src = isRecord(value) && typeof value.src === 'string' ? acceptLogoSource(value.src) : null
  if (!isRecord(value) || src === null) {
    issues.push(`logos.${slot}`)
    return null
  }
  const logo: TenantBrandingLogo = { src }
  if (typeof value.alt === 'string') logo.alt = value.alt
  else if (value.alt !== undefined) issues.push(`logos.${slot}.alt`)
  if (typeof value.preserveAspectRatio === 'boolean') logo.preserveAspectRatio = value.preserveAspectRatio
  else if (value.preserveAspectRatio !== undefined) issues.push(`logos.${slot}.preserveAspectRatio`)
  for (const key of Object.keys(value)) {
    if (key !== 'src' && key !== 'alt' && key !== 'preserveAspectRatio') issues.push(`logos.${slot}.${key}`)
  }
  return logo
}

/**
 * Validates a provider result field by field: an invalid logo is dropped on its own (an invalid
 * `light` logo drops the whole `logos` group, whose other entries only refine it), an invalid style
 * or a blank product name is dropped, unknown fields are ignored, and every drop is listed in
 * `issues`. Only a value that is not an object at all is rejected.
 */
export function parseTenantBranding(value: unknown): TenantBrandingParseResult {
  if (value === null || value === undefined) return { ok: true, branding: null, issues: [] }
  if (!isRecord(value)) return { ok: false }
  const issues: string[] = []
  const branding: TenantBranding = {}
  for (const key of Object.keys(value)) {
    if (key !== 'productName' && key !== 'logos' && key !== 'style') issues.push(key)
  }
  if (typeof value.productName === 'string' && value.productName.trim()) branding.productName = value.productName
  else if (value.productName !== undefined) issues.push('productName')
  if (value.logos !== undefined) {
    if (!isRecord(value.logos)) {
      issues.push('logos')
    } else {
      const light = parseLogo(value.logos.light, 'light', issues)
      if (light) {
        const logos: TenantBrandingLogos = { light }
        if (value.logos.dark !== undefined) {
          const dark = parseLogo(value.logos.dark, 'dark', issues)
          if (dark) logos.dark = dark
        }
        if (value.logos.mark !== undefined) {
          const mark = parseLogo(value.logos.mark, 'mark', issues)
          if (mark) logos.mark = mark
        }
        branding.logos = logos
      }
      for (const key of Object.keys(value.logos)) {
        if (!(LOGO_SLOTS as readonly string[]).includes(key)) issues.push(`logos.${key}`)
      }
    }
  }
  if (value.style !== undefined) {
    const style = brandStyleSchema.safeParse(value.style)
    if (style.success) branding.style = { ...(style.data as BrandStyle), logo: null }
    else issues.push('style')
  }
  return { ok: true, branding, issues }
}

function pickLogo(logo: TenantBrandingLogo): TenantBrandingLogo {
  return { src: logo.src, alt: logo.alt, preserveAspectRatio: logo.preserveAspectRatio }
}

export function toClientTenantBranding(branding: TenantBranding | null | undefined): ClientTenantBranding | null {
  if (!branding) return null
  const clientBranding: ClientTenantBranding = {}
  if (branding.productName !== undefined) clientBranding.productName = branding.productName
  if (branding.logos) {
    clientBranding.logos = {
      light: pickLogo(branding.logos.light),
      ...(branding.logos.dark ? { dark: pickLogo(branding.logos.dark) } : {}),
      ...(branding.logos.mark ? { mark: pickLogo(branding.logos.mark) } : {}),
    }
  }
  return clientBranding.productName === undefined && !clientBranding.logos ? null : clientBranding
}

export function toBackendChromeBrand(branding: TenantBranding | null | undefined): BackendChromeBrand | null {
  const logos = branding?.logos
  if (!logos?.light?.src) return null
  return {
    name: branding?.productName,
    logo: pickLogo(logos.light),
    ...(logos.dark ? { darkLogo: pickLogo(logos.dark) } : {}),
    ...(logos.mark ? { mark: pickLogo(logos.mark) } : {}),
  }
}
