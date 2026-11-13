/* mockify mock tree — the run-time side of scripts/tree.py. Inlined by build_mock.py BEFORE journey-bar.js.
 * It reads the compiled tree (window.MOCKIFY.tree: the screens in DFS order, each with num / depth / parent /
 * via / state) and walks it. It decides nothing: the order was computed and validated at build time. */
(() => {
  const T = (window.MOCKIFY || {}).tree || { root: null, vars: [], screens: [] };
  const S = T.screens || [], at = new Map(S.map((s, i) => [s.id, i]));
  const subs = new Set(), visited = new Set();
  let i = 0;
  const move = (n, how) => {
    if (n < 0 || n >= S.length) return false;
    i = n; visited.add(S[i].id);
    subs.forEach((fn) => fn(mock, how));
    return true;
  };
  const mock = {
    root: T.root, vars: T.vars || [], screens: S,
    get index() { return i; },
    get current() { return S[i] || null; },
    get state() { return { current: S[i] ? S[i].id : null, visited: [...visited], vars: { ...((S[i] || {}).state || {}) } }; },
    get canNext() { return i < S.length - 1; },
    get canBack() { return i > 0; },
    next() { return move(i + 1, 'next'); },          // the next screen in DFS order
    back() { return move(i - 1, 'back'); },          // the previous one
    reset() { visited.clear(); return move(0, 'reset'); },   // the root
    go(id, how = 'go') { return at.has(id) ? move(at.get(id), how) : false; },
    indexOf: (id) => (at.has(id) ? at.get(id) : -1),
    onChange(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
  if (S.length) visited.add(S[0].id);
  window.mock = mock;
})();
