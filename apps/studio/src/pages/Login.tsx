/**
 * Login Page
 *
 * Landing page with Telegram login button and public stats.
 */

import {
  type Component,
  createSignal,
  createEffect,
  onMount,
  Show,
} from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { StudioApiClient, type PublicStats } from '@sobremesa/api-client';
import {
  TelegramLoginButton,
  type TelegramLoginData,
} from '../components/TelegramLoginButton';
import { useAuth } from '../context/AuthContext';

const TELEGRAM_BOT_NAME = import.meta.env.VITE_TELEGRAM_BOT_NAME;

export const Login: Component = () => {
  const auth = useAuth();
  const navigate = useNavigate();
  const client = new StudioApiClient();

  const [stats, setStats] = createSignal<PublicStats | null>(null);
  const [isLoading, setIsLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  // Load public stats on mount
  onMount(async () => {
    try {
      const publicStats = await client.getPublicStats();
      setStats(publicStats);
    } catch (err) {
      console.error('Failed to load public stats:', err);
    }
  });

  // Redirect if already authenticated (reactive — fires when auth loads)
  createEffect(() => {
    if (auth.state.isAuthenticated) {
      navigate('/', { replace: true });
    }
  });

  const handleTelegramAuth = async (data: TelegramLoginData) => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await client.loginWithTelegram(data);
      auth.login(response.token, response.user, response.families);

      // Navigate to appropriate page
      if (response.families.length === 0) {
        // No families yet - show message
        setError(
          "You don't have access to any families yet. Request an access pass from your family group chat using /sobremesa studio-link",
        );
      } else if (response.families.length === 1) {
        navigate('/family/' + response.families[0].familyId);
      } else {
        navigate('/select-family');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
      console.error('Login error:', err);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div class="login-page">
      <div class="login-container">
        <header class="login-header">
          <h1>Sobremesa Studio</h1>
          <p>Explore and preserve your family's stories</p>
        </header>

        <main class="login-main">
          <div class="login-card">
            <h2>Welcome</h2>
            <p class="login-description">
              Sign in with Telegram to access your family's collected stories,
              people, places, and timeline.
            </p>

            <Show when={error()}>
              <div class="error-message">{error()}</div>
            </Show>

            <Show when={isLoading()}>
              <div class="loading-message">Signing in...</div>
            </Show>

            <Show when={!isLoading()}>
              <div class="telegram-auth">
                <TelegramLoginButton
                  botName={TELEGRAM_BOT_NAME}
                  onAuth={handleTelegramAuth}
                  buttonSize="large"
                />
              </div>
            </Show>

            <p class="login-help">
              Don't have a family yet?{' '}
              <a
                href={`https://t.me/${TELEGRAM_BOT_NAME}`}
                target="_blank"
                rel="noopener"
              >
                Add the bot to your family group
              </a>{' '}
              and use <code>/sobremesa</code> to get started.
            </p>
          </div>

          <Show when={stats()}>
            <div class="public-stats">
              <h3>Community Stats</h3>
              <div class="stats-grid">
                <div class="stat-item">
                  <span class="stat-value">{stats()!.totalFamilies}</span>
                  <span class="stat-label">Families</span>
                </div>
                <div class="stat-item">
                  <span class="stat-value">{stats()!.totalPeople}</span>
                  <span class="stat-label">People</span>
                </div>
                <div class="stat-item">
                  <span class="stat-value">{stats()!.totalStories}</span>
                  <span class="stat-label">Stories</span>
                </div>
                <div class="stat-item">
                  <span class="stat-value">{stats()!.totalEvents}</span>
                  <span class="stat-label">Events</span>
                </div>
              </div>
            </div>
          </Show>
        </main>

        <footer class="login-footer">
          <p>Sobremesa - Preserving family stories through conversation</p>
        </footer>
      </div>
    </div>
  );
};
