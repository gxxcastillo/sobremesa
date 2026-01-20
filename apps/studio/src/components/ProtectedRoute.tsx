/**
 * Protected Route Component
 *
 * Wraps routes that require authentication.
 * Redirects to login page if not authenticated.
 */

import { type ParentComponent, Show, createEffect } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { useAuth } from '../context/AuthContext';

interface ProtectedRouteProps {
  requireFamily?: boolean;
  requireAdmin?: boolean;
}

export const ProtectedRoute: ParentComponent<ProtectedRouteProps> = (props) => {
  const auth = useAuth();
  const navigate = useNavigate();

  createEffect(() => {
    // Wait for auth to finish loading
    if (auth.state.isLoading) {
      return;
    }

    // Redirect to login if not authenticated
    if (!auth.state.isAuthenticated) {
      navigate('/login', { replace: true });
      return;
    }

    // Redirect to family selection if family is required but not selected
    if (props.requireFamily && !auth.state.currentFamily) {
      navigate('/select-family', { replace: true });
      return;
    }

    // Check admin access if required
    if (props.requireAdmin && auth.state.currentFamily) {
      if (
        auth.state.currentFamily.role !== 'admin' &&
        auth.state.user?.role !== 'super_admin'
      ) {
        // User doesn't have admin access to current family
        navigate('/family/' + auth.state.currentFamily.familyId, {
          replace: true,
        });
      }
    }
  });

  return (
    <Show
      when={!auth.state.isLoading && auth.state.isAuthenticated}
      fallback={
        <div class="loading-container">
          <div class="loading-spinner" />
          <p>Loading...</p>
        </div>
      }
    >
      {props.children}
    </Show>
  );
};
