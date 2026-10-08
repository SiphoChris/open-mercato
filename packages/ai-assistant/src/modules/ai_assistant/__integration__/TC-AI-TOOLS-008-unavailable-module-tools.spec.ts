import { expect, test, type APIRequestContext } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'

export const integrationMeta = {
  dependsOnModules: ['ai_assistant', 'module_availability_probe'],
}

/**
 * TC-AI-TOOLS-008: AI tools of a module unavailable to the tenant.
 * Covers:
 *   - GET  /api/ai_assistant/tools
 *   - POST /api/ai_assistant/tools/execute
 *
 * Under OM_TEST_MODE the `module_availability_probe` app module registers a
 * tenant module availability provider governing only itself, a switch
 * (`PUT /api/module_availability_probe/availability`) and a read-only AI tool
 * (`module_availability_probe.ping`) guarded by its own feature. No model is
 * called: the tool list and direct execution are the surfaces under test. While
 * the probe module is unavailable to the tenant, its tool is absent from the
 * list and refused on execution, for the super admin too; once it is available
 * again the tool is listed and runs. The availability switch is restored in
 * `finally`; nothing else is created.
 */

const PROBE_TOOL = 'module_availability_probe.ping'

type ToolAccess = {
  listed: boolean
  executeStatus: number
}

async function setProbeAvailability(request: APIRequestContext, token: string, available: boolean): Promise<void> {
  const response = await apiRequest(request, 'PUT', '/api/module_availability_probe/availability', {
    token,
    data: { available },
  })
  expect(response.status(), `PUT probe availability=${available} should return 200`).toBe(200)
}

async function readToolAccess(request: APIRequestContext, token: string): Promise<ToolAccess> {
  const list = await apiRequest(request, 'GET', '/api/ai_assistant/tools', { token })
  expect(list.status(), 'GET /api/ai_assistant/tools should return 200').toBe(200)
  const tools = (await readJsonSafe<{ tools?: Array<{ name?: string }> }>(list))?.tools ?? []
  const execute = await apiRequest(request, 'POST', '/api/ai_assistant/tools/execute', {
    token,
    data: { toolName: PROBE_TOOL, args: {} },
  })
  const executeStatus = execute.status()
  const executeBody = await readJsonSafe<{ success?: boolean; result?: { ok?: boolean } }>(execute)
  if (executeStatus === 200) {
    expect(executeBody?.success).toBe(true)
    expect(executeBody?.result?.ok).toBe(true)
  } else {
    expect(executeBody?.success).toBe(false)
  }
  return {
    listed: tools.some((tool) => tool.name === PROBE_TOOL),
    executeStatus,
  }
}

test.describe('TC-AI-TOOLS-008: AI tools of a module unavailable to the tenant', () => {
  test('a module tool is unlisted and refused while the module is unavailable and returns once it is available again', async ({ request }) => {
    test.setTimeout(120_000)
    const token = await getAuthToken(request, 'superadmin')
    const available: ToolAccess = { listed: true, executeStatus: 200 }
    const unavailable: ToolAccess = { listed: false, executeStatus: 403 }

    try {
      await setProbeAvailability(request, token, true)
      expect(await readToolAccess(request, token)).toEqual(available)

      await setProbeAvailability(request, token, false)
      expect(await readToolAccess(request, token)).toEqual(unavailable)

      await setProbeAvailability(request, token, true)
      expect(await readToolAccess(request, token)).toEqual(available)
    } finally {
      await setProbeAvailability(request, token, true).catch(() => undefined)
    }
  })
})
