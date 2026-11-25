/**
 * Account balance chip in the composer dock row.
 *
 * Registers one entry in `conversation.composer.dock`, the horizontal row that
 * already carries the turn/token usage stats, and reads the account wallet
 * through the existing `account/getBalance` Remote of the account settings
 * plugin. Nothing is stored or sent anywhere else: the chip only re-reads the
 * same balance the Settings > Account page shows.
 */

const NS = 'accountBalance'
const POLL_MS = 60_000
const MIN_GAP_MS = 15_000

const en = {
  balance: 'Balance',
  toppedUp: 'Topped-up',
  bonus: 'Bonus',
  unavailable: 'Balance unavailable',
  stale: 'Last known value',
  openTopUp: 'Click to top up',
}
const pt = {
  balance: 'Saldo',
  toppedUp: 'Saldo reabastecido',
  bonus: 'Bônus',
  unavailable: 'Saldo indisponível',
  stale: 'Último valor conhecido',
  openTopUp: 'Clique para recarregar',
}
const es = {
  balance: 'Saldo',
  toppedUp: 'Saldo recargado',
  bonus: 'Bono',
  unavailable: 'Saldo no disponible',
  stale: 'Último valor conocido',
  openTopUp: 'Clic para recargar',
}

/**
 * Format one wallet amount the way Settings > Account does: two decimals,
 * grouped digits, a sub-cent marker, and the currency symbol. Work is done on
 * the decimal string in integer cents so a value like `0.29` keeps its cents.
 * @param {string} amount - decimal balance string from the Host.
 * @param {string} currency - `USD` or `CNY`.
 * @returns {string | null} display text, or null when the amount is unusable.
 */
function formatAmount(amount, currency) {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(amount ?? '').trim())
  if (match === null) return null
  const negative = match[1] === '-'
  const digits = match[3] ?? ''
  const fraction = digits.padEnd(2, '0').slice(0, 2)
  const subCent = /[1-9]/.test(digits.slice(2))
  let cents
  try {
    cents = BigInt(match[2]) * 100n + BigInt(fraction)
  } catch {
    return null
  }
  const symbol = currency === 'CNY' ? '¥' : '$'
  if (cents === 0n) {
    // Truncation to cents leaves only an exact zero or a sub-cent amount.
    if (!subCent) return `${symbol}0.00`
    return `${negative ? '-' : '<'}${symbol}0.01`
  }
  const grouped = String(cents / 100n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const rest = String(cents % 100n).padStart(2, '0')
  return `${negative ? '-' : ''}${symbol}${grouped}.${rest}`
}

/** Resolve a service without turning a missing provider into a failed plugin. */
function optionalService(ctx, name) {
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

window.__ModuleLoader__.load({
  id: 'dsh-account-balance-chip',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    return {
      inject: ['slots', 'locale', 'remote', 'remote.account'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, 'en', en), 'account-balance: en dictionary')
        ctx.effect(() => ctx.locale.register(NS, 'pt', pt), 'account-balance: pt dictionary')
        ctx.effect(() => ctx.locale.register(NS, 'es', es), 'account-balance: es dictionary')
        const t = ctx.locale.bind(NS)

        /** Latest read result shared by every mounted chip. */
        let state = { phase: 'idle', wallets: null, bonusWallets: null, fetchedAt: 0 }
        const listeners = new Set()
        let timer = null
        let inflight = null
        let lastReadAt = 0

        const publish = (next) => {
          state = next
          for (const listener of [...listeners]) listener()
        }

        /** Client identity for one account read, reusing the account plugin's own builder. */
        const metadata = () => {
          const locale = ctx.locale.getSnapshot().active
          const ui = optionalService(ctx, 'accountUi')
          if (ui !== undefined && typeof ui.clientMetadata === 'function') {
            try {
              return ui.clientMetadata(locale)
            } catch {
              // Fall through to the local builder below.
            }
          }
          const release = globalThis.__DSH_BOOT__?.release
          return {
            version: typeof release?.version === 'string' && release.version !== '' ? release.version : '0.0.0',
            locale,
            timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
          }
        }

        /** Keep the last known wallets; a failed later read only marks them stale. */
        const degraded = (phase) => publish({
          phase,
          wallets: state.wallets,
          bonusWallets: state.bonusWallets,
          fetchedAt: state.fetchedAt,
        })

        /** Read the Platform wallets once; concurrent callers share the request. */
        const read = () => {
          if (inflight !== null) return inflight
          if (listeners.size === 0) return Promise.resolve()
          const now = Date.now()
          if (now - lastReadAt < MIN_GAP_MS) return Promise.resolve()
          lastReadAt = now
          inflight = (async () => {
            let result
            try {
              result = await ctx.remote.account.getBalance(metadata())
            } catch {
              degraded('unavailable')
              return
            }
            if (result === null || result === undefined || result.ok !== true) {
              degraded('unavailable')
              return
            }
            const value = result.value
            if (value === null || value === undefined) {
              publish({ phase: 'signed-out', wallets: null, bonusWallets: null, fetchedAt: Date.now() })
              return
            }
            if (value.status !== 'ready') {
              degraded('unavailable')
              return
            }
            publish({
              phase: 'ready',
              wallets: Array.isArray(value.value) ? value.value : [],
              bonusWallets: Array.isArray(value.bonusWallets) ? value.bonusWallets : [],
              fetchedAt: Date.now(),
            })
          })().finally(() => { inflight = null })
          return inflight
        }

        const stopPolling = () => {
          if (timer !== null) clearInterval(timer)
          timer = null
        }

        const subscribe = (listener) => {
          listeners.add(listener)
          if (listeners.size === 1) {
            void read()
            timer = setInterval(() => {
              if (document.visibilityState === 'hidden') return
              void read()
            }, POLL_MS)
          }
          return () => {
            listeners.delete(listener)
            if (listeners.size === 0) stopPolling()
          }
        }

        // A returning window is the most likely moment for a changed balance;
        // the read floor still applies, so focus alone cannot flood the Platform.
        ctx.effect(() => {
          const wake = () => {
            if (document.visibilityState === 'hidden' || listeners.size === 0) return
            void read()
          }
          document.addEventListener('visibilitychange', wake)
          window.addEventListener('focus', wake)
          return () => {
            document.removeEventListener('visibilitychange', wake)
            window.removeEventListener('focus', wake)
            stopPolling()
          }
        }, 'account-balance: wake-up reads')

        /** Coin glyph in the row's line-art weight. */
        const coin = () => h('svg', {
          viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true,
          style: { flex: 'none' },
        },
        h('circle', { cx: 8, cy: 8, r: 6.1, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5 }),
        h('circle', { cx: 8, cy: 8, r: 2.1, fill: 'currentColor' }))

        // Measured from the shipped composer stat pills (ui-chat
        // StatsPills.module.css), so this reading uses the same font, size,
        // weight, colour, icon box, gap, and line height as its neighbours.
        // `order` puts it after every sibling the composer appends itself,
        // including the context meter that follows the slot outlet in DOM order.
        const anchorStyle = {
          display: 'inline-flex',
          minWidth: 0,
          order: 10,
          fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
          lineHeight: 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))',
        }
        // Same geometry as the shipped pills; the action variant adds the
        // hover and focus treatment those buttons receive.
        const CSS = [
          '.dsh-account-balance-chip{display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;max-width:100%;padding:1px 8px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap}',
          '.dsh-account-balance-chip>svg{width:14px;height:14px;flex:none}',
          '.dsh-account-balance-chip>.dsh-account-balance-label{min-width:0;overflow:hidden;text-overflow:ellipsis}',
          '.dsh-account-balance-chip--action{cursor:pointer}',
          '@media (hover:hover){.dsh-account-balance-chip--action:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}}',
          '.dsh-account-balance-chip--action:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
        ].join('')
        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.dshAccountBalance = ''
          style.textContent = CSS
          document.head.append(style)
          return () => { style.remove() }
        }, 'account-balance: chip styles')

        /** Platform top-up destination from the account stream; null while unknown. */
        const topUpUrl = () => {
          const ui = optionalService(ctx, 'accountUi')
          if (ui === undefined || typeof ui.getSnapshot !== 'function') return null
          let view
          try {
            view = ui.getSnapshot()?.view
          } catch {
            return null
          }
          const url = view?.links?.topUpUrl
          return typeof url === 'string' && url !== '' ? url : null
        }

        /** Open the Platform top-up page the account settings page links to. */
        const openTopUp = (url) => {
          window.open(url, '_blank', 'noopener,noreferrer')
        }

        /** One chip beside the usage stats; clickable when a top-up address is known. */
        function BalanceChip() {
          const [current, setCurrent] = React.useState(state)
          React.useEffect(() => subscribe(() => setCurrent(state)), [])
          if (current.phase === 'signed-out') return null
          const dimmed = current.phase !== 'ready'
          if (current.wallets === null || current.wallets.length === 0) {
            // A silent chip would hide a failed read; show the state, not nothing.
            if (current.phase !== 'unavailable') return null
            return h('span', {
              role: 'status',
              'aria-label': t('unavailable'),
              'data-account-balance': 'unavailable',
              style: { ...anchorStyle, opacity: 0.7 },
            }, h('span', { className: 'dsh-account-balance-chip' }, h('span', null, `${t('balance')} \u2014`)))
          }
          const wallet = current.wallets.find((entry) => entry.currency === 'USD') ?? current.wallets[0]
          const amount = formatAmount(wallet.balance, wallet.currency)
          if (amount === null) return null
          const bonus = current.bonusWallets
            .map((entry) => ({ entry, text: formatAmount(entry.balance, entry.currency) }))
            .filter(({ entry, text }) => text !== null && Number(entry.balance) > 0)
          const lines = [`${t('toppedUp')}: ${amount}`]
          for (const { text } of bonus) lines.push(`${t('bonus')}: ${text}`)
          if (dimmed) lines.push(t('stale'))
          const label = `${t('balance')} ${amount}`
          const url = topUpUrl()
          if (url !== null) lines.push(t('openTopUp'))
          const content = h(React.Fragment, null,
            coin(),
            h('span', { className: 'dsh-account-balance-label' }, label))
          const surface = url === null
            ? h('span', { className: 'dsh-account-balance-chip' }, content)
            : h('button', {
              type: 'button',
              className: 'dsh-account-balance-chip dsh-account-balance-chip--action',
              'aria-label': `${label} \u2014 ${t('openTopUp')}`,
              onClick: () => { openTopUp(url) },
            }, content)
          return h('span', {
            'data-account-balance': amount,
            title: lines.join('\n'),
            style: { ...anchorStyle, opacity: dimmed ? 0.65 : 1 },
          }, surface)
        }

        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'account-balance',
          order: 2,
          locale: NS,
        }, BalanceChip))
      },
    }
  },
})
