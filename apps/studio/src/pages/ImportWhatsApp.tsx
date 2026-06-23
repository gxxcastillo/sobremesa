/**
 * WhatsApp Import Wizard
 *
 * Super-admin-only wizard for importing WhatsApp chat exports.
 * Follows a 6-step process: Upload → Family Config → Participants → Preview → Import → Intern Review
 */

import {
  type Component,
  createSignal,
  createEffect,
  untrack,
  Show,
  For,
  onCleanup,
} from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { useAuth } from '../context/AuthContext';
import { useModal } from '../components/Modal';
import { useToast } from '../components/Toast';
import { StudioApiClient } from '@sobremesa/api-client';
import {
  parseWhatsAppExport,
  estimateImportCost,
  formatCostEstimate,
} from '@sobremesa/import-utils';
import type {
  ParseResult,
  ParsedMessage,
  ParticipantConfig,
  ImportConfig,
  CostEstimate,
  ImportStatus,
  LanguageCode,
  MessageWithDecision,
  DuplicateCheckResult,
} from '@sobremesa/shared-types';
import './ImportWhatsApp.css';

// Wizard steps
type WizardStep = 1 | 2 | 3 | 4 | 5 | 6;

const STEP_LABELS = [
  'Upload',
  'Family',
  'Participants',
  'Preview',
  'Import',
  'Review',
];

// Language options
const LANGUAGE_OPTIONS: { value: LanguageCode; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Spanish' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
];

// Common timezones
const TIMEZONE_OPTIONS = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Anchorage',
  'America/Managua',
  'America/Vancouver',
  'America/Mexico_City',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Asia/Dubai',
  'Australia/Sydney',
  'Pacific/Auckland',
];

export const ImportWhatsApp: Component = () => {
  const auth = useAuth();
  const navigate = useNavigate();
  const modal = useModal();
  const toast = useToast();
  const client = new StudioApiClient();

  // Wizard state
  const [step, setStep] = createSignal<WizardStep>(1);
  const [error, setError] = createSignal<string | null>(null);

  // Step 1: Upload state
  const [file, setFile] = createSignal<File | null>(null);
  const [isDragging, setIsDragging] = createSignal(false);
  const [isParsing, setIsParsing] = createSignal(false);
  const [parseResult, setParseResult] = createSignal<ParseResult | null>(null);

  // Step 2: Family config state
  const [familyName, setFamilyName] = createSignal('');
  const [defaultLanguage, setDefaultLanguage] =
    createSignal<LanguageCode>('en');
  const [familyTimezone, setFamilyTimezone] = createSignal(
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  );

  // Step 3: Participant config state
  const [participants, setParticipants] = createSignal<ParticipantConfig[]>([]);

  // Step 4: Preview state
  const [costEstimate, setCostEstimate] = createSignal<CostEstimate | null>(
    null,
  );
  const [showAllMessages, setShowAllMessages] = createSignal(false);
  const [isCheckingDuplicates, setIsCheckingDuplicates] = createSignal(false);
  const [duplicateResult, setDuplicateResult] =
    createSignal<DuplicateCheckResult | null>(null);

  // Step 5: Import state
  const [isImporting, setIsImporting] = createSignal(false);
  const [importStatus, setImportStatus] = createSignal<ImportStatus | null>(
    null,
  );
  const [pollInterval, setPollInterval] = createSignal<ReturnType<
    typeof setInterval
  > | null>(null);

  // Step 6: Intern review state
  const [isRunningIntern, setIsRunningIntern] = createSignal(false);
  const [internMessages, setInternMessages] = createSignal<
    MessageWithDecision[]
  >([]);
  const [internStats, setInternStats] = createSignal<{
    toProcess: number;
    toSkip: number;
    overridden: number;
  } | null>(null);
  const [internFilter, setInternFilter] = createSignal<
    'all' | 'process' | 'skip'
  >('all');
  const [isSubmittingScribe, setIsSubmittingScribe] = createSignal(false);

  // Sync auth token
  createEffect(() => {
    const token = auth.getToken();
    if (token) {
      client.setAuthToken(token);
    }
  });

  // Cleanup polling on unmount
  onCleanup(() => {
    const interval = pollInterval();
    if (interval) {
      clearInterval(interval);
    }
  });

  // Initialize participants when parse result changes.
  // Use untrack on familyTimezone so changing the timezone in step 2
  // doesn't reset participant edits made in step 3.
  createEffect(() => {
    const result = parseResult();
    if (result) {
      const tz = untrack(familyTimezone);
      setParticipants(
        result.participants.map((p) => ({
          rawName: p.rawName,
          displayName: p.suggestedDisplayName,
          timezone: tz,
          role: 'member' as const,
        })),
      );

      // Set default language to most detected
      if (result.detectedLanguages.length > 0) {
        setDefaultLanguage(result.detectedLanguages[0]);
      }
    }
  });

  // Calculate cost estimate when entering step 4
  createEffect(() => {
    if (step() === 4) {
      const result = parseResult();
      if (result) {
        try {
          setCostEstimate(estimateImportCost(result.messages));
        } catch (err) {
          console.error('Failed to estimate cost:', err);
        }
      }
    }
  });

  // File handling
  const handleFileSelect = async (selectedFile: File) => {
    if (!selectedFile.name.endsWith('.txt')) {
      setError('Please select a .txt file');
      return;
    }

    setFile(selectedFile);
    setError(null);
    setIsParsing(true);

    try {
      const content = await selectedFile.text();
      const result = parseWhatsAppExport(content);

      if (result.messages.length === 0) {
        setError('No messages found in file. Please check the file format.');
        setParseResult(null);
      } else {
        setParseResult(result);
      }
    } catch (err) {
      setError(
        `Failed to parse file: ${err instanceof Error ? err.message : 'Unknown error'}`,
      );
      setParseResult(null);
    } finally {
      setIsParsing(false);
    }
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const droppedFile = e.dataTransfer?.files[0];
    if (droppedFile) {
      handleFileSelect(droppedFile);
    }
  };

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleFileInput = (e: Event) => {
    const input = e.target as HTMLInputElement;
    const selectedFile = input.files?.[0];
    if (selectedFile) {
      handleFileSelect(selectedFile);
    }
  };

  // Participant table actions
  const updateParticipant = (
    index: number,
    updates: Partial<ParticipantConfig>,
  ) => {
    setParticipants((prev) =>
      prev.map((p, i) => (i === index ? { ...p, ...updates } : p)),
    );
  };

  const setAllTimezones = () => {
    setParticipants((prev) =>
      prev.map((p) => ({ ...p, timezone: familyTimezone() })),
    );
  };

  const clearAllAdmins = () => {
    setParticipants((prev) =>
      prev.map((p) => ({ ...p, role: 'member' as const })),
    );
  };

  // Navigation
  const canProceed = (): boolean => {
    switch (step()) {
      case 1:
        return parseResult() !== null;
      case 2:
        return familyName().trim().length > 0;
      case 3:
        return participants().length > 0;
      case 4:
        return true;
      case 5:
        return false; // Can't proceed from final step
      default:
        return false;
    }
  };

  const goNext = () => {
    if (canProceed() && step() < 5) {
      setStep((prev) => (prev + 1) as WizardStep);
      setError(null);
    }
  };

  const goBack = () => {
    if (step() > 1) {
      setStep((prev) => (prev - 1) as WizardStep);
      setError(null);
    }
  };

  const handleBack = () => {
    navigate('/select-family');
  };

  // Navigate to existing family
  const viewExistingFamily = () => {
    const result = duplicateResult();
    if (result?.existingFamilyId) {
      navigate(`/family/${result.existingFamilyId}`);
    }
  };

  // Clear duplicate warning and allow retry
  const clearDuplicateWarning = () => {
    setDuplicateResult(null);
  };

  // Import handling
  const startImport = async () => {
    const result = parseResult();
    const f = file();
    if (!result || !f) return;

    // Check for duplicates first
    setIsCheckingDuplicates(true);
    setError(null);

    try {
      const fingerprints = result.messages.map((msg) => ({
        occurredAt: msg.occurredAt.toISOString(),
        actorRawName: msg.actorRawName,
        contentPrefix: msg.content.slice(0, 100),
      }));

      const checkResult = await client.checkDuplicates(
        'whatsapp',
        fingerprints,
      );

      // If >50% duplicates and we have a family to redirect to, show blocking UI
      if (checkResult && checkResult.alreadyExist > 0) {
        const percentage =
          (checkResult.alreadyExist / checkResult.totalMessages) * 100;

        if (percentage > 50 && checkResult.existingFamilyId) {
          // Block and show duplicate warning UI
          setDuplicateResult(checkResult);
          setIsCheckingDuplicates(false);
          return;
        }
      }
    } catch (err) {
      console.error('Failed to check duplicates:', err);
      // Continue with import if duplicate check fails
    } finally {
      setIsCheckingDuplicates(false);
    }

    // Show confirmation dialog
    const confirmed = await modal.confirm({
      title: 'Start Import',
      message: (
        <div>
          <p>
            This will create the family <strong>"{familyName()}"</strong> and
            import <strong>{result.messages.length.toLocaleString()}</strong>{' '}
            messages.
          </p>
          <p
            style={{
              color: '#7f8c8d',
              'font-size': '0.9rem',
              'margin-top': '0.5rem',
            }}
          >
            This process may take a few minutes.
          </p>
        </div>
      ),
      confirmText: 'Start Import',
      cancelText: 'Cancel',
      variant: 'success',
    });

    if (!confirmed) return;

    // Proceed with import
    proceedWithImport();
  };

  // Actually start the import after checks pass
  const proceedWithImport = async () => {
    const result = parseResult();
    const f = file();
    if (!result || !f) return;

    setIsImporting(true);
    setError(null);
    setDuplicateResult(null);
    toast.info('Starting import...');

    const config: ImportConfig = {
      family: {
        name: familyName(),
        defaultLanguage: defaultLanguage(),
        timezone: familyTimezone(),
      },
      participants: participants(),
    };

    try {
      const response = await client.startWhatsAppImport(f, config);

      setImportStatus({
        jobId: response.jobId,
        status: 'pending',
        progress: { current: 0, total: result.messages.length, percentage: 0 },
        stage: 'Starting import...',
        startedAt: new Date(),
      });

      setStep(5);

      // Start polling for status
      const interval = setInterval(async () => {
        try {
          const status = await client.getImportStatus(response.jobId);
          setImportStatus(status);

          if (
            status.status === 'awaiting_intern' ||
            status.status === 'intern_complete'
          ) {
            // Messages imported, transition to Intern review
            clearInterval(interval);
            setPollInterval(null);
            setIsImporting(false);
            setStep(6);
          } else if (
            status.status === 'complete' ||
            status.status === 'failed' ||
            status.status === 'cancelled'
          ) {
            clearInterval(interval);
            setPollInterval(null);
            setIsImporting(false);

            if (status.status === 'failed') {
              toast.error(status.error || 'Import failed');
            }
          }
        } catch (err) {
          console.error('Failed to get import status:', err);
        }
      }, 2000);

      setPollInterval(interval);
    } catch (err) {
      toast.error(
        `Failed to start import: ${err instanceof Error ? err.message : 'Unknown error'}`,
      );
      setIsImporting(false);
    }
  };

  const cancelImport = async () => {
    const status = importStatus();
    if (!status) return;

    const confirmed = await modal.confirm({
      title: 'Cancel Import',
      message:
        'Are you sure you want to cancel this import? Any progress will be lost.',
      confirmText: 'Yes, Cancel',
      cancelText: 'Keep Going',
      variant: 'danger',
    });

    if (!confirmed) return;

    try {
      await client.cancelImport(status.jobId);
      const interval = pollInterval();
      if (interval) {
        clearInterval(interval);
        setPollInterval(null);
      }
      setIsImporting(false);
      setImportStatus((prev) =>
        prev ? { ...prev, status: 'cancelled' } : null,
      );
      toast.warning('Import cancelled');
    } catch (err) {
      toast.error(
        `Failed to cancel import: ${err instanceof Error ? err.message : 'Unknown error'}`,
      );
    }
  };

  const viewFamily = () => {
    const status = importStatus();
    if (status?.familyId) {
      navigate(`/family/${status.familyId}`);
    }
  };

  // Intern review functions
  const runInternAnalysis = async () => {
    const status = importStatus();
    if (!status) return;

    setIsRunningIntern(true);

    try {
      const result = await client.runIntern(status.jobId);
      setInternStats(result.stats);

      // Load the decisions
      await loadInternDecisions();
      toast.success('Intern analysis complete');
    } catch (err) {
      toast.error(
        `Failed to run Intern: ${err instanceof Error ? err.message : 'Unknown error'}`,
      );
    } finally {
      setIsRunningIntern(false);
    }
  };

  const loadInternDecisions = async () => {
    const status = importStatus();
    if (!status) return;

    try {
      const result = await client.getInternDecisions(
        status.jobId,
        internFilter(),
      );
      setInternMessages(result.messages);
      setInternStats(result.stats);
    } catch (err) {
      console.error('Failed to load decisions:', err);
    }
  };

  const toggleDecision = async (
    eventId: string,
    currentDecision: 'process' | 'skip',
  ) => {
    const status = importStatus();
    if (!status) return;

    const newDecision = currentDecision === 'process' ? 'skip' : 'process';

    try {
      const result = await client.overrideInternDecision(
        status.jobId,
        eventId,
        newDecision,
      );
      setInternStats(result.stats);

      // Update local state
      setInternMessages((prev) =>
        prev.map((m) =>
          m.id === eventId
            ? { ...m, decision: newDecision, overridden: true }
            : m,
        ),
      );
    } catch (err) {
      toast.error(
        `Failed to update decision: ${err instanceof Error ? err.message : 'Unknown error'}`,
      );
    }
  };

  const submitToScribe = async () => {
    const status = importStatus();
    if (!status) return;

    setIsSubmittingScribe(true);

    try {
      await client.submitToScribe(status.jobId);
      toast.success('Queued messages for Scribe processing');
      // Refresh status
      const newStatus = await client.getImportStatus(status.jobId);
      setImportStatus(newStatus);
    } catch (err) {
      toast.error(
        `Failed to submit to Scribe: ${err instanceof Error ? err.message : 'Unknown error'}`,
      );
    } finally {
      setIsSubmittingScribe(false);
    }
  };

  // Filter messages for display
  const getFilteredMessages = () => {
    const filter = internFilter();
    const messages = internMessages();

    if (filter === 'all') return messages;
    return messages.filter((m) => m.decision === filter);
  };

  // Render helpers
  const getPreviewMessages = (): ParsedMessage[] => {
    const result = parseResult();
    if (!result) return [];

    if (showAllMessages() || result.messages.length <= 10) {
      return result.messages;
    }

    // Show first 5 and last 5
    const first5 = result.messages.slice(0, 5);
    const last5 = result.messages.slice(-5);
    return [...first5, ...last5];
  };

  const formatDate = (date: Date): string => {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(date);
  };

  const getProgressStages = () => [
    { key: 'creating_family', label: 'Creating family...' },
    { key: 'creating_identities', label: 'Creating identities...' },
    { key: 'submitting', label: 'Inserting messages...' },
    { key: 'awaiting_intern', label: 'Ready for review!' },
  ];

  const getStageStatus = (
    stageKey: string,
  ): 'pending' | 'active' | 'complete' | 'error' => {
    const status = importStatus();
    if (!status) return 'pending';

    const stages = getProgressStages();
    const currentIndex = stages.findIndex((s) => s.key === status.status);
    const stageIndex = stages.findIndex((s) => s.key === stageKey);

    if (status.status === 'failed') {
      if (stageIndex <= currentIndex) return 'error';
      return 'pending';
    }

    if (stageIndex < currentIndex) return 'complete';
    if (stageIndex === currentIndex) return 'active';
    return 'pending';
  };

  return (
    <div class="import-page">
      <div class="import-container">
        <header class="import-header">
          <button class="back-btn" onClick={handleBack}>
            &larr; Back
          </button>
          <h1>Import WhatsApp Chat</h1>
          <p>Import a WhatsApp chat export to create a new family</p>
        </header>

        {/* Step Indicator */}
        <div class="step-indicator">
          <For each={STEP_LABELS}>
            {(label, index) => (
              <>
                <div
                  class="step-item"
                  classList={{
                    active: step() === index() + 1,
                    completed: step() > index() + 1,
                  }}
                >
                  <span class="step-number">{index() + 1}</span>
                  <span class="step-label">{label}</span>
                </div>
                <Show when={index() < STEP_LABELS.length - 1}>
                  <div
                    class="step-connector"
                    classList={{ completed: step() > index() + 1 }}
                  />
                </Show>
              </>
            )}
          </For>
        </div>

        <main class="import-main">
          <Show when={error()}>
            <div class="error-message">{error()}</div>
          </Show>

          {/* Step 1: Upload */}
          <Show when={step() === 1}>
            <section class="step-section">
              <h2>Upload WhatsApp Export</h2>

              <div
                class="upload-zone"
                classList={{
                  dragging: isDragging(),
                  'has-file': file() !== null,
                }}
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onClick={() => document.getElementById('file-input')?.click()}
              >
                <input
                  type="file"
                  id="file-input"
                  accept=".txt"
                  style="display: none"
                  onChange={handleFileInput}
                />

                <Show when={!file()}>
                  <div class="upload-icon">📁</div>
                  <p>Drag and drop your WhatsApp export (.txt) here</p>
                  <p>or click to browse</p>
                </Show>

                <Show when={file()}>
                  {(f) => (
                    <>
                      <div class="upload-icon">✅</div>
                      <p class="file-name">{f().name}</p>
                      <p>{(f().size / 1024 / 1024).toFixed(2)} MB</p>
                    </>
                  )}
                </Show>

                <Show when={file() && file()!.size > 10 * 1024 * 1024}>
                  <div class="size-warning">
                    ⚠️ Large file detected. Parsing may take a moment.
                  </div>
                </Show>
              </div>

              <Show when={isParsing()}>
                <div class="parse-stats">
                  <h3>Parsing...</h3>
                  <div class="loading-spinner" />
                </div>
              </Show>

              <Show when={parseResult()}>
                <div class="parse-stats">
                  <h3>Parse Results</h3>
                  <div class="stats-grid">
                    <div class="stat-item">
                      <div class="stat-value">
                        {parseResult()!.stats.messageCount.toLocaleString()}
                      </div>
                      <div class="stat-label">Messages</div>
                    </div>
                    <div class="stat-item">
                      <div class="stat-value">
                        {parseResult()!.stats.mediaCount.toLocaleString()}
                      </div>
                      <div class="stat-label">Media</div>
                    </div>
                    <div class="stat-item">
                      <div class="stat-value">
                        {parseResult()!.stats.participantCount}
                      </div>
                      <div class="stat-label">Participants</div>
                    </div>
                    <div class="stat-item">
                      <div class="stat-value">
                        {new Date(
                          parseResult()!.stats.dateRange.start,
                        ).toLocaleDateString()}
                        <br />
                        to
                        <br />
                        {new Date(
                          parseResult()!.stats.dateRange.end,
                        ).toLocaleDateString()}
                      </div>
                      <div class="stat-label">Date Range</div>
                    </div>
                  </div>
                </div>
              </Show>
            </section>
          </Show>

          {/* Step 2: Family Config */}
          <Show when={step() === 2}>
            <section class="step-section">
              <h2>Family Configuration</h2>

              <div class="form-group">
                <label for="family-name">Family Name *</label>
                <input
                  type="text"
                  id="family-name"
                  placeholder="e.g., Rodriguez Family"
                  value={familyName()}
                  onInput={(e) => setFamilyName(e.currentTarget.value)}
                />
                <div class="form-hint">
                  This will be the name of the family space in Sobremesa
                </div>
              </div>

              <div class="form-row">
                <div class="form-group">
                  <label for="default-language">Default Language</label>
                  <select
                    id="default-language"
                    value={defaultLanguage()}
                    onChange={(e) =>
                      setDefaultLanguage(e.currentTarget.value as LanguageCode)
                    }
                  >
                    <For each={LANGUAGE_OPTIONS}>
                      {(opt) => <option value={opt.value}>{opt.label}</option>}
                    </For>
                  </select>
                  <div class="form-hint">
                    Detected:{' '}
                    {parseResult()?.detectedLanguages.join(', ') || 'N/A'}
                  </div>
                </div>

                <div class="form-group">
                  <label for="family-timezone">Timezone</label>
                  <select
                    id="family-timezone"
                    value={familyTimezone()}
                    onChange={(e) => setFamilyTimezone(e.currentTarget.value)}
                  >
                    <For each={TIMEZONE_OPTIONS}>
                      {(tz) => <option value={tz}>{tz}</option>}
                    </For>
                  </select>
                  <div class="form-hint">
                    Used for parsing message timestamps
                  </div>
                </div>
              </div>
            </section>
          </Show>

          {/* Step 3: Participant Config */}
          <Show when={step() === 3}>
            <section class="step-section">
              <h2>Participant Configuration</h2>

              <div class="bulk-actions">
                <button onClick={setAllTimezones}>
                  Set all to family timezone
                </button>
                <button onClick={clearAllAdmins}>Clear all admin roles</button>
              </div>

              <div class="participant-table-wrapper">
                <table class="participant-table">
                  <thead>
                    <tr>
                      <th>Raw Name</th>
                      <th>Display Name</th>
                      <th>Timezone</th>
                      <th>Admin</th>
                      <th>Messages</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={participants()}>
                      {(participant, index) => (
                        <tr>
                          <td>
                            <span class="raw-name">{participant.rawName}</span>
                          </td>
                          <td>
                            <input
                              type="text"
                              value={participant.displayName}
                              onInput={(e) =>
                                updateParticipant(index(), {
                                  displayName: e.currentTarget.value,
                                })
                              }
                            />
                          </td>
                          <td>
                            <select
                              value={participant.timezone}
                              onChange={(e) =>
                                updateParticipant(index(), {
                                  timezone: e.currentTarget.value,
                                })
                              }
                            >
                              <For each={TIMEZONE_OPTIONS}>
                                {(tz) => <option value={tz}>{tz}</option>}
                              </For>
                            </select>
                          </td>
                          <td>
                            <input
                              type="checkbox"
                              checked={participant.role === 'admin'}
                              onChange={(e) =>
                                updateParticipant(index(), {
                                  role: e.currentTarget.checked
                                    ? 'admin'
                                    : 'member',
                                })
                              }
                            />
                          </td>
                          <td>
                            <span class="message-count">
                              {parseResult()?.participants.find(
                                (p) => p.rawName === participant.rawName,
                              )?.messageCount || 0}
                            </span>
                          </td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
            </section>
          </Show>

          {/* Step 4: Preview & Cost */}
          <Show when={step() === 4}>
            <section class="step-section">
              <h2>Preview & Cost Estimate</h2>

              {/* Duplicate Warning */}
              <Show
                when={duplicateResult() && duplicateResult()!.alreadyExist > 0}
              >
                <div class="duplicate-warning">
                  <div class="duplicate-warning-icon">⚠️</div>
                  <div class="duplicate-warning-content">
                    <h3>These messages already exist</h3>
                    <p>
                      {duplicateResult()!.alreadyExist.toLocaleString()} of{' '}
                      {duplicateResult()!.totalMessages.toLocaleString()}{' '}
                      messages (
                      {Math.round(
                        (duplicateResult()!.alreadyExist /
                          duplicateResult()!.totalMessages) *
                          100,
                      )}
                      %) already exist
                      {duplicateResult()!.existingFamilyName && (
                        <>
                          {' '}
                          in{' '}
                          <strong>
                            "{duplicateResult()!.existingFamilyName}"
                          </strong>
                        </>
                      )}
                      .
                    </p>
                    <div class="duplicate-warning-actions">
                      <button
                        class="btn-view-family"
                        onClick={viewExistingFamily}
                        disabled={!duplicateResult()!.existingFamilyId}
                      >
                        View Existing Family
                      </button>
                      <button
                        class="btn-secondary"
                        onClick={clearDuplicateWarning}
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                </div>
              </Show>

              {/* Checking duplicates loading state */}
              <Show when={isCheckingDuplicates()}>
                <div class="checking-duplicates">
                  <div class="loading-spinner" />
                  <span>Checking for existing messages...</span>
                </div>
              </Show>

              <Show when={costEstimate()}>
                <pre class="cost-estimate">
                  {formatCostEstimate(costEstimate()!)}
                </pre>
              </Show>

              <div class="message-preview">
                <h3>Message Preview</h3>
                <div class="preview-messages">
                  <For each={getPreviewMessages()}>
                    {(msg, index) => (
                      <>
                        <Show when={!showAllMessages() && index() === 5}>
                          <div class="preview-divider">
                            ... {parseResult()!.messages.length - 10} more
                            messages ...
                          </div>
                        </Show>
                        <div class="preview-message">
                          <div class="preview-header">
                            <span class="preview-sender">
                              {msg.actorDisplayName}
                            </span>
                            <span class="preview-time">
                              {formatDate(msg.occurredAt)}
                            </span>
                          </div>
                          <div class="preview-content">
                            {msg.eventType === 'message'
                              ? msg.content
                              : `[${msg.eventType}]`}
                          </div>
                        </div>
                      </>
                    )}
                  </For>
                </div>

                <Show
                  when={
                    !showAllMessages() && parseResult()!.messages.length > 10
                  }
                >
                  <button
                    class="preview-expand-btn"
                    onClick={() => setShowAllMessages(true)}
                  >
                    Show all {parseResult()!.messages.length} messages
                  </button>
                </Show>
              </div>
            </section>
          </Show>

          {/* Step 5: Import Progress */}
          <Show when={step() === 5}>
            <section class="step-section">
              <h2>Importing Messages...</h2>

              <div class="progress-section">
                <div class="progress-bar-container">
                  <div class="progress-bar">
                    <div
                      class="progress-fill"
                      style={{
                        width: `${importStatus()?.progress.percentage || 0}%`,
                      }}
                    />
                  </div>
                  <div class="progress-text">
                    <span>
                      {importStatus()?.progress.current.toLocaleString() || 0} /{' '}
                      {importStatus()?.progress.total.toLocaleString() || 0}
                    </span>
                    <span>{importStatus()?.progress.percentage || 0}%</span>
                  </div>
                </div>

                <div class="progress-stages">
                  <For each={getProgressStages()}>
                    {(stage) => (
                      <div
                        class="progress-stage"
                        classList={{
                          active: getStageStatus(stage.key) === 'active',
                          complete: getStageStatus(stage.key) === 'complete',
                          error: getStageStatus(stage.key) === 'error',
                        }}
                      >
                        <div class="stage-icon">
                          <Show when={getStageStatus(stage.key) === 'complete'}>
                            ✓
                          </Show>
                          <Show when={getStageStatus(stage.key) === 'active'}>
                            ⏳
                          </Show>
                          <Show when={getStageStatus(stage.key) === 'error'}>
                            ✕
                          </Show>
                          <Show when={getStageStatus(stage.key) === 'pending'}>
                            ○
                          </Show>
                        </div>
                        <span class="stage-label">{stage.label}</span>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </section>
          </Show>

          {/* Step 6: Intern Review */}
          <Show when={step() === 6}>
            <section class="step-section intern-review-section">
              <Show when={importStatus()?.status === 'complete'}>
                <div class="complete-section">
                  <div class="complete-icon">✓</div>
                  <h2>Import Complete!</h2>
                  <p>Messages are queued for processing in {familyName()}.</p>
                  <button class="btn-view-family" onClick={viewFamily}>
                    View Family
                  </button>
                </div>
              </Show>

              <Show when={importStatus()?.status !== 'complete'}>
                <div class="intern-header">
                  <h2>Review Messages</h2>
                  <Show when={!internStats()}>
                    <p>
                      Run the Intern to classify which messages should be
                      processed by Scribe.
                    </p>
                    <button
                      class="btn-run-intern"
                      onClick={runInternAnalysis}
                      disabled={isRunningIntern()}
                    >
                      {isRunningIntern()
                        ? 'Running Intern...'
                        : 'Run Intern Analysis'}
                    </button>
                  </Show>
                </div>

                <Show when={internStats()}>
                  <div class="intern-stats">
                    <div class="stat-chip process">
                      {internStats()!.toProcess} to process
                    </div>
                    <div class="stat-chip skip">
                      {internStats()!.toSkip} to skip
                    </div>
                    <Show when={internStats()!.overridden > 0}>
                      <div class="stat-chip overridden">
                        {internStats()!.overridden} overridden
                      </div>
                    </Show>
                  </div>

                  <div class="intern-filter-tabs">
                    <button
                      classList={{ active: internFilter() === 'all' }}
                      onClick={() => {
                        setInternFilter('all');
                        loadInternDecisions();
                      }}
                    >
                      All ({internStats()!.toProcess + internStats()!.toSkip})
                    </button>
                    <button
                      classList={{ active: internFilter() === 'process' }}
                      onClick={() => {
                        setInternFilter('process');
                        loadInternDecisions();
                      }}
                    >
                      Process ({internStats()!.toProcess})
                    </button>
                    <button
                      classList={{ active: internFilter() === 'skip' }}
                      onClick={() => {
                        setInternFilter('skip');
                        loadInternDecisions();
                      }}
                    >
                      Skip ({internStats()!.toSkip})
                    </button>
                  </div>

                  <div class="intern-messages-list">
                    <For each={getFilteredMessages()}>
                      {(msg) => (
                        <div
                          class="intern-message"
                          classList={{
                            'decision-process': msg.decision === 'process',
                            'decision-skip': msg.decision === 'skip',
                            overridden: msg.overridden,
                          }}
                        >
                          <div class="message-checkbox">
                            <input
                              type="checkbox"
                              checked={msg.decision === 'process'}
                              onChange={() =>
                                toggleDecision(msg.id, msg.decision)
                              }
                            />
                          </div>
                          <div class="message-content">
                            <div class="message-header">
                              <span class="message-sender">
                                {msg.actorDisplayName}
                              </span>
                              <span class="message-time">
                                {formatDate(new Date(msg.occurredAt))}
                              </span>
                            </div>
                            <div class="message-text">
                              {msg.eventType === 'message'
                                ? msg.content
                                : `[${msg.eventType}]`}
                            </div>
                            <div class="message-decision">
                              <span
                                class="decision-badge"
                                classList={{
                                  process: msg.decision === 'process',
                                  skip: msg.decision === 'skip',
                                }}
                              >
                                {msg.decision === 'process'
                                  ? '✓ Process'
                                  : '○ Skip'}
                              </span>
                              <Show when={msg.reason}>
                                <span class="decision-reason">
                                  ({msg.reason})
                                </span>
                              </Show>
                              <Show when={msg.overridden}>
                                <span class="override-badge">Overridden</span>
                              </Show>
                            </div>
                          </div>
                        </div>
                      )}
                    </For>
                  </div>

                  <div class="intern-cost-estimate">
                    <Show when={costEstimate()}>
                      <div class="revised-estimate">
                        <strong>Revised Estimate:</strong>{' '}
                        {internStats()!.toProcess} messages to process
                        <br />
                        <span class="cost-value">
                          ~$
                          {(
                            (costEstimate()!.totalCost *
                              internStats()!.toProcess) /
                            parseResult()!.messages.length
                          ).toFixed(2)}
                        </span>
                        <span class="cost-savings">
                          (saving $
                          {(
                            (costEstimate()!.totalCost *
                              internStats()!.toSkip) /
                            parseResult()!.messages.length
                          ).toFixed(2)}{' '}
                          by skipping {internStats()!.toSkip} messages)
                        </span>
                      </div>
                    </Show>
                  </div>

                  <div class="intern-actions">
                    <button
                      class="btn-cancel"
                      onClick={cancelImport}
                      disabled={isSubmittingScribe()}
                    >
                      Cancel Import
                    </button>
                    <button
                      class="btn-submit-scribe"
                      onClick={submitToScribe}
                      disabled={
                        isSubmittingScribe() || internStats()!.toProcess === 0
                      }
                    >
                      {isSubmittingScribe()
                        ? 'Submitting...'
                        : `Submit ${internStats()!.toProcess} Messages to Scribe`}
                    </button>
                  </div>
                </Show>
              </Show>
            </section>
          </Show>

          {/* Navigation for steps 1-4 */}
          <Show when={step() < 5}>
            <div class="step-navigation">
              <button
                class="btn-prev"
                onClick={goBack}
                disabled={step() === 1 || isImporting()}
              >
                Back
              </button>

              <Show when={step() < 4}>
                <button
                  class="btn-next"
                  onClick={goNext}
                  disabled={!canProceed()}
                >
                  Next
                </button>
              </Show>

              <Show when={step() === 4}>
                <button
                  class="btn-import"
                  onClick={startImport}
                  disabled={isImporting()}
                >
                  {isImporting() ? 'Starting...' : 'Start Import'}
                </button>
              </Show>
            </div>
          </Show>

          {/* Cancel button during import */}
          <Show when={step() === 5 && isImporting()}>
            <div class="step-navigation">
              <button class="btn-cancel" onClick={cancelImport}>
                Cancel Import
              </button>
              <div />
            </div>
          </Show>
        </main>
      </div>
    </div>
  );
};
