const btn = document.getElementById('create');
btn.onclick = async () => {
  btn.disabled = true;
  const r = await fetch('/api/projects', { method: 'POST' });
  if (!r.ok) { btn.disabled = false; return alert((await r.json()).error || 'Could not create project'); }
  location.href = `/p/${(await r.json()).token}`;
};
