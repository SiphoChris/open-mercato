import { z } from 'zod'

const hexColor = z.string().regex(/^#[0-9a-f]{6}$/i)
const tokensSchema = z.object({
  '--primary': hexColor,
  '--primary-hover': hexColor,
  '--primary-foreground': hexColor,
  '--brand-lime': hexColor.optional(),
  '--brand-yellow': hexColor.optional(),
  '--brand-violet': hexColor.optional(),
  '--brand-violet-foreground': hexColor.optional(),
}).strict()

function luminance(hex: string): number {
  const channels = [1, 3, 5].map(offset => {
    const channel = parseInt(hex.slice(offset, offset + 2), 16) / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
}

function readable(foreground: string, background: string): boolean {
  const first = luminance(foreground)
  const second = luminance(background)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05) >= 4.5
}

const shade = z.union([z.literal(50), z.literal(100), z.literal(200), z.literal(300), z.literal(400), z.literal(500), z.literal(600), z.literal(700), z.literal(800), z.literal(900), z.literal(950)])

export const brandStyleSchema = z.object({
  version: z.literal(1),
  logo: z.string().max(1_400_000).regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/).nullable(),
  light: tokensSchema,
  dark: tokensSchema,
  actionShades: z.object({ light: shade, dark: shade }).strict().optional(),
  seeds: z.object({ primary: hexColor, secondary: hexColor, tertiary: hexColor }).strict().optional(),
}).strict().refine(style => [style.light, style.dark].every(tokens =>
  readable(tokens['--primary-foreground'], tokens['--primary'])
  && readable(tokens['--primary-foreground'], tokens['--primary-hover'])
  && [tokens['--brand-lime'], tokens['--brand-yellow'], tokens['--brand-violet']].every(color => !color || Boolean(tokens['--brand-violet-foreground'] && readable(tokens['--brand-violet-foreground'], color))),
))

export type BrandStyle = {
  version: 1
  logo: string | null
  light: Record<string, string>
  dark: Record<string, string>
  actionShades?: { light: number; dark: number }
  seeds?: { primary: string; secondary: string; tertiary: string }
}

export function parseBrandStyle(value: unknown): BrandStyle | null {
  const result = brandStyleSchema.safeParse(value)
  return result.success ? result.data : null
}

export type BrandStyleCssOptions = {
  /**
   * `preview` raises the selectors' specificity (`html:root…`) so a per-browser preview wins over a
   * server-rendered tenant brand style regardless of document order. Defaults to the plain selectors.
   */
  layer?: 'base' | 'preview'
}

export function brandStyleCss(style: BrandStyle, options: BrandStyleCssOptions = {}): string {
  const parsed = brandStyleSchema.parse(style)
  const prefix = options.layer === 'preview' ? 'html' : ''
  const rule = (selector: string, tokens: Record<string, string | undefined>) => `${prefix}${selector}{${Object.entries(tokens).filter(([, value]) => value).map(([key, value]) => `${key}:${value};`).join('')}}`
  return `${rule(':root:not(.dark)', parsed.light)}\n${rule(':root.dark', parsed.dark)}`
}
