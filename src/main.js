const ide = location.pathname.startsWith('/p/');
document.body.className = ide ? 'ide' : 'landing';
ide ? import('./ide.js') : import('./landing.js');
