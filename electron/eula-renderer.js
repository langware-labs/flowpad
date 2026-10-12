// First-launch EULA screen: "I Agree" is enabled only once the box is checked;
// report the user's choice to the main process.
const accept = document.getElementById('accept');
const agree = document.getElementById('agree');
const note = document.getElementById('note');

accept.addEventListener('change', () => {
  agree.disabled = !accept.checked;
  note.style.visibility = accept.checked ? 'hidden' : 'visible';
});
agree.addEventListener('click', () => {
  if (accept.checked) window.electronAPI.eulaDecision(true);
});
document.getElementById('decline').addEventListener('click', () => {
  window.electronAPI.eulaDecision(false);
});
