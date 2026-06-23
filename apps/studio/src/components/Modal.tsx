/**
 * Modal / Confirmation Dialog System
 *
 * Provides a context and components for showing modals and confirmation dialogs.
 * Usage:
 *   const modal = useModal();
 *
 *   // Simple confirmation
 *   const confirmed = await modal.confirm({
 *     title: 'Delete item?',
 *     message: 'This action cannot be undone.',
 *     confirmText: 'Delete',
 *     cancelText: 'Cancel',
 *     variant: 'danger'
 *   });
 *
 *   // Custom modal
 *   modal.show({
 *     title: 'Settings',
 *     content: <SettingsForm onClose={() => modal.close()} />
 *   });
 */

import {
  createContext,
  useContext,
  createSignal,
  type ParentComponent,
  type JSX,
  Show,
  onCleanup,
  createEffect,
} from 'solid-js';
import './Modal.css';

export type ModalVariant = 'default' | 'danger' | 'warning' | 'success';

export interface ConfirmOptions {
  title: string;
  message: string | JSX.Element;
  confirmText?: string;
  cancelText?: string;
  variant?: ModalVariant;
}

export interface ModalOptions {
  title?: string;
  content: JSX.Element;
  showClose?: boolean;
  onClose?: () => void;
}

interface ModalState {
  isOpen: boolean;
  title?: string;
  content?: JSX.Element;
  showClose?: boolean;
  onClose?: () => void;
}

export interface ModalContextValue {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  show: (options: ModalOptions) => void;
  close: () => void;
}

const ModalContext = createContext<ModalContextValue>();

export const ModalProvider: ParentComponent = (props) => {
  const [state, setState] = createSignal<ModalState>({ isOpen: false });
  let resolveConfirm: ((value: boolean) => void) | null = null;

  // Handle escape key
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && state().isOpen) {
      handleClose();
    }
  };

  createEffect(() => {
    if (state().isOpen) {
      document.addEventListener('keydown', handleKeyDown);
      document.body.style.overflow = 'hidden';
    } else {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
    }
  });

  onCleanup(() => {
    document.removeEventListener('keydown', handleKeyDown);
    document.body.style.overflow = '';
  });

  const handleClose = () => {
    if (resolveConfirm) {
      resolveConfirm(false);
      resolveConfirm = null;
    }
    state().onClose?.();
    setState({ isOpen: false });
  };

  const confirm = (options: ConfirmOptions): Promise<boolean> => {
    return new Promise((resolve) => {
      resolveConfirm = resolve;

      const handleConfirm = () => {
        resolve(true);
        resolveConfirm = null;
        setState({ isOpen: false });
      };

      const handleCancel = () => {
        resolve(false);
        resolveConfirm = null;
        setState({ isOpen: false });
      };

      const content = (
        <div class="modal-confirm">
          <div class="modal-confirm-message">
            {typeof options.message === 'string' ? (
              <p>{options.message}</p>
            ) : (
              options.message
            )}
          </div>
          <div class="modal-confirm-actions">
            <button
              class="modal-btn modal-btn-secondary"
              onClick={handleCancel}
            >
              {options.cancelText || 'Cancel'}
            </button>
            <button
              class={`modal-btn modal-btn-${options.variant || 'default'}`}
              onClick={handleConfirm}
            >
              {options.confirmText || 'Confirm'}
            </button>
          </div>
        </div>
      );

      setState({
        isOpen: true,
        title: options.title,
        content,
        showClose: false,
      });
    });
  };

  const show = (options: ModalOptions) => {
    setState({
      isOpen: true,
      title: options.title,
      content: options.content,
      showClose: options.showClose ?? true,
      onClose: options.onClose,
    });
  };

  const close = () => {
    handleClose();
  };

  const value: ModalContextValue = {
    confirm,
    show,
    close,
  };

  return (
    <ModalContext.Provider value={value}>
      {props.children}
      <Show when={state().isOpen}>
        <div class="modal-overlay" onClick={handleClose}>
          <div class="modal-container" onClick={(e) => e.stopPropagation()}>
            <Show when={state().title || state().showClose}>
              <div class="modal-header">
                <Show when={state().title}>
                  <h2 class="modal-title">{state().title}</h2>
                </Show>
                <Show when={state().showClose}>
                  <button class="modal-close" onClick={handleClose}>
                    ×
                  </button>
                </Show>
              </div>
            </Show>
            <div class="modal-body">{state().content}</div>
          </div>
        </div>
      </Show>
    </ModalContext.Provider>
  );
};

export function useModal(): ModalContextValue {
  const context = useContext(ModalContext);
  if (!context) {
    throw new Error('useModal must be used within a ModalProvider');
  }
  return context;
}
