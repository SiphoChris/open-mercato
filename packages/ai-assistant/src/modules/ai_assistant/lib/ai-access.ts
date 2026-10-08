import type { RbacService } from '@open-mercato/core/modules/auth/services/rbacService'
import { hasRequiredFeatures } from './auth'
import { getToolRegistry } from './tool-registry'
import type { McpToolRegistry } from './types'

export type AiAccessSubject = {
  userFeatures: string[]
  isSuperAdmin: boolean
  unavailableModuleIds?: readonly string[]
  rbacService?: RbacService
}

type ToolModuleLookup = Pick<McpToolRegistry, 'getToolModuleId'>

type AccessibleTool = {
  name: string
  requiredFeatures?: string[]
}

type AccessibleAgent = {
  moduleId?: string
  requiredFeatures?: string[]
}

function includesModule(unavailableModuleIds: readonly string[] | undefined, moduleId: string | undefined): boolean {
  return Boolean(moduleId && unavailableModuleIds?.length && unavailableModuleIds.includes(moduleId))
}

/**
 * True when the module a tool is registered for is unavailable to the tenant
 * (per-tenant module availability), whatever feature guards the tool.
 */
export function isToolModuleUnavailable(
  toolName: string,
  unavailableModuleIds: readonly string[] | undefined,
  registry: ToolModuleLookup = getToolRegistry(),
): boolean {
  if (!unavailableModuleIds?.length) return false
  return includesModule(unavailableModuleIds, registry.getToolModuleId?.(toolName))
}

/**
 * The one predicate every surface that lists or executes AI tools applies: the
 * tool's registry module is available to the tenant and the caller holds the
 * tool's required features.
 */
export function isToolAccessible(
  tool: AccessibleTool,
  subject: AiAccessSubject,
  registry: ToolModuleLookup = getToolRegistry(),
): boolean {
  if (isToolModuleUnavailable(tool.name, subject.unavailableModuleIds, registry)) return false
  return hasRequiredFeatures(
    tool.requiredFeatures,
    subject.userFeatures,
    subject.isSuperAdmin,
    subject.rbacService,
    subject.unavailableModuleIds,
  )
}

/**
 * True when the module that registered an agent is unavailable to the tenant,
 * whatever features guard the agent.
 */
export function isAgentModuleUnavailable(
  agent: AccessibleAgent,
  unavailableModuleIds: readonly string[] | undefined,
): boolean {
  return includesModule(unavailableModuleIds, agent.moduleId)
}

/**
 * The one predicate every surface that lists or runs AI agents applies: the
 * agent's module is available to the tenant and the caller holds the agent's
 * required features.
 */
export function isAgentAccessible(agent: AccessibleAgent, subject: AiAccessSubject): boolean {
  if (isAgentModuleUnavailable(agent, subject.unavailableModuleIds)) return false
  return hasRequiredFeatures(
    agent.requiredFeatures,
    subject.userFeatures,
    subject.isSuperAdmin,
    subject.rbacService,
    subject.unavailableModuleIds,
  )
}
