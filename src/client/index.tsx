/**
 * Browser half of @dsh-restart/one-click-restart: a "Restart" button in the
 * sidebar foot, next to Settings.
 *
 * The host half serves `POST /api/restart-harness` and publishes the shared
 * token as `globalThis.__DSH_RESTART_TOKEN__` through a `webserver/index-inject`
 * `global` row (reached over HTTP on web, and over the desktop boot IPC
 * injections — both paths land the value before the client bundle runs).
 * This half contributes a component to the sidebar shell's
 * `sidebar.footer.action` list slot, so no host/UI source changes are needed.
 */
import { useState } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'

/**
 * The sidebar shell (`@deepseek-ai/dsh-client-ui-sidebar`) declares this list
 * slot with owner props `{ wide }`. Spelled locally — the same shape — so this
 * package registers without depending on the sidebar package.
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'sidebar.footer.action': { kind: 'list'; scope: 'root'; owner: { wide: boolean } }
  }
}

/** Host-published shared secret for the restart route. */
declare global {
  var __DSH_RESTART_TOKEN__: string | undefined
}

/** Host route registered by the node half when `enableHttpRoute` is on. */
const RESTART_ROUTE = '/api/restart-harness'

/** Stable `<style data-plugin>` tag id for this package's helper CSS. */
const STYLE_TAG_ID = '@dsh-restart/one-click-restart/client.css'

/** Lifecycle of one click. */
type Phase = 'idle' | 'pending' | 'scheduled' | 'failed'

/**
 * POST the restart route. The watchdog is spawned server-side before the
 * reply, so a 200 means the relaunch is already scheduled; the graceful exit
 * follows microseconds later and the page dies with the host process.
 *
 * A network failure right after the POST is also the expected shape of a
 * successful restart (the host exits mid-request), so it is reported as
 * `likely` — a "scheduled" state with a hedged message — instead of an error.
 */
async function requestRestart(): Promise<{ ok: boolean; likely?: boolean; message?: string }> {
  const token = globalThis.__DSH_RESTART_TOKEN__
  let response: Response
  try {
    response = await fetch(RESTART_ROUTE, {
      method: 'POST',
      headers: token === undefined ? {} : { 'x-restart-token': token },
    })
  } catch {
    return { ok: true, likely: true }
  }
  if (response.status === 401) {
    return { ok: false, message: 'unauthorized: restart token missing or stale — reload the page' }
  }
  if (!response.ok) return { ok: false, message: `HTTP ${response.status}` }
  return { ok: true }
}

/** Helper CSS: hover feedback, the in-flight spinner, and the animated dots. */
function ensureStyleTag(): void {
  const css = [
    `.dsh-restart-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }`,
    `.dsh-restart-btn:disabled { opacity: 0.55; cursor: default; }`,
    `.dsh-restart-btn .dsh-restart-spin { animation: dsh-restart-rotate 0.9s linear infinite; }`,
    `@keyframes dsh-restart-rotate { to { transform: rotate(360deg); } }`,
    `.dsh-restart-dots span { opacity: 0.2; animation: dsh-restart-dots 1.2s ease-in-out infinite; }`,
    `.dsh-restart-dots span:nth-child(2) { animation-delay: 0.2s; }`,
    `.dsh-restart-dots span:nth-child(3) { animation-delay: 0.4s; }`,
    `@keyframes dsh-restart-dots { 0% { opacity: 0.2; } 30% { opacity: 1; } 60%, 100% { opacity: 0.2; } }`,
    `@media (prefers-reduced-motion: reduce) {`,
    `  .dsh-restart-dots span, .dsh-restart-btn .dsh-restart-spin { animation: none; }`,
    `  .dsh-restart-dots span { opacity: 1; }`,
    `}`,
  ].join('\n')
  if (typeof document === 'undefined') return
  const existing = document.querySelector(`style[data-plugin-css='${STYLE_TAG_ID}']`)
  if (existing !== null) {
    // HMR re-executes the factory with new CSS: refresh the existing tag
    // instead of skipping, or stale rules would stick until a full reload.
    if (existing.textContent !== css) existing.textContent = css
    return
  }
  const tag = document.createElement('style')
  tag.dataset.plugin = '@dsh-restart/one-click-restart'
  tag.dataset.pluginCss = STYLE_TAG_ID
  tag.textContent = css
  document.head.appendChild(tag)
}

/** Circular-arrow restart glyph, matching the shell's outline icon language. */
function RestartIcon({ size, spin }: { size: number; spin: boolean }): JSX.Element {
  return (
    <svg
      className={spin ? 'dsh-restart-spin' : undefined}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
      <path d="M13.7 1.8v2.6h-2.6" />
    </svg>
  )
}

/** The footer action: a full-width row when the sidebar is wide, a 36px rail icon otherwise. */
function RestartButton({ wide }: { wide: boolean }) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [message, setMessage] = useState('')

  const onClick = (): void => {
    if (phase === 'pending') return
    setPhase('pending')
    setMessage('')
    void requestRestart().then((result) => {
      if (result.ok) {
        setPhase('scheduled')
        setMessage(wide ? (result.likely ? '连接已断开，即将重启' : '即将重启') : 'Restarting')
      } else {
        setPhase('failed')
        setMessage(result.message ?? 'restart failed')
      }
    })
  }

  const label = phase === 'pending'
    ? (wide ? '重启中' : 'Restarting')
    : phase === 'scheduled'
      ? message
      : phase === 'failed'
        ? (wide ? `重启失败：${message}` : 'Retry restart')
        : (wide ? '重启 Harness' : 'Restart Harness')
  // In-flight states get the animated trailing dots (the static "…" they
  // replace); the failure state keeps its plain message.
  const busy = phase === 'pending' || phase === 'scheduled'

  return (
    <button
      type="button"
      className="dsh-restart-btn"
      title={phase === 'failed' ? message : undefined}
      aria-label="Restart Harness"
      onClick={onClick}
      disabled={phase === 'pending'}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: wide ? 'flex-start' : 'center',
        gap: 8,
        width: wide ? '100%' : 36,
        height: wide ? 42 : 36,
        margin: wide ? 0 : undefined,
        padding: wide ? '0 10px 0 8px' : 0,
        border: 'none',
        borderRadius: wide ? 12 : '50%',
        background: 'transparent',
        color: phase === 'failed' ? 'var(--dsw-alias-label-critical, #d5393f)' : 'var(--dsw-alias-label-primary)',
        fontFamily: 'inherit',
        fontSize: 14,
        cursor: phase === 'pending' ? 'default' : 'pointer',
        overflow: 'hidden',
        whiteSpace: 'nowrap',
      }}
    >
      <RestartIcon size={wide ? 16 : 18} spin={busy} />
      {wide && (
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {label}
          {busy && (
            <span className="dsh-restart-dots" aria-hidden>
              <span>.</span>
              <span>.</span>
              <span>.</span>
            </span>
          )}
        </span>
      )}
    </button>
  )
}

/** Required client services: the slot registry (provided by the UI renderer shell). */
export const inject = ['slots']

/** Contribute the button to the sidebar shell's footer-action list. */
export function apply(ctx: ClientContext): void {
  ensureStyleTag()
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
    { name: 'sidebar.footer.action', id: 'one-click-restart', order: 50 },
    RestartButton,
  ))
}
