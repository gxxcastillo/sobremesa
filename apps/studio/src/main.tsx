import { render } from 'solid-js/web';
import { Router, Route } from '@solidjs/router';
import { AuthProvider } from './context/AuthContext';
import { ProtectedRoute } from './components/ProtectedRoute';
import { Login } from './pages/Login';
import { AccessPass } from './pages/AccessPass';
import { SelectFamily } from './pages/SelectFamily';
import { IdentitySettings } from './pages/IdentitySettings';
import { Settings } from './pages/Settings';
import App from './app/App';
import './styles.css';

const root = document.getElementById('root');
if (root) {
  render(
    () => (
      <AuthProvider>
        <Router>
          {/* Public routes */}
          <Route path="/login" component={Login} />
          <Route path="/pass/:token" component={AccessPass} />

          {/* Protected routes */}
          <Route
            path="/select-family"
            component={() => (
              <ProtectedRoute>
                <SelectFamily />
              </ProtectedRoute>
            )}
          />
          <Route
            path="/family/:familyId"
            component={() => (
              <ProtectedRoute requireFamily>
                <App />
              </ProtectedRoute>
            )}
          />
          <Route
            path="/family/:familyId/identity"
            component={() => (
              <ProtectedRoute requireFamily>
                <IdentitySettings />
              </ProtectedRoute>
            )}
          />
          <Route
            path="/settings"
            component={() => (
              <ProtectedRoute>
                <Settings />
              </ProtectedRoute>
            )}
          />
          <Route
            path="/family/:familyId/*"
            component={() => (
              <ProtectedRoute requireFamily>
                <App />
              </ProtectedRoute>
            )}
          />

          {/* Default route - redirect to login or dashboard */}
          <Route
            path="/"
            component={() => (
              <ProtectedRoute>
                <SelectFamily />
              </ProtectedRoute>
            )}
          />
          <Route
            path="*"
            component={() => (
              <ProtectedRoute>
                <SelectFamily />
              </ProtectedRoute>
            )}
          />
        </Router>
      </AuthProvider>
    ),
    root,
  );
}
