/**
 * Family Selection Page
 *
 * Allows users with multiple families to select which one to view.
 */

import { type Component, For, Show } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { useAuth } from '../context/AuthContext';

export const SelectFamily: Component = () => {
  const auth = useAuth();
  const navigate = useNavigate();

  const handleSelectFamily = (familyId: string) => {
    auth.selectFamily(familyId);
    navigate('/family/' + familyId);
  };

  const getRoleBadge = (role: string) => {
    switch (role) {
      case 'admin':
        return <span class="role-badge role-admin">Admin</span>;
      case 'member':
        return <span class="role-badge role-member">Member</span>;
      case 'viewer':
        return <span class="role-badge role-viewer">Viewer</span>;
      default:
        return null;
    }
  };

  return (
    <div class="select-family-page">
      <div class="select-family-container">
        <header class="select-family-header">
          <h1>Select Family</h1>
          <p>Choose which family you want to view</p>
        </header>

        <main class="select-family-main">
          <Show
            when={auth.state.families.length > 0}
            fallback={
              <div class="no-families">
                <p>You don't have access to any families yet.</p>
                <p>
                  Request an access pass from your family group chat using{' '}
                  <code>/sobremesa studio-link</code>
                </p>
              </div>
            }
          >
            <div class="family-list">
              <For each={auth.state.families}>
                {(family) => (
                  <button
                    class="family-card"
                    onClick={() => handleSelectFamily(family.familyId)}
                  >
                    <div class="family-info">
                      <h3 class="family-name">{family.familyName}</h3>
                      <p class="family-joined">
                        Joined {new Date(family.grantedAt).toLocaleDateString()}
                      </p>
                    </div>
                    <div class="family-role">{getRoleBadge(family.role)}</div>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </main>

        <footer class="select-family-footer">
          <button class="btn-secondary" onClick={() => auth.logout()}>
            Sign Out
          </button>
        </footer>
      </div>
    </div>
  );
};
