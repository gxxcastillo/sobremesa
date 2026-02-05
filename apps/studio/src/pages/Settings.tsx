/**
 * Settings Page
 *
 * Allows users to manage their account settings including timezone.
 */

import { type Component, createSignal, Show, createEffect } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { StudioApiClient } from '@sobremesa/api-client';
import { useAuth } from '../context/AuthContext';
import './Settings.css';

// Common IANA timezones grouped by region
const TIMEZONE_OPTIONS = [
  {
    group: 'Americas',
    zones: [
      { value: 'America/New_York', label: 'Eastern Time (New York)' },
      { value: 'America/Chicago', label: 'Central Time (Chicago)' },
      { value: 'America/Denver', label: 'Mountain Time (Denver)' },
      { value: 'America/Los_Angeles', label: 'Pacific Time (Los Angeles)' },
      { value: 'America/Anchorage', label: 'Alaska Time (Anchorage)' },
      { value: 'Pacific/Honolulu', label: 'Hawaii Time (Honolulu)' },
      { value: 'America/Phoenix', label: 'Arizona (Phoenix)' },
      { value: 'America/Toronto', label: 'Eastern Time (Toronto)' },
      { value: 'America/Vancouver', label: 'Pacific Time (Vancouver)' },
      { value: 'America/Mexico_City', label: 'Mexico City' },
      { value: 'America/Bogota', label: 'Colombia (Bogota)' },
      { value: 'America/Lima', label: 'Peru (Lima)' },
      { value: 'America/Santiago', label: 'Chile (Santiago)' },
      { value: 'America/Buenos_Aires', label: 'Argentina (Buenos Aires)' },
      { value: 'America/Sao_Paulo', label: 'Brazil (Sao Paulo)' },
    ],
  },
  {
    group: 'Europe',
    zones: [
      { value: 'Europe/London', label: 'UK (London)' },
      { value: 'Europe/Dublin', label: 'Ireland (Dublin)' },
      { value: 'Europe/Paris', label: 'Central Europe (Paris)' },
      { value: 'Europe/Berlin', label: 'Germany (Berlin)' },
      { value: 'Europe/Madrid', label: 'Spain (Madrid)' },
      { value: 'Europe/Rome', label: 'Italy (Rome)' },
      { value: 'Europe/Amsterdam', label: 'Netherlands (Amsterdam)' },
      { value: 'Europe/Brussels', label: 'Belgium (Brussels)' },
      { value: 'Europe/Zurich', label: 'Switzerland (Zurich)' },
      { value: 'Europe/Vienna', label: 'Austria (Vienna)' },
      { value: 'Europe/Warsaw', label: 'Poland (Warsaw)' },
      { value: 'Europe/Prague', label: 'Czech Republic (Prague)' },
      { value: 'Europe/Stockholm', label: 'Sweden (Stockholm)' },
      { value: 'Europe/Helsinki', label: 'Finland (Helsinki)' },
      { value: 'Europe/Athens', label: 'Greece (Athens)' },
      { value: 'Europe/Moscow', label: 'Russia (Moscow)' },
    ],
  },
  {
    group: 'Asia',
    zones: [
      { value: 'Asia/Dubai', label: 'UAE (Dubai)' },
      { value: 'Asia/Kolkata', label: 'India (Kolkata)' },
      { value: 'Asia/Bangkok', label: 'Thailand (Bangkok)' },
      { value: 'Asia/Singapore', label: 'Singapore' },
      { value: 'Asia/Hong_Kong', label: 'Hong Kong' },
      { value: 'Asia/Shanghai', label: 'China (Shanghai)' },
      { value: 'Asia/Tokyo', label: 'Japan (Tokyo)' },
      { value: 'Asia/Seoul', label: 'South Korea (Seoul)' },
      { value: 'Asia/Manila', label: 'Philippines (Manila)' },
      { value: 'Asia/Jakarta', label: 'Indonesia (Jakarta)' },
    ],
  },
  {
    group: 'Pacific',
    zones: [
      { value: 'Australia/Sydney', label: 'Australia Eastern (Sydney)' },
      { value: 'Australia/Melbourne', label: 'Australia (Melbourne)' },
      { value: 'Australia/Brisbane', label: 'Australia (Brisbane)' },
      { value: 'Australia/Perth', label: 'Australia Western (Perth)' },
      { value: 'Australia/Adelaide', label: 'Australia Central (Adelaide)' },
      { value: 'Pacific/Auckland', label: 'New Zealand (Auckland)' },
      { value: 'Pacific/Fiji', label: 'Fiji' },
    ],
  },
  {
    group: 'Africa & Middle East',
    zones: [
      { value: 'Africa/Cairo', label: 'Egypt (Cairo)' },
      { value: 'Africa/Johannesburg', label: 'South Africa (Johannesburg)' },
      { value: 'Africa/Lagos', label: 'Nigeria (Lagos)' },
      { value: 'Africa/Nairobi', label: 'Kenya (Nairobi)' },
      { value: 'Asia/Jerusalem', label: 'Israel (Jerusalem)' },
      { value: 'Asia/Riyadh', label: 'Saudi Arabia (Riyadh)' },
    ],
  },
];

export const Settings: Component = () => {
  const auth = useAuth();
  const navigate = useNavigate();
  const client = new StudioApiClient();

  const [selectedTimezone, setSelectedTimezone] = createSignal(
    auth.state.user?.timezone || '',
  );
  const [isSaving, setIsSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [successMessage, setSuccessMessage] = createSignal<string | null>(null);

  // Sync auth token with client
  createEffect(() => {
    const token = auth.getToken();
    if (token) {
      client.setAuthToken(token);
    }
  });

  // Update selected timezone when auth state changes
  createEffect(() => {
    if (auth.state.user?.timezone) {
      setSelectedTimezone(auth.state.user.timezone);
    }
  });

  const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const handleSaveTimezone = async () => {
    const timezone = selectedTimezone();
    if (!timezone) {
      setError('Please select a timezone');
      return;
    }

    setIsSaving(true);
    setError(null);
    setSuccessMessage(null);

    try {
      await client.updateMyTimezone(timezone);
      // Refresh user data to update the auth state
      await auth.refreshUser();
      setSuccessMessage('Timezone updated successfully');
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to update timezone',
      );
      console.error('Failed to update timezone:', err);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDetectTimezone = () => {
    setSelectedTimezone(browserTimezone);
  };

  const handleBack = () => {
    const familyId = auth.state.currentFamily?.familyId;
    if (familyId) {
      navigate('/family/' + familyId);
    } else {
      navigate('/');
    }
  };

  const formatTimezoneDisplay = (tz: string | null | undefined) => {
    if (!tz) return 'Not set';

    // Find the label for this timezone
    for (const group of TIMEZONE_OPTIONS) {
      const zone = group.zones.find((z) => z.value === tz);
      if (zone) return zone.label;
    }

    // If not in our list, just display the IANA name
    return tz;
  };

  const getCurrentTimeInTimezone = (tz: string | null | undefined) => {
    if (!tz) return '';
    try {
      return new Date().toLocaleTimeString('en-US', {
        timeZone: tz,
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });
    } catch {
      return '';
    }
  };

  return (
    <div class="settings-page">
      <div class="settings-container">
        <header class="settings-header">
          <button class="back-btn" onClick={handleBack}>
            &larr; Back
          </button>
          <h1>Settings</h1>
          <p>Manage your account preferences</p>
        </header>

        <main class="settings-main">
          <Show when={error()}>
            <div class="error-message">{error()}</div>
          </Show>

          <Show when={successMessage()}>
            <div class="success-message">{successMessage()}</div>
          </Show>

          {/* Timezone Section */}
          <section class="settings-section">
            <h2>Timezone</h2>
            <p class="section-description">
              Your timezone is used to accurately interpret relative dates like
              "tomorrow" or "next week" in your messages.
            </p>

            <div class="current-timezone">
              <span class="label">Current timezone:</span>
              <span class="value">
                {formatTimezoneDisplay(auth.state.user?.timezone)}
                <Show when={auth.state.user?.timezone}>
                  <span class="current-time">
                    ({getCurrentTimeInTimezone(auth.state.user?.timezone)} now)
                  </span>
                </Show>
              </span>
            </div>

            <div class="form-group">
              <label for="timezone">Select timezone</label>
              <div class="timezone-select-wrapper">
                <select
                  id="timezone"
                  value={selectedTimezone()}
                  onChange={(e) => setSelectedTimezone(e.currentTarget.value)}
                  disabled={isSaving()}
                >
                  <option value="">-- Select a timezone --</option>
                  {TIMEZONE_OPTIONS.map((group) => (
                    <optgroup label={group.group}>
                      {group.zones.map((zone) => (
                        <option value={zone.value}>{zone.label}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>
              <Show
                when={
                  selectedTimezone() &&
                  selectedTimezone() !== auth.state.user?.timezone
                }
              >
                <span class="preview-time">
                  Preview: {getCurrentTimeInTimezone(selectedTimezone())} in
                  selected timezone
                </span>
              </Show>
            </div>

            <div class="timezone-actions">
              <button
                class="btn-detect"
                onClick={handleDetectTimezone}
                disabled={isSaving()}
                title={`Detected: ${browserTimezone}`}
              >
                Detect from browser
              </button>
              <button
                class="btn-primary"
                onClick={handleSaveTimezone}
                disabled={
                  isSaving() ||
                  !selectedTimezone() ||
                  selectedTimezone() === auth.state.user?.timezone
                }
              >
                {isSaving() ? 'Saving...' : 'Save Timezone'}
              </button>
            </div>

            <Show
              when={
                browserTimezone !== auth.state.user?.timezone &&
                auth.state.user?.timezone
              }
            >
              <div class="timezone-hint">
                Your browser timezone ({browserTimezone}) differs from your
                saved setting. Click "Detect from browser" to update.
              </div>
            </Show>
          </section>

          {/* Account Info Section */}
          <section class="settings-section">
            <h2>Account</h2>

            <div class="account-info">
              <div class="info-row">
                <span class="label">Display name:</span>
                <span class="value">
                  {auth.state.user?.displayName || 'Not set'}
                </span>
              </div>
              <div class="info-row">
                <span class="label">Provider:</span>
                <span class="value capitalize">
                  {auth.state.user?.provider}
                </span>
              </div>
              <Show when={auth.state.user?.providerUsername}>
                <div class="info-row">
                  <span class="label">Username:</span>
                  <span class="value">
                    @{auth.state.user?.providerUsername}
                  </span>
                </div>
              </Show>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
};
