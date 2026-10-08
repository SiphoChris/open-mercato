import { createLogger } from '@open-mercato/shared/lib/logger'
import type { AwilixContainer } from 'awilix'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { RbacService } from '@open-mercato/core/modules/auth/services/rbacService'
import { authorizeFeatures } from '@open-mercato/shared/security/featurePolicy'

const logger = createLogger('ai_assistant')

/**
 * Successful authentication result.
 */
export type McpAuthSuccess = {
  success: true
  keyId: string
  keyName: string
  tenantId: string | null
  organizationId: string | null
  userId: string
  features: string[]
  isSuperAdmin: boolean
  /** Modules unavailable to the key's tenant (per-tenant module availability). */
  unavailableModuleIds?: readonly string[]
}

/**
 * Failed authentication result.
 */
export type McpAuthFailure = {
  success: false
  error: string
}

/**
 * Result from MCP authentication.
 */
export type McpAuthResult = McpAuthSuccess | McpAuthFailure

/**
 * Authenticate an MCP request using an API key.
 *
 * This function validates the API key secret and loads the associated
 * ACL (features, organizations, super admin status) from the key's roles.
 *
 * @param apiKeySecret - The full API key secret (e.g., 'omk_xxxx.yyyy...')
 * @param container - Awilix DI container with 'em' and 'rbacService'
 * @returns Authentication result with user context or error
 */
export async function authenticateMcpRequest(
  apiKeySecret: string,
  container: AwilixContainer
): Promise<McpAuthResult> {
  if (!apiKeySecret || typeof apiKeySecret !== 'string') {
    return { success: false, error: 'API key is required' }
  }

  const trimmedSecret = apiKeySecret.trim()
  if (!trimmedSecret) {
    return { success: false, error: 'API key is required' }
  }

  if (!trimmedSecret.startsWith('omk_')) {
    return { success: false, error: 'Invalid API key format' }
  }

  try {
    const em = container.resolve('em') as EntityManager

    const { findApiKeyBySecret } = await import(
      '@open-mercato/core/modules/api_keys/services/apiKeyService'
    )

    const apiKey = await findApiKeyBySecret(em, trimmedSecret)

    if (!apiKey) {
      return { success: false, error: 'Invalid or expired API key' }
    }

    const userId = `api_key:${apiKey.id}`

    const rbacService = container.resolve('rbacService') as {
      loadAcl: (
        userId: string,
        scope: { tenantId: string | null; organizationId: string | null }
      ) => Promise<{
        isSuperAdmin: boolean
        features: string[]
        organizations: string[] | null
      }>
      getUnavailableModuleIds?: (tenantId: string | null, userId?: string | null) => Promise<string[]>
    }

    const acl = await rbacService.loadAcl(userId, {
      tenantId: apiKey.tenantId ?? null,
      organizationId: apiKey.organizationId ?? null,
    })

    try {
      apiKey.lastUsedAt = new Date()
      await em.persist(apiKey).flush()
    } catch {
      // Best-effort update; ignore write failures
    }

    return {
      success: true,
      keyId: apiKey.id,
      keyName: apiKey.name,
      tenantId: apiKey.tenantId ?? null,
      organizationId: apiKey.organizationId ?? null,
      userId,
      features: acl.features,
      isSuperAdmin: acl.isSuperAdmin,
      unavailableModuleIds: await loadUnavailableModuleIds(rbacService, apiKey.tenantId ?? null, userId),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error('MCP authentication failed', { err: error })
    return { success: false, error: 'Authentication failed' }
  }
}

/**
 * Check if user has the required features for a resource.
 *
 * Supports:
 * - Super admin bypass (always returns true)
 * - Direct feature match (e.g., 'customers.view')
 * - Global wildcard ('*' grants all features)
 * - Prefix wildcard (e.g., 'customers.*' grants 'customers.people.view' and the
 *   bare 'customers' segment itself)
 *
 * @param requiredFeatures - List of features required for access
 * @param userFeatures - List of features the user has
 * @param isSuperAdmin - Whether the user is a super admin
 * @param rbacService - Optional RbacService to delegate feature matching
 * @param unavailableModuleIds - Modules unavailable to the caller's tenant
 *   (per-tenant module availability); their features are denied even to a
 *   super admin. Load them with `loadUnavailableModuleIds`.
 * @returns True if user has access
 */
export function hasRequiredFeatures(
  requiredFeatures: string[] | undefined,
  userFeatures: string[],
  isSuperAdmin: boolean,
  rbacService?: RbacService,
  unavailableModuleIds?: readonly string[],
): boolean {
  void rbacService
  return authorizeFeatures(requiredFeatures ?? [], {
    grantedFeatures: userFeatures,
    unrestricted: isSuperAdmin,
    unavailableModuleIds,
  })
}

type UnavailableModuleIdsReader = {
  getUnavailableModuleIds?: (tenantId: string | null, userId?: string | null) => Promise<string[]>
}

/**
 * Module ids unavailable to the caller's tenant through the optional per-tenant
 * module availability provider; empty when none is registered.
 */
export async function loadUnavailableModuleIds(
  rbacService: UnavailableModuleIdsReader | null | undefined,
  tenantId: string | null | undefined,
  userId: string | null | undefined,
): Promise<string[]> {
  if (!rbacService || typeof rbacService.getUnavailableModuleIds !== 'function') return []
  return rbacService.getUnavailableModuleIds(tenantId ?? null, userId ?? null)
}

type RbacContainer = {
  resolve: (name: string) => unknown
  hasRegistration?: (name: string) => boolean
}

/**
 * Fail-safe default for callers that build an AI context without
 * `unavailableModuleIds`: reads the set from the container's `rbacService`.
 */
export async function resolveUnavailableModuleIdsFromContainer(
  container: RbacContainer | null | undefined,
  tenantId: string | null | undefined,
  userId: string | null | undefined,
): Promise<string[]> {
  if (!container || typeof container.resolve !== 'function') return []
  if (typeof container.hasRegistration !== 'function' || !container.hasRegistration('rbacService')) return []
  const rbacService = container.resolve('rbacService') as UnavailableModuleIdsReader | null | undefined
  return loadUnavailableModuleIds(rbacService, tenantId, userId)
}

/**
 * Extract API key from HTTP request headers.
 *
 * Supports two header formats:
 * - x-api-key: <secret>
 * - Authorization: ApiKey <secret>
 *
 * @param headers - Request headers (Map, Headers, or plain object)
 * @returns The API key secret or null if not found
 */
export function extractApiKeyFromHeaders(
  headers: Headers | Map<string, string> | Record<string, string | undefined>
): string | null {
  const getHeader = (name: string): string | null => {
    if (headers instanceof Headers) {
      return headers.get(name)
    }
    if (headers instanceof Map) {
      return headers.get(name) ?? null
    }
    const value = headers[name] ?? headers[name.toLowerCase()]
    return typeof value === 'string' ? value : null
  }

  const xApiKey = getHeader('x-api-key')?.trim()
  if (xApiKey) {
    return xApiKey
  }

  const authHeader = getHeader('authorization')?.trim()
  if (authHeader && authHeader.toLowerCase().startsWith('apikey ')) {
    return authHeader.slice(7).trim()
  }

  return null
}
