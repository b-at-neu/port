import { z } from 'zod'
import { defineAction } from '@/main/app/define'
import { sessionKey } from '@/main/app/schemas'
import { SESSION_PERMISSION_MODES } from '@/types/hosting'
import { SESSION_EFFORTS } from '@/utils/hosting/controls'

export const sessionControlsSet = defineAction({
  name: 'session.controlsSet',
  kind: 'mutation',
  input: z
    .object({
      sessionKey,
      permissionMode: z.enum(SESSION_PERMISSION_MODES).optional(),
      model: z.string().min(1).max(200).optional(),
      effort: z.enum(SESSION_EFFORTS).nullable().optional(),
    })
    .refine((value) => value.permissionMode !== undefined || value.model !== undefined || value.effort !== undefined, { message: "needs at least one of 'permissionMode', 'model' or 'effort'" }),
  run: (ctx, input) => ctx.live.hostedStore.setControls(input.sessionKey, { permissionMode: input.permissionMode, model: input.model, effort: input.effort }),
})
