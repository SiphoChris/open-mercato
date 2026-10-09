import { runWithCacheTenant } from '@open-mercato/cache'
import { createLogger } from '../logger'
import { getTelemetryRuntime } from '../telemetry/runtime'
import {
  DEFAULT_TENANT_BRANDING_PROVIDER_DI_KEY,
  TENANT_BRANDING_PROVIDER_DI_KEY,
  parseTenantBranding,
  type TenantBranding,
  type TenantBrandingProvider,
  type TenantBrandingResolveInput,
} from './tenantBranding'

const logger = createLogger('shared').child({ component: 'tenantBranding' })

const CACHE_TAG = 'tenant-branding'
const CACHE_TTL_MS = 5 * 60 * 1000
const FAILURE_TTL_MS = 30 * 1000
const PROVIDER_TIMEOUT_MS = 3000
const HOST_PATTERN = /^[a-z0-9.-]+(?::\d{1,5})?$/

export type TenantBrandingContainer = {
  resolve: (name: string) => unknown
  hasRegistration?: (name: string) => boolean
}

type BrandingCache = {
  get: (key: string) => Promise<unknown>
  set: (key: string, value: unknown, options?: { ttl?: number; tags?: string[] }) => Promise<unknown>
  deleteByTags: (tags: string[]) => Promise<number>
}

type ProviderLookup =
  | { status: 'missing' }
  | { status: 'failed'; error: unknown }
  | { status: 'found'; provider: TenantBrandingProvider }

type ProviderOutcome = { ok: true; branding: TenantBranding | null } | { ok: false }

/**
 * Which provider answers: `registered` is an app's `tenantBrandingProvider`, `default` the built-in
 * `defaultTenantBrandingProvider` (also when it is registered under both keys). Only a registered
 * provider is put behind a failure window; the default one is the last resort and always runs.
 */
type ProviderRole = 'registered' | 'default'

class TenantBrandingProviderError extends Error {
  constructor(message: string) {
    super(`[internal] ${message}`)
    this.name = 'TenantBrandingProviderError'
  }
}

function reportCacheFailure(message: string, err: unknown): void {
  logger.warn(message, { err })
  getTelemetryRuntime()?.reportError(err, { module: 'branding', code: 'branding.cache_failed' })
}

function reportProviderFailure(err: unknown, role: ProviderRole, input: TenantBrandingResolveInput): void {
  logger.warn('Tenant branding provider failed; falling back', { err, role, surface: input.surface, tenantId: input.tenantId })
  getTelemetryRuntime()?.reportError(err, {
    module: 'branding',
    code: role === 'default' ? 'branding.default_provider_failed' : 'branding.provider_failed',
    attributes: { surface: input.surface },
  })
}

export function buildTenantBrandingCacheTag(tenantId: string | null): string {
  return `${CACHE_TAG}:tenant:${tenantId ?? 'global'}`
}

function normalizeTenantBrandingHost(host: string | null | undefined): string | null {
  if (typeof host !== 'string') return null
  const value = host.split(',')[0].trim().toLowerCase()
  if (!value || value.length > 255 || !HOST_PATTERN.test(value)) return null
  return value
}

export function readTenantBrandingHost(headers: { get(name: string): string | null } | null | undefined): string | null {
  if (!headers) return null
  return normalizeTenantBrandingHost(headers.get('x-forwarded-host') ?? headers.get('host'))
}

function buildCacheKey(role: ProviderRole, input: TenantBrandingResolveInput): string {
  return [CACHE_TAG, role === 'default' ? 'd' : 'r', input.surface, input.tenantId ?? '-', input.organizationId ?? '-'].join(':')
}

function buildFailureKey(input: TenantBrandingResolveInput): string {
  return `${CACHE_TAG}:provider-failed:${input.tenantId ?? 'global'}:${input.organizationId ?? '-'}`
}

function isProvider(value: unknown): value is TenantBrandingProvider {
  return Boolean(value) && typeof (value as TenantBrandingProvider).resolve === 'function'
}

function lookupProvider(container: TenantBrandingContainer, name: string): ProviderLookup {
  const registered = typeof container.hasRegistration === 'function' ? container.hasRegistration(name) : null
  if (registered === false) return { status: 'missing' }
  try {
    const value = container.resolve(name)
    if (value === null || value === undefined) return { status: 'missing' }
    if (!isProvider(value)) return { status: 'failed', error: new TenantBrandingProviderError(`${name} does not implement resolve()`) }
    return { status: 'found', provider: value }
  } catch (error) {
    return registered === null ? { status: 'missing' } : { status: 'failed', error }
  }
}

function resolveCache(container: TenantBrandingContainer): BrandingCache | null {
  try {
    const cache = container.resolve('cache') as Partial<BrandingCache> | null | undefined
    if (!cache || typeof cache.get !== 'function' || typeof cache.set !== 'function') return null
    return cache as BrandingCache
  } catch {
    return null
  }
}

async function withProviderTimeout<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new TenantBrandingProviderError(`Tenant branding provider did not answer within ${PROVIDER_TIMEOUT_MS} ms`)),
      PROVIDER_TIMEOUT_MS,
    )
  })
  try {
    return await Promise.race([pending, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function runProvider(provider: TenantBrandingProvider, input: TenantBrandingResolveInput, role: ProviderRole): Promise<ProviderOutcome> {
  try {
    const parsed = parseTenantBranding(await withProviderTimeout(Promise.resolve().then(() => provider.resolve({ ...input }))))
    if (!parsed.ok) {
      reportProviderFailure(new TenantBrandingProviderError('Tenant branding provider returned a non-object'), role, input)
      return { ok: false }
    }
    if (parsed.issues.length > 0) {
      logger.debug('Tenant branding provider returned invalid fields; they were dropped', { role, issues: parsed.issues, surface: input.surface, tenantId: input.tenantId })
    }
    return { ok: true, branding: parsed.branding }
  } catch (err) {
    reportProviderFailure(err, role, input)
    return { ok: false }
  }
}

async function readCache(cache: BrandingCache | null, key: string, tenantId: string | null): Promise<unknown> {
  if (!cache) return null
  try {
    return await runWithCacheTenant(tenantId, () => cache.get(key))
  } catch (err) {
    reportCacheFailure('Tenant branding cache read failed', err)
    return null
  }
}

async function writeCache(cache: BrandingCache | null, key: string, tenantId: string | null, value: unknown, ttl: number): Promise<void> {
  if (!cache) return
  try {
    await runWithCacheTenant(tenantId, () => cache.set(key, value, { ttl, tags: [buildTenantBrandingCacheTag(tenantId)] }))
  } catch (err) {
    reportCacheFailure('Tenant branding cache write failed', err)
  }
}

function withHost(input: TenantBrandingResolveInput, provider: TenantBrandingProvider, host: string | null): TenantBrandingResolveInput {
  return { ...input, host: provider.varyByHost === true ? host : null }
}

/**
 * Answers from the cache, then from the provider. Host-dependent answers and failures are never
 * cached: any client can send any `Host`, and one failing host must not disable the provider for
 * the others, so such a provider runs (and a failure is reported) on every request. Every other
 * answer, `null` included, is cached per tenant and organization, which callers pass only verified.
 */
async function resolveWith(
  provider: TenantBrandingProvider,
  role: ProviderRole,
  input: TenantBrandingResolveInput,
  cache: BrandingCache | null,
): Promise<ProviderOutcome> {
  const cacheable = input.host === null
  const key = buildCacheKey(role, input)
  if (cacheable) {
    const cached = await readCache(cache, key, input.tenantId)
    if (cached && typeof cached === 'object' && 'branding' in cached) {
      const parsed = parseTenantBranding(cached.branding)
      if (parsed.ok && parsed.issues.length === 0) return { ok: true, branding: parsed.branding }
    }
  }
  const failureKey = role === 'registered' && cacheable ? buildFailureKey(input) : null
  if (failureKey && await readCache(cache, failureKey, input.tenantId)) return { ok: false }
  const outcome = await runProvider(provider, input, role)
  if (outcome.ok && cacheable) await writeCache(cache, key, input.tenantId, { branding: outcome.branding }, CACHE_TTL_MS)
  if (!outcome.ok && failureKey) await writeCache(cache, failureKey, input.tenantId, true, FAILURE_TTL_MS)
  return outcome
}

/**
 * Resolves the branding for a tenant-scoped surface. Never throws: a missing, failing or hanging
 * provider — or one whose DI factory throws — degrades to `defaultTenantBrandingProvider`, and then
 * to `null` (the platform default); invalid fields are dropped one by one. After a registered
 * provider fails, it is skipped for that tenant and organization for 30 seconds. Pass only tenant
 * and organization ids that come from a session or a database lookup.
 */
export async function resolveTenantBranding(
  container: TenantBrandingContainer,
  rawInput: TenantBrandingResolveInput,
): Promise<TenantBranding | null> {
  const host = normalizeTenantBrandingHost(rawInput.host)
  const input: TenantBrandingResolveInput = {
    tenantId: rawInput.tenantId ?? null,
    organizationId: rawInput.organizationId ?? null,
    host: null,
    surface: rawInput.surface,
  }
  const cache = resolveCache(container)
  const registered = lookupProvider(container, TENANT_BRANDING_PROVIDER_DI_KEY)
  const fallback = lookupProvider(container, DEFAULT_TENANT_BRANDING_PROVIDER_DI_KEY)
  const defaultProvider = fallback.status === 'found' ? fallback.provider : null

  if (registered.status === 'found' && registered.provider !== defaultProvider) {
    const outcome = await resolveWith(registered.provider, 'registered', withHost(input, registered.provider, host), cache)
    if (outcome.ok) return outcome.branding
  } else if (registered.status === 'failed') {
    const failureKey = buildFailureKey(input)
    if (!(await readCache(cache, failureKey, input.tenantId))) {
      reportProviderFailure(registered.error, 'registered', input)
      await writeCache(cache, failureKey, input.tenantId, true, FAILURE_TTL_MS)
    }
  }
  if (!defaultProvider) return null
  const outcome = await resolveWith(defaultProvider, 'default', withHost(input, defaultProvider, host), cache)
  return outcome.ok ? outcome.branding : null
}

/**
 * Drops every cached branding entry of a tenant and the tenant-less entries; `null` drops the
 * tenant-less entries alone. Call it whenever the data a provider reads changes.
 */
export async function invalidateTenantBrandingCache(
  container: TenantBrandingContainer,
  tenantId: string | null,
): Promise<void> {
  const cache = resolveCache(container)
  if (!cache || typeof cache.deleteByTags !== 'function') return
  try {
    if (tenantId) await runWithCacheTenant(tenantId, () => cache.deleteByTags([buildTenantBrandingCacheTag(tenantId)]))
    await runWithCacheTenant(null, () => cache.deleteByTags([buildTenantBrandingCacheTag(null)]))
  } catch (err) {
    reportCacheFailure('Tenant branding cache invalidation failed', err)
  }
}
