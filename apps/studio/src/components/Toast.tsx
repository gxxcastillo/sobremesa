/**
 * Toast Notification System
 *
 * Provides a context and components for showing toast notifications.
 * Usage:
 *   const toast = useToast();
 *   toast.success('Item saved!');
 *   toast.error('Something went wrong');
 *   toast.info('Processing...');
 */

import {
  createContext,
  useContext,
  createSignal,
  type ParentComponent,
  For,
  Show,
} from 'solid-js';
import './Toast.css';

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface Toast {
  id: string;
  type: ToastType;
  message: string;
  duration?: number;
}

export interface ToastContextValue {
  success: (message: string, duration?: number) => void;
  error: (message: string, duration?: number) => void;
  info: (message: string, duration?: number) => void;
  warning: (message: string, duration?: number) => void;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue>();

const DEFAULT_DURATION = 4000;

export const ToastProvider: ParentComponent = (props) => {
  const [toasts, setToasts] = createSignal<Toast[]>([]);

  const addToast = (
    type: ToastType,
    message: string,
    duration = DEFAULT_DURATION,
  ) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const toast: Toast = { id, type, message, duration };

    setToasts((prev) => [...prev, toast]);

    // Auto-dismiss after duration
    if (duration > 0) {
      setTimeout(() => {
        dismiss(id);
      }, duration);
    }

    return id;
  };

  const dismiss = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  const value: ToastContextValue = {
    success: (message, duration) => addToast('success', message, duration),
    error: (message, duration) => addToast('error', message, duration ?? 6000),
    info: (message, duration) => addToast('info', message, duration),
    warning: (message, duration) =>
      addToast('warning', message, duration ?? 5000),
    dismiss,
  };

  return (
    <ToastContext.Provider value={value}>
      {props.children}
      <div class="toast-container">
        <For each={toasts()}>
          {(toast) => (
            <div class={`toast toast-${toast.type}`}>
              <div class="toast-icon">
                <Show when={toast.type === 'success'}>✓</Show>
                <Show when={toast.type === 'error'}>✕</Show>
                <Show when={toast.type === 'info'}>ℹ</Show>
                <Show when={toast.type === 'warning'}>⚠</Show>
              </div>
              <div class="toast-message">{toast.message}</div>
              <button class="toast-dismiss" onClick={() => dismiss(toast.id)}>
                ×
              </button>
            </div>
          )}
        </For>
      </div>
    </ToastContext.Provider>
  );
};

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
}
