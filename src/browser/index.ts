/**
 * Suggested-next-prompt chips, browser half: a `conversation.chat.turnTail`
 * entry that renders the host's STORED suggestions as clickable rows under the
 * newest completed turn (inside the transcript, so they scroll away with the
 * chat), plus the plugin's configuration card on the WebUI **Plugins** page
 * (provider/model for the suggestion route).
 *
 * The value arrives over this plugin's own fetch route on the shared `/api`
 * gateway — the host stores each suggestion set in its own storage domain. It
 * is deliberately NOT a session projection: writing a plugin-private event
 * type is what made sessions unreadable on cold read (issue #4 in the original
 * studyzy/dsh-suggest-prompt plugin this one is derived from).
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: declares the two Plugins-page seats this plugin registers into
// (`plugins.item`, `plugins.bundle.config`).
import type {} from './plugins-page-slots.d.ts'
// Type-only: pulls the ui-chat SlotMap merge (the turnTail entry) and the
// session-standard `useChat` hook the chip row gates on.
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
// Type-only: the ctx.configForms service merge, plus the ctx.slots merge the
// renderer supplies.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the ctx.locale Context merge.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { SuggestionChips } from './SuggestionChips.tsx'
import type { SuggestionChipsProps } from './SuggestionChips.tsx'
import { SettingsCard } from './SettingsCard.tsx'
import { SuggestPromptCardController, SUGGEST_PROMPT_NS } from './settings-controller.ts'
import type {
  DeepSeekCatalog, PiAiProviderCatalog, SuggestPromptSettings,
} from './settings-controller.ts'
import { en, zh } from './settings-locales.ts'

// Re-export the shared pure types so the package's `./client` outlet keeps
// exposing the suggestion payload declaration to client consumers.
export type * from '../types.ts'

export { SuggestionChips } from './SuggestionChips.tsx'
export { SettingsCard } from './SettingsCard.tsx'
export { SUGGEST_PROMPT_NS } from './settings-controller.ts'

/** Locale namespace of the settings card copy. */
const NS = 'suggest-chips.settings'

/** This package's name, which is the key its own bundle configuration registers under. */
const PACKAGE_NAME = 'dsh-suggest-chips'

/** The official-plugins seat this plugin's configuration card occupies. */
const PLUGINS_ITEM = 'plugins.item'

/** The per-bundle configuration seat, keyed by the package name. */
const BUNDLE_CONFIG = 'plugins.bundle.config'

/** Registration order of the official-plugins card among the contributed cards. */
const ITEM_ORDER = 30

/** Required services for the chip row (the slot registry only). */
export const inject = ['slots']

/**
 * Client plugin body: the tip row under the newest completed turn, plus the
 * suggestion configuration card when the WebUI Plugins surface is composed.
 * The card is an enhancement over the core chips, so it mounts on a scoped
 * inject rather than the top-level dependency list — a deployment without the
 * WebUI settings surface still gets chips.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail',
    id: 'suggest-chips',
    order: 30,
  }, (props: SuggestionChipsProps) => SuggestionChips(props)))

  ctx.inject(['configForms', 'locale'], (settingsCtx) => {
    settingsCtx.effect(
      () => settingsCtx.locale.register(NS, { zh, en }),
      'ui-suggest-chips: settings card dictionary',
    )
    // Bound once here: registration-time text (the card label thunk) and the
    // card's injected face share one translate, so copy freshness rides the
    // locale revision.
    const t = settingsCtx.locale.bind(NS)

    const settings = new SuggestPromptCardController(
      settingsCtx.configForms.get<SuggestPromptSettings>(SUGGEST_PROMPT_NS),
      settingsCtx.configForms.get<PiAiProviderCatalog>('llm-pi-ai'),
      settingsCtx.configForms.get<DeepSeekCatalog>('llm-deepseek'),
    )
    // Unload the card's form observers with this fiber (HMR reload must not
    // leave the controller wired into the shared forms).
    settingsCtx.effect(() => () => { settings.dispose() }, 'ui-suggest-chips: settings card form observers')

    // ONE face for BOTH surfaces: the renderer calls a registration's `inject`
    // once per surface, so a fresh face per call would split the staged-edit
    // table between the official card and the installed-package card.
    const face = settings.inject()

    settingsCtx.slots.inject(PLUGINS_ITEM, () => settingsCtx.slots.register({
      name: PLUGINS_ITEM,
      id: SUGGEST_PROMPT_NS,
      order: ITEM_ORDER,
      label: () => t('title'),
      locale: NS,
      inject: () => face,
    }, SettingsCard))

    settingsCtx.slots.inject(BUNDLE_CONFIG, () => settingsCtx.slots.register({
      name: BUNDLE_CONFIG,
      key: PACKAGE_NAME,
      locale: NS,
      inject: () => face,
    }, SettingsCard))
  })
}
