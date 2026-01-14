import { createSignal } from 'solid-js';
import {
  StudioApiClient,
  FamilySummary,
  AllowedChat,
} from '@sobremesa/api-client';
import './App.css';

export default function App() {
  const [summary, setSummary] = createSignal<FamilySummary | null>(null);
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

  const generateSummary = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const familySummary = await client.getFamilySummary();
      setSummary(familySummary);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  const loadAllowedChats = async () => {
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
        chatNote().trim() || undefined
      );
      setAdminSuccess(`Chat ID "${chatId()}" authorized successfully`);
      setChatId('');
      setChatNote('');
      await loadAllowedChats();
    } catch (err) {
      setAdminError(
        err instanceof Error ? err.message : 'Failed to authorize chat'
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
        err instanceof Error ? err.message : 'Failed to remove chat'
      );
      console.error(err);
    }
  };

  // Load allowed chats on mount
  loadAllowedChats();

  return (
    <div class="app-container">
      <header class="app-header">
        <h1>Studio</h1>
        <p>Manage family data and narratives</p>
      </header>

      <main class="app-main">
        {/* Admin Section */}
        <section class="admin-section">
          <h2>Admin</h2>

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
                    {chat.note && <span class="chat-note"> - {chat.note}</span>}
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
        </section>

        <hr class="section-divider" />

        {/* Data Preview Section */}
        <section class="preview-section">
          <h2>Data Preview</h2>
          <button
            class="generate-btn"
            onClick={generateSummary}
            disabled={isLoading()}
          >
            {isLoading() ? 'Loading...' : 'Load Family Data'}
          </button>

          {error() && <div class="error-message">{error()}</div>}

          {summary() && (
            <div class="summary-container">
              <h2>{summary()!.familyName}</h2>

              {summary()!.people.length > 0 && (
                <section class="summary-section">
                  <h3>PEOPLE ({summary()!.people.length})</h3>
                  <ul>
                    {summary()!.people.map((p) => (
                      <li>
                        <strong>{p.name}</strong>
                        {p.aliases?.length && (
                          <span> (aka {p.aliases.join(', ')})</span>
                        )}
                        {(p.birth_year || p.death_year) && (
                          <span>
                            {' '}
                            [{p.birth_year || '?'}–
                            {p.death_year || (p.birth_year ? 'present' : '?')}]
                          </span>
                        )}
                        {p.notes_original && (
                          <p class="notes">{p.notes_original}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {summary()!.relationships.length > 0 && (
                <section class="summary-section">
                  <h3>RELATIONSHIPS ({summary()!.relationships.length})</h3>
                  <ul>
                    {summary()!.relationships.map((r) => (
                      <li>
                        {r.person_a?.name || 'Unknown'} →{' '}
                        <strong>{r.relationship_type}</strong> →{' '}
                        {r.person_b?.name || 'Unknown'}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {summary()!.places.length > 0 && (
                <section class="summary-section">
                  <h3>PLACES ({summary()!.places.length})</h3>
                  <ul>
                    {summary()!.places.map((p) => (
                      <li>
                        <strong>{p.name}</strong>
                        {p.type && <span> ({p.type})</span>}
                        {[p.city, p.region, p.country]
                          .filter(Boolean)
                          .join(', ') &&
                          p.name !==
                            [p.city, p.region, p.country]
                              .filter(Boolean)
                              .join(', ') && (
                            <span>
                              {' '}
                              -{' '}
                              {[p.city, p.region, p.country]
                                .filter(Boolean)
                                .join(', ')}
                            </span>
                          )}
                        {p.context_original && (
                          <p class="notes">{p.context_original}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {summary()!.events.length > 0 && (
                <section class="summary-section">
                  <h3>TIMELINE EVENTS ({summary()!.events.length})</h3>
                  <ul>
                    {summary()!.events.map((e) => (
                      <li>
                        {e.date_year && (
                          <span class="date">
                            [{e.date_month ? `${e.date_month}/` : ''}$
                            {e.date_year}]
                          </span>
                        )}
                        {e.event_type && (
                          <span class="event-type">({e.event_type})</span>
                        )}
                        <strong>{e.title}</strong>
                        {e.description_original && (
                          <p class="notes">{e.description_original}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {summary()!.stories.length > 0 && (
                <section class="summary-section">
                  <h3>STORIES ({summary()!.stories.length})</h3>
                  <ul>
                    {summary()!.stories.map((s) => (
                      <li>
                        <span class="status">
                          {s.completeness === 'complete'
                            ? '✓'
                            : s.completeness === 'partial'
                            ? '◐'
                            : '○'}
                        </span>
                        <strong>{s.title || 'Untitled'}</strong>
                        {s.themes?.length && (
                          <p class="themes">Themes: {s.themes.join(', ')}</p>
                        )}
                        {s.content_original && (
                          <p class="notes">{s.content_original}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <section class="summary-section">
                <h3>QUESTIONS</h3>
                <ul>
                  <li>Waiting to ask: {summary()!.questions.proposed}</li>
                  <li>Asked (awaiting answer): {summary()!.questions.asked}</li>
                  <li>Answered: {summary()!.questions.answered}</li>
                </ul>
              </section>

              <footer class="summary-footer">
                <p>
                  <strong>TOTALS:</strong> {summary()!.people.length} people,{' '}
                  {summary()!.places.length} places, {summary()!.events.length}{' '}
                  events • {summary()!.relationships.length} relationships,{' '}
                  {summary()!.stories.length} stories
                </p>
              </footer>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
