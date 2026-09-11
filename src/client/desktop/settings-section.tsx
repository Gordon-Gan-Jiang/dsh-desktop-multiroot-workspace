/**
 * DSH Desktop settings section for multi-root workspaces.
 *
 * Registers a "多根工作区管理" page into the `settings.section` list slot.
 * Features: collapsible workspace cards with a summary line, a full root
 * editor (inline alias edit, path edit with the Desktop native picker, primary
 * radio, per-root removal, drag reordering), live form validation, toast
 * feedback, and automatic refresh after any mutation.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { multirootApi, useMultirootRecords } from '../multiroot/api.ts'
import type { MultirootWorkspaceRecord, RootSpec } from '../multiroot/types.ts'
import css from './SettingsSection.module.css'

/** Own namespace: the stock "workspace" namespace is owned by dsh-client-ui-workspace. */
export const SETTINGS_NS = 'multiroot-settings'

export const dictionaries = {
  zh: {
    'settings.multiroot.title': '管理多根工作区',
    'settings.multiroot.hint': '管理多根逻辑工作区：一个工作区可包含多个根目录，其中一个是主根。创建的记录会被 Agent 的 ws_* 工具与影子工作区使用。',
    'settings.multiroot.loading': '正在加载多根工作区…',
    'settings.multiroot.empty': '还没有多根工作区。点击右上角「添加多根工作区」创建一个。',
    'settings.multiroot.open': '打开工作区',
    'settings.multiroot.setPrimary': '设为主根',
    'settings.multiroot.primary': '主根',
    'settings.multiroot.delete': '删除',
    'settings.multiroot.manage': '管理',
    'settings.multiroot.add': '添加多根工作区',
    'settings.multiroot.save': '保存',
    'settings.multiroot.cancel': '取消',
    'settings.multiroot.confirmDelete': '确定删除这个多根工作区？影子工作区与归属会话将被清理，目录本身不会被删除。',
    'settings.multiroot.confirmYes': '删除',
    'settings.multiroot.confirmNo': '取消',
    'settings.multiroot.noShadow': '该工作区还没有影子工作区，请先切换主根或重建。',
    'settings.multiroot.nameLabel': '工作区名称',
    'settings.multiroot.rootsLabel': '根目录',
    'settings.multiroot.addFolder': '+ 文件夹',
    'settings.multiroot.pickFolder': '浏览…',
    'settings.multiroot.pathPlaceholder': '/path/to/root',
    'settings.multiroot.aliasPlaceholder': '别名',
    'settings.multiroot.removeRoot': '移除',
    'settings.multiroot.rootCount': '{count} 个根',
    'settings.multiroot.summaryPrimary': '主根：{alias}',
    'settings.multiroot.errTitleEmpty': '请填写工作区名称',
    'settings.multiroot.errNoRoots': '至少需要一个根目录',
    'settings.multiroot.errPathEmpty': '路径不能为空',
    'settings.multiroot.errAliasEmpty': '别名不能为空',
    'settings.multiroot.errAliasDuplicate': '别名重复：{alias}',
    'settings.multiroot.errNameDuplicate': '已存在同名工作区：{name}',
    'settings.multiroot.opened': '已创建会话：{id}',
    'settings.multiroot.openedHint': '会话在该工作区主根下已就绪。',
    'settings.multiroot.created': '已创建工作区「{title}」',
    'settings.multiroot.updated': '已保存工作区「{title}」',
    'settings.multiroot.deleted': '已删除工作区「{title}」',
    'settings.multiroot.primarySet': '主根已切换为「{alias}」',
    'settings.multiroot.bridgeUnavailable': '桌面目录选择桥不可用，请手动输入路径',
  },
  en: {
    'settings.multiroot.title': 'Manage Multi-root Workspaces',
    'settings.multiroot.hint': 'Manage multi-root logical workspaces: one workspace can contain several root directories, exactly one of which is primary. Records are used by the Agent ws_* tools and shadow workspaces.',
    'settings.multiroot.loading': 'Loading multi-root workspaces…',
    'settings.multiroot.empty': 'No multi-root workspaces yet. Click “Add multi-root workspace” to create one.',
    'settings.multiroot.open': 'Open workspace',
    'settings.multiroot.setPrimary': 'Make primary',
    'settings.multiroot.primary': 'Primary',
    'settings.multiroot.delete': 'Delete',
    'settings.multiroot.manage': 'Manage',
    'settings.multiroot.add': 'Add multi-root workspace',
    'settings.multiroot.save': 'Save',
    'settings.multiroot.cancel': 'Cancel',
    'settings.multiroot.confirmDelete': 'Delete this multi-root workspace? Shadow workspaces and their sessions will be cleaned up; the directories themselves are not deleted.',
    'settings.multiroot.confirmYes': 'Delete',
    'settings.multiroot.confirmNo': 'Cancel',
    'settings.multiroot.noShadow': 'This workspace has no shadow workspace yet. Switch its primary root or recreate it first.',
    'settings.multiroot.nameLabel': 'Workspace name',
    'settings.multiroot.rootsLabel': 'Roots',
    'settings.multiroot.addFolder': '+ Folder',
    'settings.multiroot.pickFolder': 'Browse…',
    'settings.multiroot.pathPlaceholder': '/path/to/root',
    'settings.multiroot.aliasPlaceholder': 'alias',
    'settings.multiroot.removeRoot': 'Remove',
    'settings.multiroot.rootCount': '{count} roots',
    'settings.multiroot.summaryPrimary': 'Primary: {alias}',
    'settings.multiroot.errTitleEmpty': 'Enter a workspace name',
    'settings.multiroot.errNoRoots': 'At least one root is required',
    'settings.multiroot.errPathEmpty': 'Path cannot be empty',
    'settings.multiroot.errAliasEmpty': 'Alias cannot be empty',
    'settings.multiroot.errAliasDuplicate': 'Duplicate alias: {alias}',
    'settings.multiroot.errNameDuplicate': 'A workspace named {name} already exists',
    'settings.multiroot.opened': 'Session created: {id}',
    'settings.multiroot.openedHint': 'The session is ready under this workspace primary root.',
    'settings.multiroot.created': 'Created workspace “{title}”',
    'settings.multiroot.updated': 'Saved workspace “{title}”',
    'settings.multiroot.deleted': 'Deleted workspace “{title}”',
    'settings.multiroot.primarySet': 'Primary root is now “{alias}”',
    'settings.multiroot.bridgeUnavailable': 'Desktop directory bridge unavailable; type the path manually',
  },
}

interface Translate {
  (key: string, params?: Record<string, string | number>): string
}

export function interpolate(text: string, params?: Record<string, string | number>): string {
  if (params === undefined) return text
  return text.replace(/\{(\w+)\}/g, (_match, name: string) => String(params[name] ?? `{${name}}`))
}

interface ToastState {
  kind: 'ok' | 'error'
  text: string
  at: number
}

/** Live validation of the draft form (B5). */
interface DraftErrors {
  title?: string
  roots?: string
  perRoot: Record<number, { alias?: string; path?: string }>
}

export function validateDraft(
  title: string,
  roots: RootSpec[],
  existingTitles: string[],
  t: Translate,
  editingTitle?: string,
): DraftErrors {
  const errors: DraftErrors = { perRoot: {} }
  const cleanTitle = title.trim()
  if (cleanTitle === '') errors.title = t('settings.multiroot.errTitleEmpty')
  else if (existingTitles.some((name) => name.toLowerCase() === cleanTitle.toLowerCase() && name !== editingTitle)) {
    errors.title = t('settings.multiroot.errNameDuplicate', { name: cleanTitle })
  }
  if (roots.length === 0) errors.roots = t('settings.multiroot.errNoRoots')
  const seen = new Map<string, number>()
  roots.forEach((root, index) => {
    const per: { alias?: string; path?: string } = {}
    const alias = root.alias.trim()
    if (alias === '') per.alias = t('settings.multiroot.errAliasEmpty')
    else {
      const key = alias.toLowerCase()
      if (seen.has(key)) per.alias = t('settings.multiroot.errAliasDuplicate', { alias })
      else seen.set(key, index)
    }
    if (root.path.trim() === '') per.path = t('settings.multiroot.errPathEmpty')
    if (per.alias !== undefined || per.path !== undefined) errors.perRoot[index] = per
  })
  return errors
}

export function hasErrors(errors: DraftErrors): boolean {
  return errors.title !== undefined
    || errors.roots !== undefined
    || Object.keys(errors.perRoot).length > 0
}

function WorkspaceCard(props: {
  record: MultirootWorkspaceRecord
  expanded: boolean
  busy: boolean
  onToggle: () => void
  onOpen: () => void
  onEdit: () => void
  onDelete: () => void
  t: Translate
}): React.JSX.Element {
  const { record, expanded, busy, onToggle, onOpen, onEdit, onDelete, t } = props
  const primary = record.roots.find((root) => root.primary)
  return (
    <div className={css.card}>
      <div className={css.cardHeader}>
        <button type="button" className={css.cardTitle} onClick={onToggle} aria-expanded={expanded}>
          <span className={`${css.chevron} ${expanded ? css.chevronOpen : ''}`}>▶</span>
          <span className={css.cardTitleText}>{record.title}</span>
        </button>
        <span className={css.summary}>
          {t('settings.multiroot.rootCount', { count: record.roots.length })}
          {primary !== undefined ? ` · ${t('settings.multiroot.summaryPrimary', { alias: primary.alias })}` : ''}
        </span>
        <div className={css.actions}>
          <button type="button" className={`${css.button} ${css.buttonAccent}`} disabled={busy} onClick={onOpen}>
            {t('settings.multiroot.open')}
          </button>
          <button type="button" className={css.button} disabled={busy} onClick={onEdit}>
            {t('settings.multiroot.manage')}
          </button>
          <button type="button" className={`${css.button} ${css.buttonDanger}`} disabled={busy} onClick={onDelete}>
            {t('settings.multiroot.delete')}
          </button>
        </div>
      </div>
      {expanded && (
        <div className={css.rootList}>
          {record.roots.map((root) => (
            <div key={root.alias} className={css.rootRow}>
              <span className={css.rootAlias}>{root.alias}</span>
              <span className={css.rootPath}>{root.path}</span>
              {root.primary && <span className={css.primaryBadge}>{t('settings.multiroot.primary')}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function EditDialog(props: {
  mode: 'create' | 'edit'
  record: MultirootWorkspaceRecord | null
  existingTitles: string[]
  pickDirectory: () => Promise<string | null>
  bridgeAvailable: boolean
  saving: boolean
  onSave: (title: string, roots: RootSpec[]) => Promise<void>
  onCancel: () => void
  t: Translate
}): React.JSX.Element {
  const { mode, record, existingTitles, pickDirectory, bridgeAvailable, saving, onSave, onCancel, t } = props
  const [title, setTitle] = useState(record?.title ?? '')
  const [roots, setRoots] = useState<RootSpec[]>(() => (record?.roots ?? []).map((root) => ({ ...root })))
  const [touched, setTouched] = useState(false)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const [bridgeNote, setBridgeNote] = useState<string | null>(null)

  const errors = useMemo(
    () => validateDraft(title, roots, existingTitles, t, mode === 'edit' ? record?.title : undefined),
    [title, roots, existingTitles, t, mode, record],
  )
  const invalid = hasErrors(errors)
  const showErrors = touched || invalid

  const setPrimary = (index: number): void => {
    setRoots((current) => current.map((root, i) => ({ ...root, primary: i === index })))
  }
  const updateRoot = (index: number, patch: Partial<RootSpec>): void => {
    setRoots((current) => current.map((root, i) => (i === index ? { ...root, ...patch } : root)))
  }
  const removeRoot = (index: number): void => {
    setRoots((current) => {
      const next = current.filter((_root, i) => i !== index)
      if (next.length > 0 && !next.some((root) => root.primary)) next[0] = { ...next[0]!, primary: true }
      return next
    })
  }
  const addPath = (path: string): void => {
    const clean = path.trim()
    if (clean === '') return
    setRoots((current) => {
      if (current.some((root) => root.path === clean)) return current
      const alias = clean.split('/').filter(Boolean).pop() ?? 'root'
      let unique = alias
      let n = 2
      while (current.some((root) => root.alias.toLowerCase() === unique.toLowerCase())) {
        unique = `${alias}-${n}`
        n += 1
      }
      return [...current, { alias: unique, path: clean, primary: current.length === 0 }]
    })
  }
  const browse = (): void => {
    void pickDirectory().then((path) => {
      if (path !== null && path !== '') { addPath(path); setBridgeNote(null) }
      else if (!bridgeAvailable) setBridgeNote(t('settings.multiroot.bridgeUnavailable'))
    })
  }
  const reorder = (from: number, to: number): void => {
    if (from === to) return
    setRoots((current) => {
      const next = [...current]
      const [moved] = next.splice(from, 1)
      if (moved === undefined) return current
      next.splice(to, 0, moved)
      return next
    })
  }

  return (
    <div className={css.dialog}>
      <div className={css.dialogTitle}>
        {mode === 'edit' ? t('settings.multiroot.manage') : t('settings.multiroot.add')}
      </div>
      <div className={css.field}>
        <span className={css.fieldLabel}>{t('settings.multiroot.nameLabel')}</span>
        <input
          type="text"
          className={`${css.input} ${showErrors && errors.title !== undefined ? css.inputInvalid : ''}`}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => setTouched(true)}
        />
        {showErrors && errors.title !== undefined && <span className={css.fieldError}>{errors.title}</span>}
      </div>
      <div className={css.field}>
        <span className={css.fieldLabel}>{t('settings.multiroot.rootsLabel')}</span>
        <div className={css.pathRow}>
          <input
            type="text"
            className={`${css.input} ${css.inputSmall} ${css.pathRowInput}`}
            placeholder={t('settings.multiroot.pathPlaceholder')}
            value=""
            onChange={(event) => { /* typed path commits on Enter */ void event }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                addPath((event.target as HTMLInputElement).value)
                ;(event.target as HTMLInputElement).value = ''
              }
            }}
          />
          <button type="button" className={css.button} onClick={browse}>
            {t('settings.multiroot.pickFolder')}
          </button>
        </div>
        {bridgeNote !== null && <span className={css.fieldError}>{bridgeNote}</span>}
      </div>
      {showErrors && errors.roots !== undefined && <span className={css.fieldError}>{errors.roots}</span>}
      <div className={css.rootList}>
        {roots.map((root, index) => {
          const per = errors.perRoot[index]
          const rowInvalid = showErrors && per !== undefined
          return (
            <div
              key={`${root.path}-${index}`}
              className={`${css.rootEditor} ${dragIndex === index ? css.rootRowDragging : ''} ${dropIndex === index ? css.rootRowDropTarget : ''}`}
              draggable
              onDragStart={() => setDragIndex(index)}
              onDragOver={(event) => { event.preventDefault(); setDropIndex(index) }}
              onDragEnd={() => { setDragIndex(null); setDropIndex(null) }}
              onDrop={(event) => {
                event.preventDefault()
                if (dragIndex !== null) reorder(dragIndex, index)
                setDragIndex(null)
                setDropIndex(null)
              }}
            >
              <span className={css.dragHandle} title="drag">⋮⋮</span>
              <button
                type="button"
                className={`${css.radio} ${root.primary ? css.radioSelected : ''}`}
                title={t('settings.multiroot.setPrimary')}
                aria-label={t('settings.multiroot.setPrimary')}
                onClick={() => setPrimary(index)}
              />
              <input
                type="text"
                className={`${css.input} ${css.inputSmall} ${rowInvalid && per?.alias !== undefined ? css.inputInvalid : ''}`}
                style={{ width: 96, flex: 'none' }}
                placeholder={t('settings.multiroot.aliasPlaceholder')}
                value={root.alias}
                onChange={(event) => updateRoot(index, { alias: event.target.value })}
              />
              <input
                type="text"
                className={`${css.input} ${css.inputSmall} ${css.pathRowInput} ${rowInvalid && per?.path !== undefined ? css.inputInvalid : ''}`}
                placeholder={t('settings.multiroot.pathPlaceholder')}
                value={root.path}
                onChange={(event) => updateRoot(index, { path: event.target.value })}
              />
              <button type="button" className={`${css.button} ${css.buttonDanger}`} onClick={() => removeRoot(index)}>
                {t('settings.multiroot.removeRoot')}
              </button>
              {rowInvalid && (
                <span className={css.fieldError}>{per?.alias ?? per?.path}</span>
              )}
            </div>
          )
        })}
      </div>
      <div className={css.dialogActions}>
        <button
          type="button"
          className={css.buttonPrimary}
          disabled={saving || invalid}
          onClick={() => { setTouched(true); if (!invalid) void onSave(title.trim(), roots) }}
        >
          {mode === 'edit' ? t('settings.multiroot.save') : t('settings.multiroot.add')}
        </button>
        <button type="button" className={css.button} onClick={onCancel}>
          {t('settings.multiroot.cancel')}
        </button>
      </div>
    </div>
  )
}

function MultirootSettingsSection(props: {
  t: Translate
  openSessionInShadow: (shadowId: string) => Promise<string | null>
}): React.JSX.Element {
  const { t, openSessionInShadow } = props
  const recordsState = useMultirootRecords(true)
  const [dialogMode, setDialogMode] = useState<'create' | 'edit' | null>(null)
  const [editing, setEditing] = useState<MultirootWorkspaceRecord | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [toast, setToast] = useState<ToastState | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const notify = useCallback((kind: 'ok' | 'error', text: string) => {
    setToast({ kind, text, at: Date.now() })
    if (toastTimer.current !== null) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 3200)
  }, [])
  useEffect(() => () => { if (toastTimer.current !== null) clearTimeout(toastTimer.current) }, [])

  // B6: refresh whenever the records hook reports a change from any source.
  const recordsKey = (recordsState.records ?? []).map((record) => `${record.id}:${record.updatedAt}`).join('|')
  const lastKey = useRef(recordsKey)
  useEffect(() => { lastKey.current = recordsKey }, [recordsKey])

  const refresh = useCallback(async () => {
    try {
      await recordsState.refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [recordsState])

  const remove = useCallback(async (record: MultirootWorkspaceRecord) => {
    setBusyId(record.id)
    setError(null)
    try {
      await multirootApi.delete(record.id)
      await refresh()
      notify('ok', t('settings.multiroot.deleted', { title: record.title }))
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(message)
      notify('error', message)
    } finally {
      setBusyId(null)
      setConfirmDelete(null)
    }
  }, [refresh, notify, t])

  const makePrimary = useCallback(async (record: MultirootWorkspaceRecord, alias: string) => {
    setBusyId(record.id)
    setError(null)
    try {
      await multirootApi.setPrimary(record.id, alias)
      await refresh()
      notify('ok', t('settings.multiroot.primarySet', { alias }))
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(message)
      notify('error', message)
    } finally {
      setBusyId(null)
    }
  }, [refresh, notify, t])

  const openWorkspace = useCallback(async (record: MultirootWorkspaceRecord) => {
    if (record.shadowWorkspaceId === undefined || record.shadowWorkspaceId === null) {
      const message = t('settings.multiroot.noShadow')
      setError(message)
      notify('error', message)
      return
    }
    setBusyId(record.shadowWorkspaceId)
    setError(null)
    try {
      const sessionId = await openSessionInShadow(record.shadowWorkspaceId)
      notify('ok', t('settings.multiroot.opened', { id: sessionId ?? '?' }))
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(message)
      notify('error', message)
    } finally {
      setBusyId(null)
    }
  }, [openSessionInShadow, notify, t])

  const saveDraft = useCallback(async (title: string, roots: RootSpec[]) => {
    setBusyId('save')
    setError(null)
    try {
      if (dialogMode === 'edit' && editing !== null && editing.id !== 'draft') {
        const nextPrimary = roots.find((root) => root.primary)?.alias
        const prevPrimary = editing.roots.find((root) => root.primary)?.alias
        const primaryChanged = nextPrimary !== undefined
          && prevPrimary !== undefined
          && nextPrimary.toLowerCase() !== prevPrimary.toLowerCase()
        if (primaryChanged) {
          // The host rejects a primary change inside update(); keep the old
          // primary in the roots payload, then switch via the dedicated
          // setPrimary endpoint so both mutations succeed atomically-ish.
          const rootsKeepingOldPrimary = roots.map((root) => ({
            ...root,
            primary: root.alias.toLowerCase() === prevPrimary!.toLowerCase(),
          }))
          await multirootApi.update(editing.id, { title, roots: rootsKeepingOldPrimary })
          await multirootApi.setPrimary(editing.id, nextPrimary)
        } else {
          await multirootApi.update(editing.id, { title, roots })
        }
        notify('ok', t('settings.multiroot.updated', { title }))
      } else {
        await multirootApi.create({ title, roots })
        notify('ok', t('settings.multiroot.created', { title }))
      }
      await refresh()
      setDialogMode(null)
      setEditing(null)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(message)
      notify('error', message)
    } finally {
      setBusyId(null)
    }
  }, [dialogMode, editing, refresh, notify, t])

  const bridgeAvailable = typeof (window as unknown as { dshDesktopDirectoryPicker?: unknown }).dshDesktopDirectoryPicker === 'object'
  const pickDirectory = useCallback(async (): Promise<string | null> => {
    const bridge = (window as unknown as { dshDesktopDirectoryPicker?: { pick: () => Promise<string> } }).dshDesktopDirectoryPicker
    if (!bridge || typeof bridge.pick !== 'function') return null
    return bridge.pick().catch(() => null)
  }, [])

  const records = recordsState.records ?? []
  const busy = busyId !== null
  const existingTitles = records.map((record) => record.title)

  return (
    <div className={css.root}>
      <div className={css.header}>
        <div className={css.hint}>{t('settings.multiroot.hint')}</div>
        <button
          type="button"
          className={css.buttonPrimary}
          disabled={recordsState.phase === 'error' || busy}
          onClick={() => { setConfirmDelete(null); setDialogMode('create'); setEditing(null) }}
        >
          {t('settings.multiroot.add')}
        </button>
      </div>
      {error !== null && <div className={css.error}>{error}</div>}
      {recordsState.phase === 'loading' && <div className={css.muted}>{t('settings.multiroot.loading')}</div>}
      {records.length === 0 && recordsState.phase === 'ready' && (
        <div className={css.muted}>{t('settings.multiroot.empty')}</div>
      )}
      {records.map((record) => (
        <div key={record.id}>
          <WorkspaceCard
            record={record}
            expanded={expanded[record.id] === true}
            busy={busy}
            onToggle={() => setExpanded((current) => ({ ...current, [record.id]: current[record.id] !== true }))}
            onOpen={() => { void openWorkspace(record) }}
            onEdit={() => { setConfirmDelete(null); setEditing(record); setDialogMode('edit') }}
            onDelete={() => setConfirmDelete(confirmDelete === record.id ? null : record.id)}
            t={t}
          />
          {confirmDelete === record.id && (
            <div className={css.confirmRow}>
              <span>{t('settings.multiroot.confirmDelete')}</span>
              <button type="button" className={`${css.button} ${css.buttonDanger}`} disabled={busy} onClick={() => { void remove(record) }}>
                {t('settings.multiroot.confirmYes')}
              </button>
              <button type="button" className={css.button} onClick={() => setConfirmDelete(null)}>
                {t('settings.multiroot.confirmNo')}
              </button>
            </div>
          )}
        </div>
      ))}
      {dialogMode !== null && (
        <EditDialog
          mode={dialogMode}
          record={editing}
          existingTitles={existingTitles}
          pickDirectory={pickDirectory}
          bridgeAvailable={bridgeAvailable}
          saving={busyId === 'save'}
          onSave={saveDraft}
          onCancel={() => { setDialogMode(null); setEditing(null) }}
          t={t}
        />
      )}
      {toast !== null && (
        <div className={`${css.toast} ${toast.kind === 'error' ? css.toastError : ''}`}>{toast.text}</div>
      )}
    </div>
  )
}

/** Register the settings section into the client tree. */
export function registerSettingsSection(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(SETTINGS_NS, dictionaries), 'multiroot-settings: dictionaries')
  const translate: Translate = (key, params) => interpolate(ctx.locale.bind(SETTINGS_NS)(key), params)
  ctx.slots.inject('settings.section', () => ctx.slots.register(
    {
      name: 'settings.section',
      id: 'multiroot-workspaces',
      order: 45,
      label: () => ctx.locale.bind(SETTINGS_NS)('settings.multiroot.title'),
      locale: SETTINGS_NS,
      inject: () => ({
        t: translate,
        openSessionInShadow: async (shadowId: string): Promise<string | null> => {
          const created = await ctx.sessions.create({ workspaceId: shadowId })
          const sessionId = typeof created === 'string'
            ? created
            : (created as { sessionId?: string })?.sessionId ?? (created as { value?: { sessionId?: string } })?.value?.sessionId
          if (sessionId !== undefined) {
            try { ctx.sessions.open(sessionId) } catch { /* session still visible in sidebar */ }
          }
          return sessionId ?? null
        },
      }),
    },
    MultirootSettingsSection,
  ))
}
