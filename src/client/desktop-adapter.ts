//#region lib/types/client/desktop-adapter.ts
import { NS, dictionaries } from "./locales";

export function apply(ctx: any) {
  ctx.locale?.register?.(NS, dictionaries);
  
  ctx.slots.inject("sidebar.footer", () => {
    return ctx.slots.register({
      name: "sidebar.footer",
      id: "multiroot-launcher",
      order: 999,
    });
  });
  
  console.log('[Multiroot Desktop] Loaded');
}

export const inject = ['locale', 'slots', 'workspaces'];
export const name = 'dsh-multiroot-workspace-desktop';
//#endregion
