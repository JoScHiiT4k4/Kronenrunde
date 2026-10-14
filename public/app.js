// Kleine Helfer für die Oberfläche. Alles funktioniert auch ohne JavaScript.
'use strict';

document.addEventListener('submit', (e) => {
  // Rückfrage vor endgültigen Aktionen (Formular oder auslösender Knopf mit data-confirm)
  const form = e.target;
  const button = e.submitter;
  const text = (button && button.dataset.confirm) || form.dataset.confirm;
  if (text && !window.confirm(text)) {
    e.preventDefault();
    return;
  }
  if (form.classList.contains('tip-form')) form.dataset.submitting = '1';
});

document.addEventListener('click', (e) => {
  const button = e.target.closest('[data-copy]');
  if (!button) return;
  const input = document.getElementById(button.dataset.copy);
  if (!input) return;
  const done = () => {
    const label = button.textContent;
    button.textContent = 'Kopiert';
    setTimeout(() => (button.textContent = label), 1800);
  };
  if (navigator.clipboard) {
    navigator.clipboard.writeText(input.value).then(done, () => {
      input.select();
    });
  } else {
    input.select();
    document.execCommand('copy');
    done();
  }
});

// Ungespeicherte Tipps: Knopf markieren und vor dem Verlassen der Seite warnen
const tipForm = document.querySelector('.tip-form');
if (tipForm) {
  const bar = tipForm.querySelector('.save-bar');
  tipForm.addEventListener('change', () => {
    tipForm.dataset.dirty = '1';
    if (bar) bar.classList.add('dirty');
  });
  window.addEventListener('beforeunload', (e) => {
    if (tipForm.dataset.dirty && !tipForm.dataset.submitting) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}
