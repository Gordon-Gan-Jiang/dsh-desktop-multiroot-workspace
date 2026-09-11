# dsh-desktop-multiroot-workspace — 构建与部署说明

> 这是 `dsh-multiroot-workspace`(Blackoutta)的 DSH Desktop 适配分支,包名改为
> `dsh-desktop-multiroot-workspace`,将本会话所有验证过的修复固化进源码。

## 与上游的差异(全部已验证)

### 客户端(client.js,由 `src/client/` 构建)
1. **设置分区**:`src/client/desktop/settings-section.tsx` 注册 `settings.section`(id
   `multiroot-workspaces`,order 45)——"管理多根工作区"设置页:列表/新建/编辑/删除/
   设主根/打开工作区。
2. **打开工作区按钮**:`openSessionInShadow` 用 `ctx.sessions.create({workspaceId: 影子})`
   创建 cwd=主根的会话(自动挂到逻辑工作区,获得 ws_* 工具)。
3. **原生目录选择桥**:`window.dshDesktopDirectoryPicker.pick()`(桌面 Electron 桥,
   与内置侧栏选择器同一通道)。
4. **独立 locale 命名空间**:设置页用 `multiroot-settings`(避免与内置 `workspace`
   命名空间冲突);`src/client/upstream/index.ts` 里 `workspace` 命名空间注册加了
   "已存在则跳过"保护(alpha.1 上内置 ui-workspace 已注册同名)。
5. **client inject 列表**:去掉 `@deepseek-ai/dsh-client-runtime`(alpha.1 不存在),
   加入 `remote`(目录选择需要)。

### 宿主端(index.js)
6. **migrateShadow 修复**:切换主根时只搬 cwd 匹配新主根的会话,不匹配的留在旧影子
   (不再整体失败);保留的旧影子按路径 basename 改名(消除侧栏重复标题)。
7. **reconcile 启动兜底**:启动时自动把"位于多根根路径、顶着多根名、但不是当前主根
   影子"的遗留工作区按路径改名。

### 其他
8. **peerDependencies**:调整为 `^0.1.2-alpha.1`(兼容桌面内置 dsh 0.1.2-alpha.1)。
9. **cordis.patch.yml**:不 disable `ui-workspace`(alpha.1 客户端树需要其服务)。

## 构建

```bash
cd ~/dsh-desktop-multiroot-workspace
pnpm install          # 首次
npm run build         # tsdown → dist/index.cjs → client.js
```

产物:`client.js`(客户端 bundle)、`index.js`(宿主端,含修复)、`tools.js`(ws_* 工具)、
`cordis.patch.yml`、`package.json`。

## 部署(安装到桌面 profile 替换旧插件)

```bash
# 1. 退出 DSH Desktop
# 2. 复制插件到 profile node_modules
WEB="$HOME/Library/Application Support/dsh-desktop/harness/profiles/web"
mkdir -p "$WEB/node_modules/dsh-desktop-multiroot-workspace"
cp index.js client.js tools.js cordis.patch.yml package.json \
   "$WEB/node_modules/dsh-desktop-multiroot-workspace/"

# 3. 更新 profile package.json:把 dsh-multiroot-workspace 换成 dsh-desktop-multiroot-workspace
#    (dependencies + dsh.profile.bundles)

# 4. 重启 DSH Desktop
```

## 升级后的重新部署

应用升级或 `dsh plugin install` 重装会覆盖 node_modules 里的补丁/插件文件。恢复步骤:
1. 按上面"构建"重新 `npm run build`(源码在 `~/dsh-desktop-multiroot-workspace`,修复已固化,
   重建即恢复全部功能);
2. 按"部署"重新复制到 profile 并更新 package.json;
3. 重启应用。

> 数据(多根工作区记录、影子工作区、会话)存于 `storages/`(userData),任何升级/重装
> 都不丢失。插件本体可随时重建。

## 回滚

```bash
# 从 profile package.json 移除 dsh-desktop-multiroot-workspace(deps + bundles)
# 删除 node_modules/dsh-desktop-multiroot-workspace
# 如要回到旧插件:dsh plugin --profile web add dsh-multiroot-workspace
```
