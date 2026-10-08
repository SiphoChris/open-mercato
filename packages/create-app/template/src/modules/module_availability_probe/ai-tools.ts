import { z } from 'zod'
import { defineAiTool } from '@open-mercato/ai-assistant/modules/ai_assistant/lib/ai-tool-definition'
import type { AiToolDefinition } from '@open-mercato/ai-assistant/modules/ai_assistant/lib/types'
import { PROBE_FEATURE_ID, isProbeEnabled } from './lib/availabilityStore'

/**
 * Test-only read tool guarded by the probe-owned feature, exported only under
 * OM_TEST_MODE, so AI tool listing and execution can be exercised against a
 * module made unavailable to the tenant without calling a model.
 */
const probePingTool: AiToolDefinition = defineAiTool<unknown, { ok: true }>({
  name: 'module_availability_probe.ping',
  description: 'Test-only tool of the module availability probe. Read-only; returns ok.',
  tags: ['read'],
  isMutation: false,
  requiredFeatures: [PROBE_FEATURE_ID],
  inputSchema: z.object({}),
  async handler() {
    return { ok: true }
  },
})

export const aiTools: AiToolDefinition[] = isProbeEnabled() ? [probePingTool] : []

export default aiTools
