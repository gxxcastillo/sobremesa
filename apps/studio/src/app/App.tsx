import { createSignal, Show, onMount, createEffect } from 'solid-js';
import { useParams, useNavigate } from '@solidjs/router';
import {
  StudioApiClient,
  FamilySummary as FamilySummaryType,
  AllowedChat,
} from '@sobremesa/api-client';
import { useAuth } from '../context/AuthContext';
import { FamilySummary } from './FamilySummary';
import './App.css';

export default function App() {
  const auth = useAuth();
  const params = useParams<{ familyId: string }>();
  const navigate = useNavigate();

  const [summary, setSummary] = createSignal<FamilySummaryType | null>(null);
  const [isLoading, setIsLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  // Admin state
  const [chatId, setChatId] = createSignal('');
  const [chatNote, setChatNote] = createSignal('');
  const [adminLoading, setAdminLoading] = createSignal(false);
  const [adminError, setAdminError] = createSignal<string | null>(null);
  const [adminSuccess, setAdminSuccess] = createSignal<string | null>(null);
  const [allowedChats, setAllowedChats] = createSignal<AllowedChat[]>([]);

  const client = new StudioApiClient();

  const isSuperAdmin = () => auth.state.user?.role === 'super_admin';

  // Sync auth token with client
  createEffect(() => {
    const token = auth.getToken();
    if (token) {
      client.setAuthToken(token);
    }
  });

  // Sync family selection with URL
  createEffect(() => {
    if (
      params.familyId &&
      params.familyId !== auth.state.currentFamily?.familyId
    ) {
      auth.selectFamily(params.familyId);
    }
  });

  const loadFamilySummary = async () => {
    const familyId = params.familyId || auth.state.currentFamily?.familyId;
    if (!familyId) return;

    setIsLoading(true);
    setError(null);
    try {
      const familySummary = await client.getFamilySummaryById(familyId);
      setSummary(familySummary);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  const loadAllowedChats = async () => {
    if (!isSuperAdmin()) return;
    try {
      const chats = await client.getAllowedChats();
      setAllowedChats(chats);
    } catch (err) {
      console.error('Failed to load allowed chats:', err);
    }
  };

  const authorizeChat = async (e: Event) => {
    e.preventDefault();
    if (!chatId().trim()) return;

    setAdminLoading(true);
    setAdminError(null);
    setAdminSuccess(null);

    try {
      await client.authorizeChat(
        chatId().trim(),
        chatNote().trim() || undefined,
      );
      setAdminSuccess(`Chat ID "${chatId()}" authorized successfully`);
      setChatId('');
      setChatNote('');
      await loadAllowedChats();
    } catch (err) {
      setAdminError(
        err instanceof Error ? err.message : 'Failed to authorize chat',
      );
      console.error(err);
    } finally {
      setAdminLoading(false);
    }
  };

  const removeChat = async (chatIdToRemove: string) => {
    try {
      await client.removeChat(chatIdToRemove);
      await loadAllowedChats();
    } catch (err) {
      setAdminError(
        err instanceof Error ? err.message : 'Failed to remove chat',
      );
      console.error(err);
    }
  };

  const handleLogout = () => {
    auth.logout();
    navigate('/login');
  };

  const handleSwitchFamily = () => {
    navigate('/select-family');
  };

  const handleIdentitySettings = () => {
    const familyId = params.familyId || auth.state.currentFamily?.familyId;
    if (familyId) {
      navigate('/family/' + familyId + '/identity');
    }
  };

  const handleSettings = () => {
    navigate('/settings');
  };

  // Load data on mount
  onMount(() => {
    loadFamilySummary();
    if (isSuperAdmin()) {
      loadAllowedChats();
    }
  });

  return (
    <div class="app-container">
      <header class="app-header">
        <div class="header-left">
          <h1>Studio</h1>
          <Show when={auth.state.currentFamily}>
            <span class="family-name">
              {auth.state.currentFamily?.familyName}
            </span>
            <span class="role-badge">{auth.state.currentFamily?.role}</span>
          </Show>
        </div>
        <div class="header-right">
          <Show when={auth.state.user}>
            <span class="user-name">
              {auth.state.user?.displayName ||
                auth.state.user?.providerUsername}
            </span>
          </Show>
          <button
            class="btn-secondary btn-small"
            onClick={handleIdentitySettings}
            title="Identity Settings"
          >
            Identity
          </button>
          <button
            class="btn-secondary btn-small"
            onClick={handleSettings}
            title="Account Settings"
          >
            Settings
          </button>
          <Show when={auth.state.families.length > 1}>
            <button
              class="btn-secondary btn-small"
              onClick={handleSwitchFamily}
            >
              Switch Family
            </button>
          </Show>
          <button class="btn-secondary btn-small" onClick={handleLogout}>
            Sign Out
          </button>
        </div>
      </header>

      <main class="app-main">
        {/* Super Admin Section - only for super admins */}
        <Show when={isSuperAdmin()}>
          <section class="admin-section">
            <h2>Super Admin</h2>

            <div class="admin-form-container">
              <h3>Authorize Chat ID</h3>
              <form class="admin-form" onSubmit={authorizeChat}>
                <div class="form-group">
                  <label for="chatId">Chat ID</label>
                  <input
                    id="chatId"
                    type="text"
                    value={chatId()}
                    onInput={(e) => setChatId(e.currentTarget.value)}
                    placeholder="Enter Telegram chat ID"
                    disabled={adminLoading()}
                  />
                </div>
                <div class="form-group">
                  <label for="chatNote">Note (optional)</label>
                  <textarea
                    id="chatNote"
                    value={chatNote()}
                    onInput={(e) => setChatNote(e.currentTarget.value)}
                    placeholder="e.g., Family name or description"
                    disabled={adminLoading()}
                    rows={3}
                  />
                </div>
                <button
                  type="submit"
                  class="admin-btn"
                  disabled={adminLoading() || !chatId().trim()}
                >
                  {adminLoading() ? 'Authorizing...' : 'Authorize'}
                </button>
              </form>

              {adminError() && <div class="error-message">{adminError()}</div>}
              {adminSuccess() && (
                <div class="success-message">{adminSuccess()}</div>
              )}
            </div>

            {allowedChats().length > 0 && (
              <div class="allowed-chats">
                <h3>Allowed Chats ({allowedChats().length})</h3>
                <ul>
                  {allowedChats().map((chat) => (
                    <li>
                      <span class="chat-id">{chat.chatId}</span>
                      {chat.note && (
                        <span class="chat-note"> - {chat.note}</span>
                      )}
                      <button
                        class="remove-btn"
                        onClick={() => removeChat(chat.chatId)}
                        title="Remove"
                      >
                        x
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div class="admin-actions">
              <h3>Import Tools</h3>
              <button
                class="admin-btn"
                onClick={() => navigate('/import/whatsapp')}
              >
                Import WhatsApp Chat
              </button>
            </div>

            <hr class="section-divider" />
          </section>
        </Show>

        {/* Data Preview Section */}
        <section class="preview-section">
          <h2>Family Data</h2>
          <button
            class="generate-btn"
            onClick={loadFamilySummary}
            disabled={isLoading()}
          >
            {isLoading() ? 'Loading...' : 'Refresh Data'}
          </button>

          {error() && <div class="error-message">{error()}</div>}

          <Show when={summary()} keyed>
            {(s) => <FamilySummary summary={s} />}
          </Show>
        </section>
      </main>
    </div>
  );
}
