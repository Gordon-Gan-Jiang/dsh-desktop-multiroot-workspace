import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { apply as applyWorkspace } from './upstream/index.ts'
import { registerSettingsSection } from './desktop/settings-section.tsx'

export { inject } from './upstream/index.ts'
export type * from './upstream/contract/slots.ts'

/** Register the stock Workspace UI with the external multiroot extension enabled. */
export function apply(ctx: ClientContext): void {
  applyWorkspace(ctx, { multiroot: true })
  // DSH Desktop additions: the "管理多根工作区" settings page with
  // open-workspace (session on the primary root) and native directory picking.
  registerSettingsSection(ctx)
}
