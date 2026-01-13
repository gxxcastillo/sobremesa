import { createSignal } from 'solid-js';
import { PublisherApiClient, FamilySummary } from '@sobremesa/api-client';
import './App.css';

export default function App() {
  const [summary, setSummary] = createSignal<FamilySummary | null>(null);
  const [isLoading, setIsLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const client = new PublisherApiClient();

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

  return (
    <div class="app-container">
      <header class="app-header">
        <h1>Publisher</h1>
        <p>Generate narratives from family data</p>
      </header>

      <main class="app-main">
        <button class="generate-btn" onClick={generateSummary} disabled={isLoading()}>
          {isLoading() ? 'Generating...' : 'Generate Preview'}
        </button>

        {error() && <div class="error-message">{error()}</div>}

        {summary() && (
          <div class="summary-container">
            <h2>WHAT WE KNOW: {summary()!.familyName}</h2>

            {summary()!.people.length > 0 && (
              <section class="summary-section">
                <h3>PEOPLE ({summary()!.people.length})</h3>
                <ul>
                  {summary()!.people.map((p) => (
                    <li>
                      <strong>{p.name}</strong>
                      {p.aliases?.length && <span> (aka {p.aliases.join(', ')})</span>}
                      {(p.birth_year || p.death_year) && (
                        <span>
                          {' '}
                          [{p.birth_year || '?'}–{p.death_year || (p.birth_year ? 'present' : '?')}]
                        </span>
                      )}
                      {p.notes_original && <p class="notes">{p.notes_original}</p>}
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
                      {r.person_a?.name || 'Unknown'} → <strong>{r.relationship_type}</strong> → {r.person_b?.name || 'Unknown'}
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
                      {[p.city, p.region, p.country].filter(Boolean).join(', ') && p.name !== [p.city, p.region, p.country].filter(Boolean).join(', ') && (
                        <span> - {[p.city, p.region, p.country].filter(Boolean).join(', ')}</span>
                      )}
                      {p.context_original && <p class="notes">{p.context_original}</p>}
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
                      {e.date_year && <span class="date">[{e.date_month ? `${e.date_month}/` : ''}${e.date_year}]</span>}
                      {e.event_type && <span class="event-type">({e.event_type})</span>}
                      <strong>{e.title}</strong>
                      {e.description_original && <p class="notes">{e.description_original}</p>}
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
                        {s.completeness === 'complete' ? '✓' : s.completeness === 'partial' ? '◐' : '○'}
                      </span>
                      <strong>{s.title || 'Untitled'}</strong>
                      {s.themes?.length && <p class="themes">Themes: {s.themes.join(', ')}</p>}
                      {s.content_original && <p class="notes">{s.content_original}</p>}
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
                <strong>TOTALS:</strong> {summary()!.people.length} people, {summary()!.places.length} places, {summary()!.events.length} events •{' '}
                {summary()!.relationships.length} relationships, {summary()!.stories.length} stories
              </p>
            </footer>
          </div>
        )}
      </main>
    </div>
  );
}
