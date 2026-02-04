/**
 * Identity Settings Page
 *
 * Allows users to manually select or change their identity in a family.
 */

import {
  type Component,
  createSignal,
  Show,
  For,
  onMount,
  createEffect,
} from 'solid-js';
import { useParams, useNavigate } from '@solidjs/router';
import {
  StudioApiClient,
  type FamilyPerson,
  type PersonSuggestion,
  type CreatePersonRequest,
  type UpdatePersonRequest,
} from '@sobremesa/api-client';
import { useAuth } from '../context/AuthContext';
import './IdentitySettings.css';

export const IdentitySettings: Component = () => {
  const auth = useAuth();
  const params = useParams<{ familyId: string }>();
  const navigate = useNavigate();
  const client = new StudioApiClient();

  const [isLoading, setIsLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [currentClaim, setCurrentClaim] = createSignal<PersonSuggestion | null>(
    null,
  );
  const [people, setPeople] = createSignal<FamilyPerson[]>([]);
  const [searchTerm, setSearchTerm] = createSignal('');
  const [isSearching, setIsSearching] = createSignal(false);
  const [isClaiming, setIsClaiming] = createSignal(false);
  const [successMessage, setSuccessMessage] = createSignal<string | null>(null);

  // Create profile form state
  const [showCreateForm, setShowCreateForm] = createSignal(false);
  const [isCreating, setIsCreating] = createSignal(false);
  const [newName, setNewName] = createSignal('');
  const [newAliases, setNewAliases] = createSignal('');
  const [newBirthYear, setNewBirthYear] = createSignal('');
  const [newNotes, setNewNotes] = createSignal('');

  // Edit profile form state
  const [showEditForm, setShowEditForm] = createSignal(false);
  const [isUpdating, setIsUpdating] = createSignal(false);
  const [editName, setEditName] = createSignal('');
  const [editAliases, setEditAliases] = createSignal('');
  const [editBirthYear, setEditBirthYear] = createSignal('');
  const [editNotes, setEditNotes] = createSignal('');

  // Sync auth token with client
  createEffect(() => {
    const token = auth.getToken();
    if (token) {
      client.setAuthToken(token);
    }
  });

  const familyId = () => params.familyId || auth.state.currentFamily?.familyId;
  const familyName = () =>
    auth.state.families.find((f) => f.familyId === familyId())?.familyName ||
    'Family';

  // Load current identity and initial people list
  onMount(async () => {
    const fId = familyId();
    if (!fId) {
      setError('No family selected');
      setIsLoading(false);
      return;
    }

    try {
      const [identityResponse, peopleList] = await Promise.all([
        client.getIdentity(fId),
        client.listPeople(fId),
      ]);

      setCurrentClaim(identityResponse.currentClaim);
      setPeople(peopleList);
    } catch (err) {
      console.error('Failed to load identity data:', err);
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setIsLoading(false);
    }
  });

  // Search people when search term changes
  const handleSearch = async () => {
    const fId = familyId();
    if (!fId) return;

    setIsSearching(true);
    try {
      const results = await client.listPeople(fId, searchTerm() || undefined);
      setPeople(results);
    } catch (err) {
      console.error('Search failed:', err);
    } finally {
      setIsSearching(false);
    }
  };

  // Debounced search
  let searchTimeout: ReturnType<typeof setTimeout>;
  const onSearchInput = (value: string) => {
    setSearchTerm(value);
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(handleSearch, 300);
  };

  const handleClaim = async (person: FamilyPerson) => {
    const fId = familyId();
    if (!fId) return;

    setIsClaiming(true);
    setError(null);
    setSuccessMessage(null);

    try {
      await client.claimIdentity(fId, person.id);
      setCurrentClaim({
        id: person.id,
        name: person.name,
        aliases: person.aliases,
        birthYear: person.birthYear,
        deathYear: person.deathYear,
        confidence: null,
        matchReason: null,
      });
      setSuccessMessage(`You are now connected as ${person.name}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to claim identity');
      console.error('Failed to claim identity:', err);
    } finally {
      setIsClaiming(false);
    }
  };

  const handleUnclaim = async () => {
    const fId = familyId();
    if (!fId) return;

    setIsClaiming(true);
    setError(null);
    setSuccessMessage(null);

    try {
      await client.unclaimIdentity(fId);
      setCurrentClaim(null);
      setSuccessMessage('Identity disconnected');
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to disconnect identity',
      );
      console.error('Failed to unclaim identity:', err);
    } finally {
      setIsClaiming(false);
    }
  };

  const handleCreatePerson = async () => {
    const fId = familyId();
    if (!fId) return;

    const name = newName().trim();
    if (!name) {
      setError('Please enter your name');
      return;
    }

    setIsCreating(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const data: CreatePersonRequest = {
        name,
        aliases: newAliases()
          .split(',')
          .map((a) => a.trim())
          .filter((a) => a),
        birthYear: newBirthYear() ? parseInt(newBirthYear(), 10) : undefined,
        notes: newNotes().trim() || undefined,
      };

      const person = await client.createPerson(fId, data);

      // Auto-claim the newly created person
      await client.claimIdentity(fId, person.id);

      setCurrentClaim({
        id: person.id,
        name: person.name,
        aliases: person.aliases,
        birthYear: person.birthYear,
        deathYear: person.deathYear,
        confidence: null,
        matchReason: null,
      });

      // Add to people list
      setPeople((prev) => [person, ...prev]);

      // Reset form
      setShowCreateForm(false);
      setNewName('');
      setNewAliases('');
      setNewBirthYear('');
      setNewNotes('');

      setSuccessMessage(
        `Profile created! You are now connected as ${person.name}`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create profile');
      console.error('Failed to create person:', err);
    } finally {
      setIsCreating(false);
    }
  };

  const openEditForm = () => {
    const claim = currentClaim();
    if (!claim) return;

    setEditName(claim.name);
    setEditAliases(claim.aliases?.join(', ') || '');
    setEditBirthYear(claim.birthYear?.toString() || '');
    setEditNotes(claim.notes || '');
    setShowEditForm(true);
  };

  const handleUpdatePerson = async () => {
    const fId = familyId();
    const claim = currentClaim();
    if (!fId || !claim) return;

    const name = editName().trim();
    if (!name) {
      setError('Name cannot be empty');
      return;
    }

    setIsUpdating(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const data: UpdatePersonRequest = {
        name,
        aliases: editAliases()
          .split(',')
          .map((a) => a.trim())
          .filter((a) => a),
        birthYear: editBirthYear() ? parseInt(editBirthYear(), 10) : null,
        notes: editNotes().trim(),
      };

      const updatedPerson = await client.updatePerson(fId, claim.id, data);

      // Update currentClaim with new data
      setCurrentClaim({
        ...claim,
        name: updatedPerson.name,
        aliases: updatedPerson.aliases,
        birthYear: updatedPerson.birthYear,
        deathYear: updatedPerson.deathYear,
        notes: updatedPerson.notes,
      });

      // Update in people list too
      setPeople((prev) =>
        prev.map((p) =>
          p.id === claim.id
            ? {
                ...p,
                name: updatedPerson.name,
                aliases: updatedPerson.aliases,
                birthYear: updatedPerson.birthYear,
                deathYear: updatedPerson.deathYear,
              }
            : p,
        ),
      );

      setShowEditForm(false);
      setSuccessMessage('Profile updated successfully');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update profile');
      console.error('Failed to update person:', err);
    } finally {
      setIsUpdating(false);
    }
  };

  const handleBack = () => {
    const fId = familyId();
    if (fId) {
      navigate('/family/' + fId);
    } else {
      navigate('/');
    }
  };

  return (
    <div class="identity-page">
      <div class="identity-container">
        <header class="identity-header">
          <button class="back-btn" onClick={handleBack}>
            &larr; Back
          </button>
          <h1>Identity Settings</h1>
          <p>Connect to your record in {familyName()}</p>
        </header>

        <main class="identity-main">
          <Show when={isLoading()}>
            <div class="loading-state">
              <div class="loading-spinner" />
              <p>Loading...</p>
            </div>
          </Show>

          <Show when={error()}>
            <div class="error-message">{error()}</div>
          </Show>

          <Show when={successMessage()}>
            <div class="success-message">{successMessage()}</div>
          </Show>

          <Show when={!isLoading()}>
            {/* Current Identity Section */}
            <section class="current-identity-section">
              <h2>Your Current Identity</h2>

              <Show
                when={currentClaim()}
                fallback={
                  <div class="no-identity">
                    <p>You haven't connected to a person record yet.</p>
                    <p>
                      Select someone from the list below to link your account.
                    </p>
                  </div>
                }
              >
                <Show
                  when={!showEditForm()}
                  fallback={
                    <div class="edit-form">
                      <h3>Edit Your Profile</h3>

                      <div class="form-group">
                        <label for="edit-name">Full Name *</label>
                        <input
                          type="text"
                          id="edit-name"
                          value={editName()}
                          onInput={(e) => setEditName(e.currentTarget.value)}
                          disabled={isUpdating()}
                        />
                      </div>

                      <div class="form-group">
                        <label for="edit-aliases">Nicknames / Aliases</label>
                        <input
                          type="text"
                          id="edit-aliases"
                          placeholder="e.g., Don, Donny (comma-separated)"
                          value={editAliases()}
                          onInput={(e) => setEditAliases(e.currentTarget.value)}
                          disabled={isUpdating()}
                        />
                        <span class="form-hint">
                          Helps the bot recognize you in stories
                        </span>
                      </div>

                      <div class="form-group">
                        <label for="edit-birthYear">Birth Year</label>
                        <input
                          type="number"
                          id="edit-birthYear"
                          placeholder="e.g., 1985"
                          value={editBirthYear()}
                          onInput={(e) =>
                            setEditBirthYear(e.currentTarget.value)
                          }
                          disabled={isUpdating()}
                          min="1900"
                          max={new Date().getFullYear()}
                        />
                      </div>

                      <div class="form-group">
                        <label for="edit-notes">About You</label>
                        <textarea
                          id="edit-notes"
                          placeholder="A brief description or anything you'd like the family to know..."
                          value={editNotes()}
                          onInput={(e) => setEditNotes(e.currentTarget.value)}
                          disabled={isUpdating()}
                          rows={3}
                        />
                      </div>

                      <div class="form-actions">
                        <button
                          class="btn-primary"
                          onClick={handleUpdatePerson}
                          disabled={isUpdating() || !editName().trim()}
                        >
                          {isUpdating() ? 'Saving...' : 'Save Changes'}
                        </button>
                        <button
                          class="btn-secondary"
                          onClick={() => setShowEditForm(false)}
                          disabled={isUpdating()}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  }
                >
                  <div class="current-identity-card">
                    <div class="person-info">
                      <h3>{currentClaim()?.name}</h3>
                      <Show
                        when={
                          currentClaim()?.aliases &&
                          currentClaim()!.aliases.length > 0
                        }
                      >
                        <p class="aliases">
                          Also known as: {currentClaim()?.aliases.join(', ')}
                        </p>
                      </Show>
                      <Show
                        when={
                          currentClaim()?.birthYear || currentClaim()?.deathYear
                        }
                      >
                        <p class="years">
                          {currentClaim()?.birthYear &&
                            `Born ${currentClaim()?.birthYear}`}
                          {currentClaim()?.birthYear &&
                            currentClaim()?.deathYear &&
                            ' - '}
                          {currentClaim()?.deathYear &&
                            `${currentClaim()?.deathYear}`}
                        </p>
                      </Show>
                      <Show when={currentClaim()?.notes}>
                        <p class="notes">{currentClaim()?.notes}</p>
                      </Show>
                    </div>
                    <div class="identity-actions">
                      <button
                        class="btn-edit"
                        onClick={openEditForm}
                        disabled={isClaiming()}
                      >
                        Edit
                      </button>
                      <button
                        class="btn-danger"
                        onClick={handleUnclaim}
                        disabled={isClaiming()}
                      >
                        {isClaiming() ? 'Disconnecting...' : 'Disconnect'}
                      </button>
                    </div>
                  </div>
                </Show>
              </Show>
            </section>

            {/* Search and Select Section */}
            <section class="people-section">
              <h2>Choose a Different Identity</h2>

              <div class="search-box">
                <input
                  type="text"
                  placeholder="Search by name..."
                  value={searchTerm()}
                  onInput={(e) => onSearchInput(e.currentTarget.value)}
                />
                <Show when={isSearching()}>
                  <span class="search-indicator">Searching...</span>
                </Show>
              </div>

              <div class="people-list">
                <For each={people()} fallback={<p>No people found.</p>}>
                  {(person) => (
                    <div
                      class="person-item"
                      classList={{
                        selected: currentClaim()?.id === person.id,
                      }}
                    >
                      <div class="person-info">
                        <span class="name">{person.name}</span>
                        <Show
                          when={person.aliases && person.aliases.length > 0}
                        >
                          <span class="person-aliases">
                            ({person.aliases.join(', ')})
                          </span>
                        </Show>
                        <Show when={person.birthYear || person.deathYear}>
                          <span class="person-years">
                            {person.birthYear || '?'} -{' '}
                            {person.deathYear || 'present'}
                          </span>
                        </Show>
                      </div>
                      <Show when={currentClaim()?.id !== person.id}>
                        <button
                          class="btn-select"
                          onClick={() => handleClaim(person)}
                          disabled={isClaiming()}
                        >
                          Select
                        </button>
                      </Show>
                      <Show when={currentClaim()?.id === person.id}>
                        <span class="current-badge">Current</span>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            </section>

            {/* Create Profile Section */}
            <section class="create-profile-section">
              <Show
                when={!showCreateForm()}
                fallback={
                  <div class="create-form">
                    <h2>Create Your Profile</h2>
                    <p class="form-description">
                      Add yourself to the family records so others can connect
                      stories and memories to you.
                    </p>

                    <div class="form-group">
                      <label for="name">Full Name *</label>
                      <input
                        type="text"
                        id="name"
                        placeholder="e.g., Donald Barreto"
                        value={newName()}
                        onInput={(e) => setNewName(e.currentTarget.value)}
                        disabled={isCreating()}
                      />
                    </div>

                    <div class="form-group">
                      <label for="aliases">Nicknames / Aliases</label>
                      <input
                        type="text"
                        id="aliases"
                        placeholder="e.g., Don, Donny (comma-separated)"
                        value={newAliases()}
                        onInput={(e) => setNewAliases(e.currentTarget.value)}
                        disabled={isCreating()}
                      />
                      <span class="form-hint">
                        Helps the bot recognize you in stories
                      </span>
                    </div>

                    <div class="form-group">
                      <label for="birthYear">Birth Year</label>
                      <input
                        type="number"
                        id="birthYear"
                        placeholder="e.g., 1985"
                        value={newBirthYear()}
                        onInput={(e) => setNewBirthYear(e.currentTarget.value)}
                        disabled={isCreating()}
                        min="1900"
                        max={new Date().getFullYear()}
                      />
                    </div>

                    <div class="form-group">
                      <label for="notes">About You</label>
                      <textarea
                        id="notes"
                        placeholder="A brief description or anything you'd like the family to know..."
                        value={newNotes()}
                        onInput={(e) => setNewNotes(e.currentTarget.value)}
                        disabled={isCreating()}
                        rows={3}
                      />
                    </div>

                    <div class="form-actions">
                      <button
                        class="btn-primary"
                        onClick={handleCreatePerson}
                        disabled={isCreating() || !newName().trim()}
                      >
                        {isCreating() ? 'Creating...' : 'Create Profile'}
                      </button>
                      <button
                        class="btn-secondary"
                        onClick={() => setShowCreateForm(false)}
                        disabled={isCreating()}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                }
              >
                <div class="create-profile-prompt">
                  <h2>Not in the list?</h2>
                  <p>
                    If you don't see yourself in the family records yet, you can
                    create your own profile.
                  </p>
                  <button
                    class="btn-secondary"
                    onClick={() => setShowCreateForm(true)}
                  >
                    Create My Profile
                  </button>
                </div>
              </Show>
            </section>
          </Show>
        </main>
      </div>
    </div>
  );
};
