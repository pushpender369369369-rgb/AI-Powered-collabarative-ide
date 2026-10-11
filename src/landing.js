const btn = document.getElementById('create');
btn.onclick = async () => {
  btn.disabled = true;
  btn.textContent = 'Creating...';
  try {
    const r = await fetch('/api/projects', { method: 'POST' });
    const text = await r.text();
    let data = {};
    try { data = JSON.parse(text); } catch {}
    if (!r.ok || !data.token) {
      throw new Error(data.error || `Server returned ${r.status}. Is the backend (server.js) running?`);
    }
    location.href = `/p/${data.token}`;
  } catch (e) {
    alert('Could not create project: ' + e.message);
    btn.disabled = false;
    btn.textContent = 'Create project';
  }
};
