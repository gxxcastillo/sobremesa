/**
 * Access Pass Redemption Page
 *
 * Handles /pass/:token route to redeem access passes.
 * Shows WelcomeModal to new participants to confirm their identity.
 */

import { type Component, createSignal, onMount, Show } from 'solid-js';
import { useParams, useNavigate } from '@solidjs/router';
import { StudioApiClient } from '@sobremesa/api-client';
import { useAuth } from '../context/AuthContext';
import { WelcomeModal } from '../components/WelcomeModal';

export const AccessPass: Component = () => {
  const params = useParams<{ token: string }>();
  const navigate = useNavigate();
  const auth = useAuth();
  const client = new StudioApiClient();

  const [isLoading, setIsLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [success, setSuccess] = createSignal(false);

  // Welcome modal state
  const [showWelcomeModal, setShowWelcomeModal] = createSignal(false);
  const [grantedFamilyId, setGrantedFamilyId] = createSignal<string | null>(
    null,
  );
  const [grantedFamilyName, setGrantedFamilyName] = createSignal<string | null>(
    null,
  );
  const [userDisplayName, setUserDisplayName] = createSignal<string | null>(
    null,
  );

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

      // Store info for welcome modal
      setGrantedFamilyId(response.grantedFamilyId);
      setUserDisplayName(response.user.displayName);

      // Find the family name
      const family = response.families.find(
        (f) => f.familyId === response.grantedFamilyId,
      );
      setGrantedFamilyName(family?.familyName || 'your family');

      setSuccess(true);

      // Check if user needs to set up their identity
      // Fetch identity info to see if they already have a claim
      try {
        client.setAuthToken(response.token);
        const identityInfo = await client.getIdentity(response.grantedFamilyId);

        if (!identityInfo.currentClaim) {
          // No existing claim - show welcome modal
          setShowWelcomeModal(true);
        } else {
          // Already has identity - go directly to family page
          setTimeout(() => {
            navigate('/family/' + response.grantedFamilyId);
          }, 2000);
        }
      } catch (identityErr) {
        // If identity check fails, just navigate to family page
        console.error('Failed to check identity:', identityErr);
        setTimeout(() => {
          navigate('/family/' + response.grantedFamilyId);
        }, 2000);
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to redeem access pass',
      );
      console.error('Access pass error:', err);
    } finally {
      setIsLoading(false);
    }
  });

  const handleConfirmIdentity = (personId: string, personName: string) => {
    setShowWelcomeModal(false);
    // Navigate to family page
    const fId = grantedFamilyId();
    if (fId) {
      navigate('/family/' + fId);
    }
  };

  const handleDenyIdentity = () => {
    setShowWelcomeModal(false);
    // Navigate to identity settings for manual setup
    const fId = grantedFamilyId();
    if (fId) {
      navigate('/family/' + fId + '/identity');
    }
  };

  const handleSkipIdentity = () => {
    setShowWelcomeModal(false);
    // Navigate to family page without setting identity
    const fId = grantedFamilyId();
    if (fId) {
      navigate('/family/' + fId);
    }
  };

  const handleCloseModal = () => {
    setShowWelcomeModal(false);
    // Navigate to family page
    const fId = grantedFamilyId();
    if (fId) {
      navigate('/family/' + fId);
    }
  };

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

            <Show when={success() && !showWelcomeModal()}>
              <div class="success-container">
                <div class="success-icon">&#x2713;</div>
                <h2>Access Granted!</h2>
                <p>Welcome to your family's Studio. Redirecting...</p>
              </div>
            </Show>

            <Show when={error()}>
              <div class="error-container">
                <div class="error-icon">&#x2717;</div>
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

      {/* Welcome Modal for new participants */}
      <Show when={showWelcomeModal() && grantedFamilyId()}>
        <WelcomeModal
          familyId={grantedFamilyId()!}
          familyName={grantedFamilyName() || 'your family'}
          displayName={userDisplayName()}
          onConfirm={handleConfirmIdentity}
          onDeny={handleDenyIdentity}
          onSkip={handleSkipIdentity}
          onClose={handleCloseModal}
        />
      </Show>
    </div>
  );
};
