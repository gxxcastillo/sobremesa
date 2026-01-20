/**
 * Access Pass Redemption Page
 *
 * Handles /pass/:token route to redeem access passes.
 */

import { type Component, createSignal, onMount, Show } from 'solid-js';
import { useParams, useNavigate } from '@solidjs/router';
import { StudioApiClient } from '@sobremesa/api-client';
import { useAuth } from '../context/AuthContext';

export const AccessPass: Component = () => {
  const params = useParams<{ token: string }>();
  const navigate = useNavigate();
  const auth = useAuth();
  const client = new StudioApiClient();

  const [isLoading, setIsLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [success, setSuccess] = createSignal(false);

  onMount(async () => {
    if (!params.token) {
      setError('Invalid access pass link');
      setIsLoading(false);
      return;
    }

    try {
      const response = await client.redeemAccessPass(params.token);

      // Log in with the returned token
      auth.login(response.token, response.user, response.families);

      setSuccess(true);

      // Navigate to the granted family after a short delay
      setTimeout(() => {
        navigate('/family/' + response.grantedFamilyId);
      }, 2000);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to redeem access pass',
      );
      console.error('Access pass error:', err);
    } finally {
      setIsLoading(false);
    }
  });

  return (
    <div class="access-pass-page">
      <div class="access-pass-container">
        <header class="access-pass-header">
          <h1>Sobremesa Studio</h1>
        </header>

        <main class="access-pass-main">
          <div class="access-pass-card">
            <Show when={isLoading()}>
              <div class="loading-container">
                <div class="loading-spinner" />
                <h2>Verifying access pass...</h2>
                <p>Please wait while we validate your access.</p>
              </div>
            </Show>

            <Show when={success()}>
              <div class="success-container">
                <div class="success-icon">✓</div>
                <h2>Access Granted!</h2>
                <p>Welcome to your family's Studio. Redirecting...</p>
              </div>
            </Show>

            <Show when={error()}>
              <div class="error-container">
                <div class="error-icon">✗</div>
                <h2>Access Denied</h2>
                <p class="error-message">{error()}</p>
                <p class="error-help">
                  This access pass may have expired or already been used.
                  Request a new one from your family group chat using{' '}
                  <code>/sobremesa studio-link</code>
                </p>
                <button class="btn-primary" onClick={() => navigate('/login')}>
                  Go to Login
                </button>
              </div>
            </Show>
          </div>
        </main>
      </div>
    </div>
  );
};
