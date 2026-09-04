import { type JSX, onMount, onCleanup, Show } from 'solid-js';

export function Modal(props: {
  title?: string;
  onClose: () => void;
  children: JSX.Element;
}) {
  onMount(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    document.body.style.overflow = 'hidden';
    onCleanup(() => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
    });
  });

  return (
    <div class="modal-overlay" onClick={props.onClose}>
      <div class="modal-container" onClick={(e) => e.stopPropagation()}>
        <div class="modal-header">
          <Show when={props.title}>
            <h2 class="modal-title">{props.title}</h2>
          </Show>
          <button type="button" class="modal-close" onClick={props.onClose}>
            ×
          </button>
        </div>
        <div class="modal-body">{props.children}</div>
      </div>
    </div>
  );
}
