import { brandStyleSchema, type BrandStyle } from '@open-mercato/shared/lib/branding/brandStyle'

export { brandStyleCss } from '@open-mercato/shared/lib/branding/brandStyle'
export type { BrandStyle } from '@open-mercato/shared/lib/branding/brandStyle'

export const BRAND_STYLE_STORAGE_KEY = 'om-brand-style-v1'
export const BRAND_STYLE_EVENT = 'om-brand-style-change'
export const BRAND_STYLE_ELEMENT_ID = 'om-brand-style'

let cachedRaw: string | null | undefined
let cachedStyle: BrandStyle | null = null

export function getBrandStyle(): BrandStyle | null {
  if (typeof window === 'undefined') return null
  let raw: string | null
  try { raw = window.localStorage.getItem(BRAND_STYLE_STORAGE_KEY) } catch { return null }
  if (raw === cachedRaw) return cachedStyle
  cachedRaw = raw
  cachedStyle = null
  if (!raw || raw.length > 1_410_000) return null
  try {
    const result = brandStyleSchema.safeParse(JSON.parse(raw))
    if (result.success) cachedStyle = result.data
  } catch { return null }
  return cachedStyle
}

export function saveBrandStyle(style: BrandStyle | null): void {
  if (style === null) window.localStorage.removeItem(BRAND_STYLE_STORAGE_KEY)
  else {
    const result = brandStyleSchema.safeParse(style)
    if (!result.success) throw new Error('[internal] Invalid brand style')
    window.localStorage.setItem(BRAND_STYLE_STORAGE_KEY, JSON.stringify(result.data))
  }
  window.dispatchEvent(new Event(BRAND_STYLE_EVENT))
}

export function subscribeBrandStyle(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === BRAND_STYLE_STORAGE_KEY || event.key === null) onChange()
  }
  window.addEventListener(BRAND_STYLE_EVENT, onChange)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(BRAND_STYLE_EVENT, onChange)
    window.removeEventListener('storage', onStorage)
  }
}
