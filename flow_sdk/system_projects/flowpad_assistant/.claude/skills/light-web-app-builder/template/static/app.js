// The page's behaviour. Each Alpine component is a function that returns its state and
// actions; index.html binds to it with x-data="itemsApp()".

// Calls the app's own API. Relative path ("api/..."), so it works wherever the app is mounted.
async function api(path, options = {}) {
  const response = await fetch(`api/${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.detail || `Request failed (${response.status})`);
  }
  return response.status === 204 ? null : response.json();
}

function itemsApp() {
  return {
    items: [],
    title: '',
    loading: true,
    error: '',

    async load() {
      try {
        this.items = await api('items');
      } catch (e) {
        this.error = e.message;
      } finally {
        this.loading = false;
      }
    },

    async add() {
      this.error = '';
      try {
        const item = await api('items', { method: 'POST', body: { title: this.title } });
        this.items.unshift(item);
        this.title = '';
      } catch (e) {
        this.error = e.message;
      }
    },

    async toggle(item) {
      const updated = await api(`items/${item.id}`, { method: 'PATCH', body: { done: !item.done } });
      Object.assign(item, updated);
    },

    async remove(item) {
      await api(`items/${item.id}`, { method: 'DELETE' });
      this.items = this.items.filter((other) => other.id !== item.id);
    },
  };
}
