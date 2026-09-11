// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { validateDraft, hasErrors, SETTINGS_NS, dictionaries } from '../../src/client/desktop/settings-section.tsx'
import { interpolate } from '../../src/client/desktop/settings-section.tsx'
import type { RootSpec } from '../../src/client/multiroot/types.ts'

/** Minimal translator backed by the section's own dictionaries. */
function makeT(): (key: string, params?: Record<string, string | number>) => string {
  const zh = dictionaries.zh as Record<string, string>
  return (key, params) => interpolate(zh[key] ?? key, params)
}

describe('settings-section validation (B5)', () => {
  const t = makeT()
  const roots: RootSpec[] = [
    { alias: 'frontend', path: '/projects/app/frontend', primary: true },
    { alias: 'backend', path: '/projects/app/backend', primary: false },
  ]

  it('accepts a valid draft', () => {
    const errors = validateDraft('我的项目', roots, ['other'], t)
    expect(hasErrors(errors)).toBe(false)
  })

  it('flags an empty title', () => {
    const errors = validateDraft('   ', roots, [], t)
    expect(errors.title).toBe(dictionaries.zh['settings.multiroot.errTitleEmpty'])
    expect(hasErrors(errors)).toBe(true)
  })

  it('flags a duplicate title', () => {
    const errors = validateDraft('其他', roots, ['其他'], t)
    expect(errors.title).toBe(dictionaries.zh['settings.multiroot.errNameDuplicate'].replace('{name}', '其他'))
    expect(hasErrors(errors)).toBe(true)
  })

  it('flags no roots', () => {
    const errors = validateDraft('我的项目', [], [], t)
    expect(errors.roots).toBe(dictionaries.zh['settings.multiroot.errNoRoots'])
    expect(hasErrors(errors)).toBe(true)
  })

  it('flags duplicate aliases case-insensitively', () => {
    const dup: RootSpec[] = [
      { alias: 'Web', path: '/a', primary: true },
      { alias: 'web', path: '/b', primary: false },
    ]
    const errors = validateDraft('x', dup, [], t)
    expect(errors.perRoot[1]?.alias).toBeDefined()
    expect(hasErrors(errors)).toBe(true)
  })

  it('flags an empty path', () => {
    const bad: RootSpec[] = [{ alias: 'root', path: '   ', primary: true }]
    const errors = validateDraft('x', bad, [], t)
    expect(errors.perRoot[0]?.path).toBeDefined()
    expect(hasErrors(errors)).toBe(true)
  })

  it('ignores the edited record title when checking duplicates', () => {
    const errors = validateDraft('talos-namespace', roots, ['talos-namespace', 'other'], t, 'talos-namespace')
    expect(errors.title).toBeUndefined()
  })
})

describe('settings-section namespace', () => {
  it('exposes its own namespace and dictionaries', () => {
    expect(SETTINGS_NS).toBe('multiroot-settings')
    expect(dictionaries.zh['settings.multiroot.open']).toBe('打开工作区')
    expect(dictionaries.en['settings.multiroot.open']).toBe('Open workspace')
  })
})
