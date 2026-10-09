import * as React from 'react'
import { brandStyleCss, parseBrandStyle, type BrandStyle } from '@open-mercato/shared/lib/branding/brandStyle'
import { TENANT_BRAND_STYLE_ELEMENT_ID } from './brand-style'

export type TenantBrandStyleProps = {
  brandStyle?: BrandStyle | null
}

/**
 * Server-renders a tenant's brand style before first paint. The per-browser gallery preview applied
 * by `BrandStyleRuntime` uses higher-specificity selectors in its own element, so it wins while it is
 * saved and this style shows again once it is cleared; neither element touches the other. Renders
 * nothing for a missing or invalid style.
 */
export function TenantBrandStyle({ brandStyle }: TenantBrandStyleProps) {
  const parsed = brandStyle ? parseBrandStyle(brandStyle) : null
  if (!parsed) return null
  return <style id={TENANT_BRAND_STYLE_ELEMENT_ID} dangerouslySetInnerHTML={{ __html: brandStyleCss(parsed) }} />
}
