/**
 * Telegram Login Button Component
 *
 * Wrapper for Telegram Login Widget that handles authentication
 * and calls back with the auth data.
 */

import { onMount, onCleanup, createSignal, type Component } from 'solid-js';

export interface TelegramLoginData {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
}

interface TelegramLoginButtonProps {
  botName: string;
  onAuth: (data: TelegramLoginData) => void;
  buttonSize?: 'large' | 'medium' | 'small';
  cornerRadius?: number;
  requestAccess?: 'write' | boolean;
}

declare global {
  interface Window {
    TelegramLoginWidget?: {
      dataOnauth: (user: TelegramLoginData) => void;
    };
  }
}

export const TelegramLoginButton: Component<TelegramLoginButtonProps> = (
  props,
) => {
  let containerRef: HTMLDivElement | undefined;
  const [isLoading, setIsLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);

  // Generate unique callback name
  const callbackName = `onTelegramAuth_${Date.now()}`;

  onMount(() => {
    // Set up callback function
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any)[callbackName] = (user: TelegramLoginData) => {
      props.onAuth(user);
    };

    // Create script element for Telegram widget
    const script = document.createElement('script');
    script.src = 'https://telegram.org/js/telegram-widget.js?22';
    script.setAttribute('data-telegram-login', props.botName);
    script.setAttribute('data-size', props.buttonSize || 'large');
    script.setAttribute('data-onauth', `${callbackName}(user)`);
    script.setAttribute(
      'data-request-access',
      String(props.requestAccess ?? 'write'),
    );

    if (props.cornerRadius !== undefined) {
      script.setAttribute('data-radius', String(props.cornerRadius));
    }

    script.async = true;

    script.onload = () => {
      setIsLoading(false);
    };

    script.onerror = () => {
      setError('Failed to load Telegram widget');
      setIsLoading(false);
    };

    if (containerRef) {
      containerRef.appendChild(script);
    }
  });

  onCleanup(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any)[callbackName];
  });

  return (
    <div class="telegram-login-container">
      {isLoading() && (
        <div class="telegram-login-loading">Loading Telegram Login...</div>
      )}
      {error() && <div class="telegram-login-error">{error()}</div>}
      <div ref={containerRef} class="telegram-login-widget" />
    </div>
  );
};
