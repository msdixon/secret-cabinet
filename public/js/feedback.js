// #625 — "A note to the keeper of the lodge": a small plain-text note from a
// signed-in guest to Rachel. No ratings, no categories. The page it was
// written from rides along so a note about "this passage" has context.
window.Feedback = (function () {
  let page = '';
  const $ = id => document.getElementById(id);

  function open(from) {
    page = from || '';
    $('keeper-note-status').textContent = '';
    $('keeper-note-send').disabled = false;
    $('keeper-note-overlay').style.display = 'flex';
    $('keeper-note-text').focus();
  }

  function close() {
    $('keeper-note-overlay').style.display = 'none';
  }

  async function send() {
    const text = $('keeper-note-text').value.trim();
    const status = $('keeper-note-status');
    if (!text) {
      status.textContent = 'Write a few words first.';
      return;
    }
    $('keeper-note-send').disabled = true;
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, page }),
      });
      if (res.status === 401) throw new Error('Your sign-in has lapsed. Reload the page to sign in again.');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'The note could not be left just now.');
      $('keeper-note-text').value = '';
      status.textContent = 'Left on the keeper’s desk. Thank you.';
      setTimeout(close, 1400);
    } catch (e) {
      status.textContent = e.message;
      $('keeper-note-send').disabled = false;
    }
  }

  return { open, close, send };
})();
