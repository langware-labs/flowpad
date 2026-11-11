/**
 * `flowpad/no-entity-construct-in-render` — never build an SDK entity while rendering.
 *
 * Constructing an entity (`new Deployment(row)`) registers it in the shared cache and notifies that id's
 * subscribers; done during render it can re-render the component that built it, and the app froze on
 * 2026-10-23 when AgentPlacesColumn did exactly that. Read the wire data instead, or build it once
 * (`useMemo`, `useState(() => new X())`) or off the render path (an effect, an event handler, a loader).
 *
 * Type-aware: `X` is an entity when its instance type extends `APIEntity`, so new entity classes are
 * covered without a list. "During render" = the nearest enclosing component (`PascalCase`) or hook
 * (`useX`) is reached without crossing a boundary that runs later: an async function, a hook callback
 * (`useEffect`, `useCallback`, `useMemo`, …), an `on*` JSX prop, a promise callback, or a function named
 * `on*` / `handle*`.
 */

const DEFERRED_HOOKS = new Set([
  'useEffect', 'useLayoutEffect', 'useInsertionEffect', 'useCallback', 'useMemo', 'useState', 'useReducer', 'useRef',
]);
const PROMISE_METHODS = new Set(['then', 'catch', 'finally']);

const isComponentName = (name) => !!name && /^[A-Z]/.test(name);
const isHookName = (name) => !!name && /^use[A-Z0-9]/.test(name);
const isHandlerName = (name) => !!name && /^(on|handle)[A-Z]/.test(name);

function functionName(fn) {
  if (fn.id && fn.id.name) return fn.id.name;
  const p = fn.parent;
  if (p && p.type === 'VariableDeclarator' && p.id.type === 'Identifier') return p.id.name;
  if (p && (p.type === 'Property' || p.type === 'MethodDefinition') && p.key.type === 'Identifier') return p.key.name;
  // `memo(function X() …)` / `forwardRef((props, ref) => …)` / `observer(...)`: the wrapper's variable.
  if (p && p.type === 'CallExpression' && p.parent && p.parent.type === 'VariableDeclarator' && p.parent.id.type === 'Identifier') {
    return p.parent.id.name;
  }
  return null;
}

function calleeName(call) {
  const c = call.callee;
  if (c.type === 'Identifier') return c.name;
  if (c.type === 'MemberExpression' && c.property.type === 'Identifier') return c.property.name;
  return null;
}

/** The function runs later than the render that defines it. */
function isDeferred(fn) {
  if (fn.async) return true;
  const name = functionName(fn);
  if (isHandlerName(name)) return true;
  const p = fn.parent;
  if (p && p.type === 'CallExpression' && p.arguments.includes(fn)) {
    const callee = calleeName(p);
    if (DEFERRED_HOOKS.has(callee) || PROMISE_METHODS.has(callee) || callee === 'setTimeout' || callee === 'queueMicrotask') return true;
  }
  // `onClick={cond ? () => … : undefined}` / `onClick={a && (() => …)}`: the handler is still the prop's value.
  let v = p;
  while (v && (v.type === 'ConditionalExpression' || v.type === 'LogicalExpression')) v = v.parent;
  if (v && v.type === 'JSXExpressionContainer' && v.parent.type === 'JSXAttribute') {
    const attr = v.parent.name.type === 'JSXIdentifier' ? v.parent.name.name : '';
    if (/^on[A-Z]/.test(attr)) return true;
  }
  return false;
}

function extendsApiEntity(type, seen = new Set()) {
  if (!type || seen.has(type)) return false;
  seen.add(type);
  const symbol = type.getSymbol && type.getSymbol();
  if (symbol && symbol.getName() === 'APIEntity') return true;
  const bases = type.getBaseTypes ? type.getBaseTypes() || [] : [];
  return bases.some((b) => extendsApiEntity(b, seen));
}

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow constructing SDK entities during render (it notifies the cache and can loop the render).' },
    messages: {
      construct:
        '`new {{name}}(...)` during render: building an entity registers it in the shared cache and notifies its subscribers, which can re-render this component forever. Read the wire data, or build it once (useState(() => new X(...))) or in an effect / a handler.',
    },
    schema: [],
  },
  create(context) {
    const services = context.sourceCode.parserServices;
    if (!services || !services.program) return {};
    const checker = services.program.getTypeChecker();
    return {
      NewExpression(node) {
        const tsNode = services.esTreeNodeToTSNodeMap.get(node);
        if (!extendsApiEntity(checker.getTypeAtLocation(tsNode))) return;
        for (let n = node.parent; n; n = n.parent) {
          if (n.type !== 'FunctionDeclaration' && n.type !== 'FunctionExpression' && n.type !== 'ArrowFunctionExpression') continue;
          if (isDeferred(n)) return;
          const name = functionName(n);
          if (isComponentName(name) || isHookName(name)) {
            context.report({ node, messageId: 'construct', data: { name: node.callee.type === 'Identifier' ? node.callee.name : 'entity' } });
            return;
          }
        }
      },
    };
  },
};
