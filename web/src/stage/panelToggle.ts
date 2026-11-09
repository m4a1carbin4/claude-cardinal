/** Adds a corner button (and the H key) that shows / hides every overlay panel at once. */
export function mountPanelToggle(panels: HTMLElement[], onChange?: (visible: boolean) => void): void {
  const button = document.createElement('button');
  button.className = 'panel-toggle';
  button.type = 'button';
  document.body.append(button);

  let visible = true;
  const apply = () => {
    for (const panel of panels) panel.style.display = visible ? '' : 'none';
    button.textContent = visible ? 'Hide panels (H)' : 'Show panels (H)';
    button.setAttribute('aria-pressed', String(!visible));
    onChange?.(visible);
  };
  const toggle = () => {
    visible = !visible;
    apply();
  };

  button.addEventListener('click', toggle);
  document.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() !== 'h' || e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target;
    if (target instanceof Element && target.closest('input, select, textarea, [contenteditable]')) return;
    toggle();
  });
  apply();
}
