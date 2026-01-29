/**
 * Welcome Modal
 *
 * Shown to new participants to confirm their identity.
 * Displays a suggested person match and allows confirm/deny.
 */

import {
  type Component,
  createSignal,
  Show,
  onMount,
  createEffect,
} from 'solid-js';
import {
  StudioApiClient,
  type PersonSuggestion,
  type IdentityResponse,
} from '@sobremesa/api-client';
import './WelcomeModal.css';

export interface WelcomeModalProps {
  familyId: string;
  familyName: string;
  displayName: string | null;
  onConfirm: (personId: string, personName: string) => void;
  onDeny: () => void;
  onSkip: () => void;
  onClose: () => void;
}

export const WelcomeModal: Component<WelcomeModalProps> = (props) => {
  const client = new StudioApiClient();

  const [isLoading, setIsLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [suggestion, setSuggestion] = createSignal<PersonSuggestion | null>(
    null,
  );
  const [isConfirming, setIsConfirming] = createSignal(false);

  // Load identity suggestions on mount
  onMount(async () => {
    try {
      const token = localStorage.getItem('sobremesa_auth_token');
      if (token) {
        client.setAuthToken(token);
      }

      const response = await client.getIdentity(props.familyId);
      setSuggestion(response.suggestion);
    } catch (err) {
      console.error('Failed to load identity suggestions:', err);
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setIsLoading(false);
    }
  });

  const handleConfirm = async () => {
    const sugg = suggestion();
    if (!sugg) return;

    setIsConfirming(true);
    setError(null);

    try {
      await client.claimIdentity(props.familyId, sugg.id);
      props.onConfirm(sugg.id, sugg.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to confirm');
      console.error('Failed to claim identity:', err);
    } finally {
      setIsConfirming(false);
    }
  };

  const handleDeny = () => {
    props.onDeny();
  };

  const getConfidenceLabel = (confidence: string | null) => {
    switch (confidence) {
      case 'high':
        return 'Exact match';
      case 'medium':
        return 'Likely match';
      case 'low':
        return 'Possible match';
      default:
        return 'Suggested';
    }
  };

  return (
    <div class="modal-overlay" onClick={() => props.onClose()}>
      <div class="modal-content" onClick={(e) => e.stopPropagation()}>
        <button class="modal-close" onClick={() => props.onClose()}>
          &times;
        </button>

        <div class="modal-header">
          <h2>Welcome to {props.familyName}!</h2>
          <p>Let's connect you to your family record.</p>
        </div>

        <div class="modal-body">
          <Show when={isLoading()}>
            <div class="loading-state">
              <div class="loading-spinner" />
              <p>Looking for your record...</p>
            </div>
          </Show>

          <Show when={error()}>
            <div class="error-state">
              <p>{error()}</p>
              <button class="btn-secondary" onClick={() => props.onDeny()}>
                Set up manually
              </button>
            </div>
          </Show>

          <Show when={!isLoading() && !error() && suggestion()}>
            <div class="suggestion-card">
              <div class="suggestion-header">
                <span class="confidence-badge">
                  {getConfidenceLabel(suggestion()?.confidence ?? null)}
                </span>
              </div>

              <div class="suggestion-body">
                <p class="question">Are you...</p>
                <h3 class="person-name">{suggestion()?.name}</h3>

                <Show when={suggestion()?.matchReason}>
                  <p class="match-reason">{suggestion()?.matchReason}</p>
                </Show>

                <Show
                  when={
                    suggestion()?.aliases && suggestion()!.aliases.length > 0
                  }
                >
                  <p class="aliases">
                    Also known as: {suggestion()?.aliases.join(', ')}
                  </p>
                </Show>

                <Show when={suggestion()?.birthYear || suggestion()?.deathYear}>
                  <p class="years">
                    {suggestion()?.birthYear &&
                      `Born ${suggestion()?.birthYear}`}
                    {suggestion()?.birthYear &&
                      suggestion()?.deathYear &&
                      ' - '}
                    {suggestion()?.deathYear && `${suggestion()?.deathYear}`}
                  </p>
                </Show>
              </div>

              <div class="suggestion-actions">
                <button
                  class="btn-primary"
                  onClick={handleConfirm}
                  disabled={isConfirming()}
                >
                  {isConfirming() ? 'Confirming...' : "Yes, that's me!"}
                </button>
                <button
                  class="btn-secondary"
                  onClick={handleDeny}
                  disabled={isConfirming()}
                >
                  No, I'm someone else
                </button>
              </div>
              <button
                class="btn-skip"
                onClick={() => props.onSkip()}
                disabled={isConfirming()}
              >
                I'll do this later
              </button>
            </div>
          </Show>

          <Show when={!isLoading() && !error() && !suggestion()}>
            <div class="no-suggestion">
              <p>
                We couldn't find a matching record for you in this family yet.
              </p>
              <p>
                You can create your profile or choose from existing records.
              </p>
              <div class="no-suggestion-actions">
                <button class="btn-primary" onClick={() => props.onDeny()}>
                  Set up my profile
                </button>
                <button class="btn-skip" onClick={() => props.onSkip()}>
                  I'll do this later
                </button>
              </div>
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
};
