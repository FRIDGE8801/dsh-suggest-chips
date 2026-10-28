/**
 * Locale copy for the suggest-chips settings card.
 * @module dsh-suggest-chips/settings-locales
 */

/** Locale keys the settings card renders. */
export type SuggestPromptSettingsLocaleKey =
  | 'title'
  | 'description'
  | 'provider'
  | 'providerHint'
  | 'model'
  | 'modelHint'
  | 'followRoute'
  | 'overridden'
  | 'reset'
  | 'readOnly'
  | 'save'
  | 'saving'
  | 'discard'
  | 'unsaved'
  | 'saveFailed'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'suggest-chips.settings': SuggestPromptSettingsLocaleKey
  }
}

/** English copy for the card. */
export const en: Record<SuggestPromptSettingsLocaleKey, string> = {
  title: 'Suggested prompts',
  description: 'Model that generates the next-prompt chips after each turn',
  provider: 'Provider',
  providerHint: 'Registered pi-ai provider; leave empty to follow the session route.',
  model: 'Model',
  modelHint: 'A model of the selected provider; leave empty to follow the session route.',
  followRoute: 'Follow session route',
  overridden: 'overridden',
  reset: 'Reset',
  readOnly: 'Settings are read-only in this deployment.',
  save: 'Save',
  saving: 'Saving…',
  discard: 'Discard',
  unsaved: 'Unsaved',
  saveFailed: 'Save failed; the host rejected the values.',
}

/** Simplified Chinese copy for the card. */
export const zh: Record<SuggestPromptSettingsLocaleKey, string> = {
  title: '建议提示词',
  description: '每轮结束后生成建议提示词选项所使用的模型',
  provider: 'Provider',
  providerHint: '已注册的 pi-ai provider；留空则跟随会话路由。',
  model: 'Model',
  modelHint: '所选 provider 的模型；留空则跟随会话路由。',
  followRoute: '跟随会话路由',
  overridden: '已覆盖',
  reset: '重置',
  readOnly: '当前部署下设置为只读。',
  save: '保存',
  saving: '保存中…',
  discard: '放弃',
  unsaved: '未保存',
  saveFailed: '保存失败：宿主拒绝了该值。',
}
