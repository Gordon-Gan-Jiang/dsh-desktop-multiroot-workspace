# dsh-desktop-multiroot-workspace

> **DSH Desktop 多根工作区插件**——为 [DSH Desktop](https://github.com/dataelement/dsh-desktop) 提供多根逻辑工作区能力。

在 DSH Desktop 中实现**多根逻辑工作区**:一个逻辑工作区可以包含多个命名根目录(前端、后端、共享库等),其中一个为主根。让 Agent 在一个会话里同时读写多个仓库的代码——类似 Cursor / VS Code 的多根工作区体验。

本插件是**独立项目**,作为 DSH Desktop 的 profile 级插件安装,不改动应用本体。

---

## ✨ 项目作用

| 能力 | 说明 |
|---|---|
| **多根工作区** | 一个逻辑工作区 = 标题 + 多个根目录(恰一个主根) |
| **跨仓 Agent 工具** | `ws_list` / `ws_cd` / `ws_read` / `ws_write` / `ws_edit` / `ws_glob` / `ws_grep` / `ws_bash`,按根读写文件、执行命令 |
| **影子工作区** | 主根自动在宿主工作区注册表建影子,侧栏/会话分组照常工作 |
| **可视化管理** | 设置页「管理多根工作区」:新建/编辑/删除/设主根/打开工作区,中文界面 |
| **打开工作区** | 一键创建 cwd=主根的会话,新会话立即获得全部根的 ws_* 工具 |

## 🚀 使用

### 1. 打开管理页

DSH Desktop → **设置 → 管理多根工作区**(独立设置分区)。

- **添加多根工作区**:填名称 → 点「浏览…」或手填路径加根 → 单选主根 → 保存
- **管理**:改别名/路径、拖拽排序、移除根、切换主根
- **打开工作区**:一键创建 cwd=主根的新会话
- **删除**:带确认;目录本身不会被删除

### 2. 在会话里使用 ws_* 工具

打开工作区后,新会话自动获得多根能力:

```
ws_list                     # 列出所有根与当前根
ws_cd <alias>               # 切换当前根
ws_read <path>              # 读文件(根内相对路径)
ws_write / ws_edit <path>   # 写/改文件(带 read-before-write 与版本守卫)
ws_bash <cmd>               # 在选定根执行命令
```

> 跨根 bash 默认关闭(`crossRootBash: off`);需要跨根 shell 时在补丁里改为
> `ancestor`(限制在共同祖先)或 `unfenced`(危险,无边界),并用 `--patch` 启动。

### 3. 部署声明的只读工作区(可选)

```yaml
- id: multiroot-workspace
  config:
    title: Product repository
    roots:
      - alias: app
        path: /srv/product/app
        primary: true
      - alias: docs
        path: /srv/product/docs
        primary: false
```

该行成为只读逻辑工作区 `config-roots`,不可经 UI/API 改名、编辑或删除。

## 📦 安装(部署到 DSH Desktop)

插件以 **profile 级插件**方式安装,不动应用本体,数据存于用户目录(升级应用不丢失)。

### 方式 A:从源码构建部署(推荐)

```bash
# 1. 构建(依赖已安装过可跳过 install)
cd dsh-desktop-multiroot-workspace
pnpm install          # 首次
npm run build         # tsdown → client.js

# 2. 退出 DSH Desktop
# 3. 复制插件到桌面 profile
WEB="$HOME/Library/Application Support/dsh-desktop/harness/profiles/web"
mkdir -p "$WEB/node_modules/dsh-desktop-multiroot-workspace"
cp index.js client.js tools.js cordis.patch.yml package.json \
   "$WEB/node_modules/dsh-desktop-multiroot-workspace/"

# 4. 更新 profile package.json:
#    dependencies + dsh.profile.bundles 里加入 dsh-desktop-multiroot-workspace

# 5. 重启 DSH Desktop
```

### 方式 B:从 npm / 打包产物安装(待发布后)

```bash
dsh plugin --profile web add dsh-desktop-multiroot-workspace
```

## 🔨 开发与构建

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run test          # 单元测试(含设置分区校验 8 例)
pnpm run build         # tsdown → dist/index.cjs → client.js
pnpm run test:browser  # 浏览器端到端(需 playwright chromium)
```

- 构建入口:`src/client/index.ts`(客户端)+ `index.js`(宿主端)
- 客户端源码在 `src/client/`,设置分区在 `src/client/desktop/`

## 🧹 清理与回滚

```bash
# 清理插件数据(可选,保留则重装后数据还在)
curl -fsS -X DELETE http://127.0.0.1:<port>/plugins/multiroot/api/data

# 从 profile 移除
# 1. 编辑 profile package.json:移除 dsh-desktop-multiroot-workspace(deps + bundles)
# 2. 删除 node_modules/dsh-desktop-multiroot-workspace
# 3. 重启 DSH Desktop
```

## 🛡️ 安全说明

- 工具拒绝词法穿越与符号链接逃逸;读取限 1 MiB;输出限 200 行
- `ws_bash` 只允许在选定根内执行,`workdir` 不能逃出根
- `crossRootBash` 默认关闭;`unfenced` 仅限明确接受无边界权限的部署
- 设置页目录选择走桌面原生桥,不额外暴露远程接口

## 📄 License

MIT
