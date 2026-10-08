import { z } from 'zod'
import type { AwilixContainer } from 'awilix'
import type { ApiKey } from '@open-mercato/core/modules/api_keys/data/entities'
import type { AiAgentDefinition } from '../ai-agent-definition'
import type { AiToolDefinition, McpToolContext } from '../types'
import type { AiPendingAction } from '../../data/entities'
import { checkAgentPolicy } from '../agent-policy'
import { resetAgentRegistryForTests, seedAgentRegistryForTests } from '../agent-registry'
import { toolRegistry, registerMcpTool } from '../tool-registry'
import { executeTool } from '../tool-executor'
import { resolveAiAgentTools } from '../agent-tools'
import { runPendingActionRechecks } from '../pending-action-recheck'
import { resolveApiKeyContext } from '../http-server'
import { hasRequiredFeatures, loadUnavailableModuleIds } from '../auth'
import { authorizeCodeModeApiRequest } from '../codemode-tools'
import { createAiApiOperationRunner } from '../ai-api-operation-runner'
import type { ApiRouteManifestEntry } from '@open-mercato/shared/modules/registry'
import { getApiEndpoints } from '../api-endpoint-index'
import metaAiTools from '../../ai-tools/meta-pack'
import { InProcessMcpClient } from '../in-process-client'
import { applyAiToolOverrideEntries } from '../tool-loader'
import type { NextRequest } from 'next/server'

jest.mock('../api-endpoint-index', () => ({
  ...jest.requireActual('../api-endpoint-index'),
  getApiEndpoints: jest.fn(),
}))

const salesTool: AiToolDefinition = {
  name: 'sales.list_orders',
  description: 'List orders',
  inputSchema: z.object({}),
  requiredFeatures: ['sales.orders.view'],
  handler: async () => ({ orders: [] }),
}

const assistantTool: AiToolDefinition = {
  name: 'ai_assistant.echo',
  description: 'Echo',
  inputSchema: z.object({}),
  requiredFeatures: ['ai_assistant.view'],
  handler: async () => ({ ok: true }),
}

const salesAgent: AiAgentDefinition = {
  id: 'sales.assistant',
  moduleId: 'sales',
  label: 'Sales assistant',
  description: 'Sales assistant',
  systemPrompt: 'You are a test agent.',
  allowedTools: ['sales.list_orders'],
  requiredFeatures: ['sales.orders.view'],
}

const generalAgent: AiAgentDefinition = {
  id: 'ai_assistant.general',
  moduleId: 'ai_assistant',
  label: 'General assistant',
  description: 'General assistant',
  systemPrompt: 'You are a test agent.',
  allowedTools: ['sales.list_orders', 'ai_assistant.echo'],
  requiredFeatures: ['ai_assistant.view'],
}

function containerWithUnavailable(unavailable: string[]): AwilixContainer {
  const rbacService = { getUnavailableModuleIds: jest.fn(async (): Promise<string[]> => unavailable) }
  return {
    resolve: (name: string) => (name === 'rbacService' ? rbacService : {}),
    hasRegistration: (name: string) => name === 'rbacService',
  } as unknown as AwilixContainer
}

function superAdminContext(unavailableModuleIds?: readonly string[], container?: AwilixContainer): McpToolContext {
  return {
    tenantId: 'tenant-a',
    organizationId: null,
    userId: 'admin',
    container: container ?? containerWithUnavailable([]),
    userFeatures: ['*'],
    isSuperAdmin: true,
    unavailableModuleIds,
  }
}

function pendingAkeneoFixtures() {
  const akeneoMutation: AiToolDefinition = {
    name: 'akeneo.delete_products',
    description: 'Delete products',
    inputSchema: z.object({}),
    requiredFeatures: ['data_sync.configure'],
    isMutation: true,
    handler: async () => ({ deleted: true }),
  }
  const akeneoAgent: AiAgentDefinition = {
    id: 'sync_akeneo.assistant',
    moduleId: 'sync_akeneo',
    label: 'Akeneo assistant',
    description: 'Akeneo assistant',
    systemPrompt: 'You are a test agent.',
    allowedTools: ['akeneo.delete_products'],
    requiredFeatures: ['ai_assistant.view'],
    mutationPolicy: 'confirm-required',
  }
  const helperAgent: AiAgentDefinition = {
    ...generalAgent,
    id: 'ai_assistant.akeneo_helper',
    allowedTools: ['akeneo.delete_products'],
    mutationPolicy: 'confirm-required',
  }
  const recheckFor = (
    agent: AiAgentDefinition,
    unavailable: string[],
    userFeatures: string[] = ['data_sync.configure', 'ai_assistant.view'],
  ) => runPendingActionRechecks({
    action: {
      id: 'pa_akeneo',
      tenantId: 'tenant-a',
      organizationId: null,
      agentId: agent.id,
      toolName: 'akeneo.delete_products',
      status: 'pending',
      expiresAt: new Date(Date.now() + 60_000),
    } as unknown as AiPendingAction,
    agent,
    tool: akeneoMutation,
    ctx: {
      tenantId: 'tenant-a',
      organizationId: null,
      userId: 'user-1',
      userFeatures,
      isSuperAdmin: false,
      unavailableModuleIds: unavailable,
      container: containerWithUnavailable(unavailable),
      em: {} as never,
    },
  })
  return { akeneoMutation, akeneoAgent, helperAgent, recheckFor }
}

describe('AI tool and agent gating with per-tenant module availability', () => {
  beforeEach(() => {
    resetAgentRegistryForTests()
    toolRegistry.clear()
    registerMcpTool(salesTool, { moduleId: 'sales' })
    registerMcpTool(assistantTool, { moduleId: 'ai_assistant' })
    seedAgentRegistryForTests([salesAgent, generalAgent])
  })

  afterAll(() => {
    resetAgentRegistryForTests()
    toolRegistry.clear()
  })

  it('denies a super admin the features of an unavailable module', () => {
    expect(hasRequiredFeatures(['sales.orders.view'], ['*'], true)).toBe(true)
    expect(hasRequiredFeatures(['sales.orders.view'], ['*'], true, undefined, ['sales'])).toBe(false)
    expect(hasRequiredFeatures(['sales.orders.view'], ['*'], true, undefined, ['catalog'])).toBe(true)
  })

  it('refuses to execute a tool of an unavailable module', async () => {
    await expect(executeTool('sales.list_orders', {}, superAdminContext(['sales'])))
      .resolves.toMatchObject({ success: false, errorCode: 'UNAUTHORIZED' })
    await expect(executeTool('sales.list_orders', {}, superAdminContext([])))
      .resolves.toMatchObject({ success: true })
  })

  it('loads the unavailable set from the container when a tool context omits it', async () => {
    await expect(executeTool('sales.list_orders', {}, superAdminContext(undefined, containerWithUnavailable(['sales']))))
      .resolves.toMatchObject({ success: false, errorCode: 'UNAUTHORIZED' })
    await expect(executeTool('sales.list_orders', {}, superAdminContext(undefined, containerWithUnavailable([]))))
      .resolves.toMatchObject({ success: true })
  })

  it('refuses an agent of an unavailable module', () => {
    expect(checkAgentPolicy({
      agentId: 'sales.assistant',
      authContext: { userFeatures: ['*'], isSuperAdmin: true, unavailableModuleIds: ['sales'] },
    })).toMatchObject({ ok: false, code: 'agent_features_denied' })
  })

  it('refuses a tool of an unavailable module for an available agent', () => {
    expect(checkAgentPolicy({
      agentId: 'ai_assistant.general',
      toolName: 'sales.list_orders',
      authContext: { userFeatures: ['*'], isSuperAdmin: true, unavailableModuleIds: ['sales'] },
    })).toMatchObject({ ok: false, code: 'tool_features_denied' })
    expect(checkAgentPolicy({
      agentId: 'ai_assistant.general',
      toolName: 'ai_assistant.echo',
      authContext: { userFeatures: ['*'], isSuperAdmin: true, unavailableModuleIds: ['sales'] },
    }).ok).toBe(true)
  })

  it('drops tools of an unavailable module from an agent run that did not pass the set', async () => {
    const resolved = await resolveAiAgentTools({
      agentId: 'ai_assistant.general',
      authContext: { tenantId: 'tenant-a', organizationId: null, userId: 'admin', features: ['*'], isSuperAdmin: true },
      container: containerWithUnavailable(['sales']),
    })
    const toolNames = Object.keys(resolved.tools)

    expect(toolNames.some((name) => name.startsWith('sales'))).toBe(false)
    expect(toolNames.some((name) => name.startsWith('ai_assistant'))).toBe(true)
  })

  it('refuses a pending action of an unavailable module at confirmation', async () => {
    const action = {
      id: 'pa_1',
      tenantId: 'tenant-a',
      organizationId: null,
      agentId: 'sales.assistant',
      toolName: 'sales.list_orders',
      status: 'pending',
      expiresAt: new Date(Date.now() + 60_000),
    } as unknown as AiPendingAction
    const result = await runPendingActionRechecks({
      action,
      agent: salesAgent,
      tool: salesTool,
      ctx: {
        tenantId: 'tenant-a',
        organizationId: null,
        userId: 'admin',
        userFeatures: ['*'],
        isSuperAdmin: true,
        unavailableModuleIds: ['sales'],
        container: containerWithUnavailable(['sales']),
        em: {} as never,
      },
    })

    expect(result).toMatchObject({ ok: false, code: 'agent_features_denied' })

    const withoutSet = await runPendingActionRechecks({
      action,
      agent: salesAgent,
      tool: salesTool,
      ctx: {
        tenantId: 'tenant-a',
        organizationId: null,
        userId: 'admin',
        userFeatures: ['*'],
        isSuperAdmin: true,
        container: containerWithUnavailable(['sales']),
        em: {} as never,
      },
    })
    expect(withoutSet).toMatchObject({ ok: false, code: 'agent_features_denied' })
  })

  it('refuses at confirmation a pending action whose agent module became unavailable, whatever feature guards the agent', async () => {
    const { akeneoMutation, akeneoAgent, recheckFor } = pendingAkeneoFixtures()
    registerMcpTool(akeneoMutation, { moduleId: 'sync_akeneo' })

    await expect(recheckFor(akeneoAgent, ['sync_akeneo'])).resolves.toMatchObject({ ok: false, status: 403, code: 'agent_features_denied' })
    await expect(recheckFor(akeneoAgent, [])).resolves.toMatchObject({ ok: true })
  })

  it('refuses at confirmation a pending action whose tool module became unavailable or whose tool features are missing, for an available agent', async () => {
    const { akeneoMutation, helperAgent, recheckFor } = pendingAkeneoFixtures()
    registerMcpTool(akeneoMutation, { moduleId: 'sync_akeneo' })

    await expect(recheckFor(helperAgent, ['sync_akeneo'])).resolves.toMatchObject({ ok: false, status: 403, code: 'tool_features_denied' })
    await expect(recheckFor(helperAgent, [], ['ai_assistant.view'])).resolves.toMatchObject({ ok: false, status: 403, code: 'tool_features_denied' })
    await expect(recheckFor(helperAgent, [])).resolves.toMatchObject({ ok: true })
  })

  it('keeps the declaring module of a tool that only an override file adds', async () => {
    const exportTool: AiToolDefinition = {
      name: 'akeneo.export_products',
      description: 'Export products',
      inputSchema: z.object({}),
      requiredFeatures: ['data_sync.configure'],
      handler: async () => ({ exported: true }),
    }
    applyAiToolOverrideEntries([
      { moduleId: 'sync_akeneo', overrides: { 'akeneo.export_products': exportTool } },
      { moduleId: 'catalog', overrides: { 'sales.list_orders': { ...salesTool, description: 'List orders (override)' } } },
    ])

    expect(toolRegistry.getToolModuleId('akeneo.export_products')).toBe('sync_akeneo')
    expect(toolRegistry.getToolModuleId('sales.list_orders')).toBe('sales')
    await expect(executeTool('akeneo.export_products', {}, superAdminContext(['sync_akeneo'])))
      .resolves.toMatchObject({ success: false, errorCode: 'UNAUTHORIZED' })
    await expect(executeTool('akeneo.export_products', {}, superAdminContext([])))
      .resolves.toMatchObject({ success: true })
  })

  it('falls back to the container for in-process MCP clients built without the unavailable set', async () => {
    registerMcpTool({
      name: 'akeneo.delete_products',
      description: 'Delete products',
      inputSchema: z.object({}),
      requiredFeatures: ['data_sync.configure'],
      handler: async () => ({ deleted: true }),
    }, { moduleId: 'sync_akeneo' })
    const listFor = async (unavailable: string[]) => {
      const client = await InProcessMcpClient.createWithAuthContext({
        container: containerWithUnavailable(unavailable),
        authContext: { tenantId: 'tenant-a', organizationId: null, userId: 'user-1', userFeatures: ['data_sync.configure'], isSuperAdmin: false },
      })
      return (await client.listTools()).map((tool) => tool.name).includes('akeneo.delete_products')
    }

    expect(await listFor(['sync_akeneo'])).toBe(false)
    expect(await listFor([])).toBe(true)
  })

  it('builds MCP HTTP API key contexts with the key tenant unavailable set', async () => {
    const getUnavailableModuleIds = jest.fn(async (): Promise<string[]> => ['sales'])
    const container = {
      resolve: (name: string) => (name === 'rbacService'
        ? {
            loadAcl: async () => ({ isSuperAdmin: true, features: ['*'], organizations: null }),
            getUnavailableModuleIds,
          }
        : {}),
    } as unknown as AwilixContainer
    const context = await resolveApiKeyContext(
      { id: 'key-1', tenantId: 'tenant-a', organizationId: null, createdBy: 'admin' } as unknown as ApiKey,
      superAdminContext([], container),
    )

    expect(context?.unavailableModuleIds).toEqual(['sales'])
    expect(getUnavailableModuleIds).toHaveBeenCalledWith('tenant-a', 'api_key:key-1')
  })

  it('loads the unavailable set from the RBAC service and tolerates services without it', async () => {
    const rbacService = { getUnavailableModuleIds: jest.fn(async (): Promise<string[]> => ['sales']) }
    await expect(loadUnavailableModuleIds(rbacService, 'tenant-a', 'admin')).resolves.toEqual(['sales'])
    expect(rbacService.getUnavailableModuleIds).toHaveBeenCalledWith('tenant-a', 'admin')
    await expect(loadUnavailableModuleIds({}, 'tenant-a', 'admin')).resolves.toEqual([])
    await expect(loadUnavailableModuleIds(null, 'tenant-a', 'admin')).resolves.toEqual([])
  })

  it('hands the container-loaded set to tool handlers so meta tools hide unavailable agents', async () => {
    for (const metaTool of metaAiTools) registerMcpTool(metaTool as AiToolDefinition, { moduleId: 'ai_assistant' })
    const context = superAdminContext(undefined, containerWithUnavailable(['sales']))

    const listed = await executeTool('meta.list_agents', {}, context)
    expect(listed.success).toBe(true)
    const listedIds = ((listed.result as { agents: Array<{ id: string }> }).agents).map((agent) => agent.id)
    expect(listedIds).toContain('ai_assistant.general')
    expect(listedIds).not.toContain('sales.assistant')

    const described = await executeTool('meta.describe_agent', { agentId: 'sales.assistant' }, context)
    expect(described.result).toEqual({ agent: null, reason: 'forbidden' })
  })

  it('hands the set to handlers of tools that declare no required features', async () => {
    registerMcpTool({
      name: 'ai_assistant.scope_echo',
      description: 'Echo scope',
      inputSchema: z.object({}),
      handler: async (_input: unknown, ctx: McpToolContext) => ({ unavailable: ctx.unavailableModuleIds }),
    }, { moduleId: 'ai_assistant' })

    const result = await executeTool('ai_assistant.scope_echo', {}, superAdminContext(undefined, containerWithUnavailable(['sales'])))
    expect(result).toMatchObject({ success: true, result: { unavailable: ['sales'] } })
  })

  it('refuses a Code Mode API call into an unavailable module when the context omits the set', async () => {
    jest.mocked(getApiEndpoints).mockResolvedValue([
      {
        id: 'list_orders',
        operationId: 'list_orders',
        method: 'GET',
        path: '/api/sales/orders',
        summary: '',
        description: '',
        tags: [],
        requiredFeatures: ['sales.orders.view'],
        parameters: [],
        requestBodySchema: null,
        deprecated: false,
      },
    ])

    await expect(authorizeCodeModeApiRequest(
      superAdminContext(undefined, containerWithUnavailable(['sales'])),
      'GET',
      '/api/sales/orders',
    )).resolves.toMatchObject({ allowed: false, statusCode: 403 })
    await expect(authorizeCodeModeApiRequest(
      superAdminContext(undefined, containerWithUnavailable([])),
      'GET',
      '/api/sales/orders',
    )).resolves.toMatchObject({ allowed: true })
  })

  it('refuses a tool registered for a module unavailable to the tenant, whatever feature it requires', async () => {
    registerMcpTool({
      name: 'akeneo.delete_products',
      description: 'Delete products',
      inputSchema: z.object({}),
      requiredFeatures: ['data_sync.configure'],
      handler: async () => ({ deleted: true }),
    }, { moduleId: 'sync_akeneo' })

    await expect(executeTool('akeneo.delete_products', {}, superAdminContext(['sync_akeneo'])))
      .resolves.toMatchObject({ success: false, errorCode: 'UNAUTHORIZED' })
    await expect(executeTool('akeneo.delete_products', {}, superAdminContext(undefined, containerWithUnavailable(['sync_akeneo']))))
      .resolves.toMatchObject({ success: false, errorCode: 'UNAUTHORIZED' })
    await expect(executeTool('akeneo.delete_products', {}, superAdminContext([])))
      .resolves.toMatchObject({ success: true })
  })

  it('refuses an API operation on a route of an unavailable module guarded by another module feature', async () => {
    const routeHandler = jest.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    const apiRoutes: ApiRouteManifestEntry[] = [{
      moduleId: 'sync_akeneo',
      kind: 'route-file',
      path: '/sync_akeneo/delete-products',
      methods: ['POST'],
      load: async () => ({
        POST: routeHandler,
        metadata: { POST: { requireAuth: true, requireFeatures: ['data_sync.configure'] } },
        openApi: { methods: {} },
      }),
    }]
    const tool: AiToolDefinition = {
      name: 'akeneo.delete_products',
      description: 'Delete products',
      inputSchema: z.object({}),
      requiredFeatures: ['data_sync.configure'],
      handler: async () => ({}),
    }
    const runFor = (unavailable: string[]) => createAiApiOperationRunner(
      { ...superAdminContext(undefined, containerWithUnavailable(unavailable)), tool },
      { apiRoutes },
    ).run({ method: 'POST', path: '/sync_akeneo/delete-products', body: {} })

    await expect(runFor(['sync_akeneo'])).resolves.toMatchObject({ success: false, statusCode: 403 })
    expect(routeHandler).not.toHaveBeenCalled()
    await expect(runFor([])).resolves.toMatchObject({ success: true, statusCode: 200 })
    expect(routeHandler).toHaveBeenCalledTimes(1)
  })

  it('neither lists nor executes a tool or agent of an unavailable module guarded by another module feature', async () => {
    const akeneoTool: AiToolDefinition = {
      name: 'akeneo.delete_products',
      description: 'Delete products',
      inputSchema: z.object({}),
      requiredFeatures: ['data_sync.configure'],
      handler: async () => ({ deleted: true }),
    }
    const akeneoAgent: AiAgentDefinition = {
      id: 'sync_akeneo.assistant',
      moduleId: 'sync_akeneo',
      label: 'Akeneo assistant',
      description: 'Akeneo assistant',
      systemPrompt: 'You are a test agent.',
      allowedTools: ['akeneo.delete_products'],
      requiredFeatures: ['ai_assistant.view'],
    }
    const helperAgent: AiAgentDefinition = {
      ...generalAgent,
      id: 'ai_assistant.akeneo_helper',
      allowedTools: ['akeneo.delete_products'],
    }
    registerMcpTool(akeneoTool, { moduleId: 'sync_akeneo' })
    for (const metaTool of metaAiTools) registerMcpTool(metaTool as AiToolDefinition, { moduleId: 'ai_assistant' })
    resetAgentRegistryForTests()
    seedAgentRegistryForTests([salesAgent, generalAgent, akeneoAgent, helperAgent])
    const userFeatures = ['data_sync.configure', 'ai_assistant.view']

    let unavailableForRoute: string[] = []
    let listToolsRoute: ((req: NextRequest) => Promise<Response>) | null = null
    jest.isolateModules(() => {
      jest.doMock('@open-mercato/shared/lib/auth/server', () => ({
        getAuthFromRequest: async () => ({ sub: 'user-1', tenantId: 'tenant-a', orgId: null }),
      }))
      jest.doMock('@open-mercato/shared/lib/di/container', () => ({
        createRequestContainer: async () => ({
          resolve: () => ({
            loadAcl: async () => ({ features: userFeatures, isSuperAdmin: false }),
            getUnavailableModuleIds: async () => unavailableForRoute,
          }),
        }),
      }))
      jest.doMock('../tool-loader', () => ({ loadAllModuleTools: async () => undefined }))
      const isolatedRegistry = require('../tool-registry') as typeof import('../tool-registry')
      isolatedRegistry.registerMcpTool(akeneoTool, { moduleId: 'sync_akeneo' })
      listToolsRoute = (require('../../api/tools/route') as typeof import('../../api/tools/route')).GET
    })
    jest.dontMock('@open-mercato/shared/lib/auth/server')
    jest.dontMock('@open-mercato/shared/lib/di/container')
    jest.dontMock('../tool-loader')

    const accessFor = async (unavailable: string[]) => {
      unavailableForRoute = unavailable
      const context: McpToolContext = {
        tenantId: 'tenant-a',
        organizationId: null,
        userId: 'user-1',
        container: containerWithUnavailable(unavailable),
        userFeatures,
        isSuperAdmin: false,
        unavailableModuleIds: unavailable,
      }
      const routeResponse = await listToolsRoute!(new Request('http://localhost/api/ai_assistant/tools') as unknown as NextRequest)
      const routeTools = ((await routeResponse.json()) as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)
      const client = await InProcessMcpClient.createWithAuthContext({
        container: context.container,
        authContext: { tenantId: 'tenant-a', organizationId: null, userId: 'user-1', userFeatures, isSuperAdmin: false, unavailableModuleIds: unavailable },
      })
      const mcpTools = (await client.listTools()).map((tool) => tool.name)
      const agentRun = await resolveAiAgentTools({
        agentId: 'ai_assistant.akeneo_helper',
        authContext: { tenantId: 'tenant-a', organizationId: null, userId: 'user-1', features: userFeatures, isSuperAdmin: false, unavailableModuleIds: unavailable },
        container: context.container,
      })
      const listedAgents = await executeTool('meta.list_agents', {}, context)
      const agentIds = ((listedAgents.result as { agents: Array<{ id: string }> }).agents).map((agent) => agent.id)
      return {
        listedByToolsRoute: routeTools.includes('akeneo.delete_products'),
        listedByMcp: mcpTools.includes('akeneo.delete_products'),
        resolvedForAgentRun: Object.keys(agentRun.tools).includes('akeneo__delete_products'),
        executed: (await executeTool('akeneo.delete_products', {}, context)).success,
        agentListedByMetaTool: agentIds.includes('sync_akeneo.assistant'),
        agentAllowed: checkAgentPolicy({ agentId: 'sync_akeneo.assistant', authContext: { userFeatures, isSuperAdmin: false, unavailableModuleIds: unavailable } }).ok,
      }
    }

    expect(await accessFor(['sync_akeneo'])).toEqual({
      listedByToolsRoute: false,
      listedByMcp: false,
      resolvedForAgentRun: false,
      executed: false,
      agentListedByMetaTool: false,
      agentAllowed: false,
    })
    expect(await accessFor([])).toEqual({
      listedByToolsRoute: true,
      listedByMcp: true,
      resolvedForAgentRun: true,
      executed: true,
      agentListedByMetaTool: true,
      agentAllowed: true,
    })
  })
})
