import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { isBrandingProbeEnabled } from '../../lib/provider'

export const metadata = {
  GET: { requireAuth: false },
}

export async function GET() {
  if (!isBrandingProbeEnabled()) {
    return Response.json({ error: 'Not found' }, { status: 404 })
  }
  return Response.json({ active: true })
}

export const openApi: OpenApiRouteDoc = {
  tag: 'BrandingProbe',
  methods: {
    GET: {
      summary: 'Test-only endpoint reporting whether the branding probe provider is registered (OM_TEST_BRANDING_PROBE_MODE=opt-in runs only)',
      tags: ['BrandingProbe'],
      responses: [
        { status: 200, description: 'The probe provider is registered', schema: z.object({ active: z.literal(true) }) },
        { status: 404, description: 'The probe is not enabled, or the module is not registered', schema: z.object({ error: z.string() }) },
      ],
    },
  },
}
