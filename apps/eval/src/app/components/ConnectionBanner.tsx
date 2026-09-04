import { Show, onMount } from 'solid-js';
import { serverReachable, startConnectionPolling } from '../connection';

/**
 * Mounted once in the app shell (`main.tsx`) so it's visible on every page —
 * the backend being down otherwise fails silently on pages that don't
 * render their own fetch errors (e.g. Run History), and even where a page
 * does show one, it says nothing until that specific request has been
 * tried.
 */
export function ConnectionBanner() {
  onMount(() => startConnectionPolling());

  return (
    <Show when={serverReachable() === false}>
      <div class="connection-banner" role="alert">
        Can't reach the eval server at <code>localhost:3002</code> — nothing on
        this page will load or save until it's running again. Start it with{' '}
        <code>bun nx run eval:serve</code>; this banner clears itself once it's
        back.
      </div>
    </Show>
  );
}
