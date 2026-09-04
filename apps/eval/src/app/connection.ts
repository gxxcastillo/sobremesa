import { createSignal } from 'solid-js';

/**
 * Whether the eval backend (`bun nx run eval:serve`, port 3002) is reachable
 * through the Vite dev proxy. `null` means "not checked yet" (initial page
 * load, before the first health probe or API call resolves) — `<Show>` only
 * renders the down-banner on a confirmed `false`, so a slow-but-fine first
 * request doesn't flash a false warning.
 */
const [reachable, setReachable] = createSignal<boolean | null>(null);
export const serverReachable = reachable;

/**
 * Every `api.*` call funnels through `request()` in `api.ts`, which calls
 * these on every attempt — so any button anywhere that hits a down backend
 * flips this immediately, without waiting for the next poll tick, even on
 * pages (like Run History) that don't otherwise render their own fetch
 * errors.
 */
export function reportConnectionOk() {
  setReachable(true);
}

export function reportConnectionFailure() {
  setReachable(false);
}

let pollHandle: ReturnType<typeof setInterval> | undefined;

/**
 * Catches the backend being down before the user has clicked anything —
 * `reportConnectionFailure`/`Ok` above only fire in reaction to an actual
 * API call. Idempotent and meant to be called once from the always-mounted
 * shell; the interval is never cleared since the app is a single long-lived
 * page.
 */
export function startConnectionPolling(intervalMs = 8000) {
  if (pollHandle !== undefined) return;
  const check = async () => {
    try {
      const response = await fetch('/api/health');
      if (response.ok) reportConnectionOk();
      else reportConnectionFailure();
    } catch {
      reportConnectionFailure();
    }
  };
  void check();
  pollHandle = setInterval(check, intervalMs);
}
