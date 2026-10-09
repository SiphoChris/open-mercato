import * as React from 'react'
import { act, render } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { BrandStyleRuntime } from '../BrandStyleRuntime'
import { TenantBrandStyle } from '../TenantBrandStyle'
import {
  BRAND_STYLE_ELEMENT_ID,
  TENANT_BRAND_STYLE_ELEMENT_ID,
  brandStyleCss,
  saveBrandStyle,
  type BrandStyle,
} from '../brand-style'

const tenantStyle: BrandStyle = {
  version: 1,
  logo: null,
  light: { '--primary': '#124488', '--primary-hover': '#113366', '--primary-foreground': '#FFFFFF' },
  dark: { '--primary': '#AACCFF', '--primary-hover': '#88AADD', '--primary-foreground': '#000000' },
}

const previewStyle: BrandStyle = {
  ...tenantStyle,
  light: { '--primary': '#5B2A86', '--primary-hover': '#4A2270', '--primary-foreground': '#FFFFFF' },
}

const otherTenantStyle: BrandStyle = {
  ...tenantStyle,
  light: { '--primary': '#0B5D3B', '--primary-hover': '#094A2F', '--primary-foreground': '#FFFFFF' },
}

type Specificity = [number, number, number]

function selectorSpecificity(selector: string): Specificity {
  const ids = (selector.match(/#[\w-]+/g) ?? []).length
  const classesAndPseudoClasses = (selector.match(/\.[\w-]+|:(?!:)[\w-]+/g) ?? []).length
  const elements = (selector.replace(/\([^)]*\)/g, '').match(/(^|[\s>+~])[a-z][\w-]*/gi) ?? []).length
  return [ids, classesAndPseudoClasses, elements]
}

function compareSpecificity(first: Specificity, second: Specificity): number {
  for (let index = 0; index < 3; index += 1) {
    if (first[index] !== second[index]) return first[index] - second[index]
  }
  return 0
}

function selectorsOf(css: string): string[] {
  return css.split('\n').map((rule) => rule.slice(0, rule.indexOf('{')))
}

function tenantElements(): HTMLStyleElement[] {
  return Array.from(document.querySelectorAll<HTMLStyleElement>(`#${TENANT_BRAND_STYLE_ELEMENT_ID}`))
}

function TenantPage({ style }: { style: BrandStyle | null }) {
  return <>{style ? <TenantBrandStyle brandStyle={style} /> : null}<BrandStyleRuntime /></>
}

beforeEach(() => { window.localStorage.clear() })

describe('TenantBrandStyle', () => {
  it('server-renders the tenant tokens in its own element', () => {
    const markup = renderToStaticMarkup(<TenantBrandStyle brandStyle={tenantStyle} />)
    expect(markup).toBe(
      `<style id="${TENANT_BRAND_STYLE_ELEMENT_ID}">:root:not(.dark){--primary:#124488;--primary-hover:#113366;--primary-foreground:#FFFFFF;}\n:root.dark{--primary:#AACCFF;--primary-hover:#88AADD;--primary-foreground:#000000;}</style>`,
    )
    expect(TENANT_BRAND_STYLE_ELEMENT_ID).not.toBe(BRAND_STYLE_ELEMENT_ID)
  })

  it('renders nothing without a style or for a style failing contrast', () => {
    expect(renderToStaticMarkup(<TenantBrandStyle brandStyle={null} />)).toBe('')
    const unreadable = { ...tenantStyle, light: { '--primary': '#CCCCCC', '--primary-hover': '#BBBBBB', '--primary-foreground': '#DDDDDD' } }
    expect(renderToStaticMarkup(<TenantBrandStyle brandStyle={unreadable} />)).toBe('')
  })
})

describe('gallery preview over a tenant brand style', () => {
  it('gives every preview rule a higher specificity than the matching tenant rule', () => {
    const tenantSelectors = selectorsOf(brandStyleCss(tenantStyle))
    const previewSelectors = selectorsOf(brandStyleCss(previewStyle, { layer: 'preview' }))
    expect(previewSelectors).toHaveLength(tenantSelectors.length)
    previewSelectors.forEach((previewSelector, index) => {
      expect(compareSpecificity(selectorSpecificity(previewSelector), selectorSpecificity(tenantSelectors[index]))).toBeGreaterThan(0)
    })
  })

  it('keeps the base selectors for callers that do not ask for the preview layer', () => {
    expect(brandStyleCss(tenantStyle)).toBe(brandStyleCss(tenantStyle, { layer: 'base' }))
    expect(selectorsOf(brandStyleCss(tenantStyle))).toEqual([':root:not(.dark)', ':root.dark'])
  })

  it('applies the preview in its own element and never touches the tenant element', () => {
    const view = render(<TenantPage style={tenantStyle} />)
    const [tenantElement] = tenantElements()
    const tenantCss = tenantElement.textContent

    act(() => saveBrandStyle(previewStyle))
    const previewElement = document.getElementById(BRAND_STYLE_ELEMENT_ID)
    expect(previewElement?.parentElement).toBe(document.head)
    expect(previewElement?.textContent).toContain('html:root:not(.dark){--primary:#5B2A86;')
    expect(tenantElements()).toEqual([tenantElement])
    expect(tenantElement.textContent).toBe(tenantCss)

    act(() => saveBrandStyle(null))
    expect(document.getElementById(BRAND_STYLE_ELEMENT_ID)).toBeNull()
    expect(tenantElement.textContent).toBe(tenantCss)
    view.unmount()
  })

  it('stays correct when client navigation mounts, replaces or removes the tenant style during a preview', () => {
    saveBrandStyle(previewStyle)
    const view = render(<TenantPage style={null} />)
    const previewElement = document.getElementById(BRAND_STYLE_ELEMENT_ID)
    expect(previewElement).not.toBeNull()

    view.rerender(<TenantPage style={tenantStyle} />)
    expect(tenantElements()).toHaveLength(1)
    expect(tenantElements()[0].textContent).toContain('--primary:#124488;')
    expect(document.getElementById(BRAND_STYLE_ELEMENT_ID)).toBe(previewElement)

    view.rerender(<TenantPage style={otherTenantStyle} />)
    expect(tenantElements()).toHaveLength(1)
    expect(tenantElements()[0].textContent).toContain('--primary:#0B5D3B;')
    expect(document.getElementById(BRAND_STYLE_ELEMENT_ID)).toBe(previewElement)

    view.rerender(<TenantPage style={null} />)
    expect(tenantElements()).toHaveLength(0)
    expect(document.getElementById(BRAND_STYLE_ELEMENT_ID)).toBe(previewElement)

    act(() => saveBrandStyle(null))
    expect(document.getElementById(BRAND_STYLE_ELEMENT_ID)).toBeNull()
    view.unmount()
  })

  it('watches nothing in the document', () => {
    const observe = jest.spyOn(MutationObserver.prototype, 'observe')
    saveBrandStyle(previewStyle)
    const view = render(<TenantPage style={tenantStyle} />)
    expect(observe).not.toHaveBeenCalled()
    view.unmount()
    observe.mockRestore()
  })
})
