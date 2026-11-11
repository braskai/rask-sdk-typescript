// Applies an OpenAPI Overlay 1.0 document. It handles the target forms sdk-fallback.yaml uses (dotted names, ['quoted'] names
// and [n] indexes) and fails on anything else, so a new form is noticed rather than skipped.
const TOKEN = /\.([A-Za-z0-9_-]+)|\['([^']+)'\]|\[(\d+)\]/y;

export function parseTarget(target) {
  if (!target.startsWith('$')) throw new Error(`Unsupported overlay target: ${target}`);
  const tokens = [];
  TOKEN.lastIndex = 1;
  while (TOKEN.lastIndex < target.length) {
    const position = TOKEN.lastIndex;
    const match = TOKEN.exec(target);
    if (!match) throw new Error(`Unsupported overlay target: ${target} (at ${position})`);
    tokens.push(match[1] ?? match[2] ?? Number(match[3]));
  }
  return tokens;
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function merge(target, update) {
  for (const [name, value] of Object.entries(update)) {
    if (isObject(value) && isObject(target[name])) merge(target[name], value);
    else target[name] = structuredClone(value);
  }
}

export function applyOverlay(spec, overlay) {
  for (const action of overlay.actions) {
    const tokens = parseTarget(action.target);
    let parent = null;
    let node = spec;
    for (const token of tokens) {
      parent = node;
      node = node?.[token];
    }
    if (node === undefined) throw new Error(`Overlay target not found: ${action.target}`);
    if (action.remove) {
      if (!isObject(parent)) throw new Error(`Overlay cannot remove from: ${action.target}`);
      delete parent[tokens.at(-1)];
    } else if (isObject(action.update)) {
      if (!isObject(node)) throw new Error(`Overlay cannot update: ${action.target}`);
      merge(node, action.update);
    } else {
      throw new Error(`Overlay action does nothing: ${action.target}`);
    }
  }
  return spec;
}
