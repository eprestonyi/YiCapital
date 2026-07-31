import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

await import('../assets/yc-atlas-visuals.js');

const Atlas = globalThis.YCAtlasVisuals;
const source = await readFile(new URL('../assets/yc-atlas-visuals.js', import.meta.url), 'utf8');
const seed = JSON.parse(
  await readFile(new URL('../assets/data/atlas-seed.json', import.meta.url), 'utf8'),
);

function coordinates(layout) {
  return Object.fromEntries(
    layout.nodes
      .map((node) => [node.id, [Number(node.x.toFixed(4)), Number(node.y.toFixed(4))]])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

test('Atlas visual module is dependency-free, DOM-safe and exposes a stable API', () => {
  assert.equal(Atlas.VERSION, '1.0.0');
  assert.equal(typeof Atlas.createStarfield, 'function');
  assert.equal(typeof Atlas.createHighway, 'function');
  assert.equal(typeof Atlas.layoutStarfield, 'function');
  assert.equal(typeof Atlas.layoutHighway, 'function');
  assert.equal(source.includes('innerHTML'), false);
  assert.equal(source.includes('Math.random'), false);
  assert.equal(source.includes('fetch('), false);
  assert.equal(source.includes('XMLHttpRequest'), false);
  assert.equal(source.includes('WebSocket'), false);
});

test('starfield layout is deterministic and independent of input order', () => {
  const first = Atlas.layoutStarfield(seed, { year: 2025 });
  const reversed = Atlas.layoutStarfield({
    ...seed,
    entities: seed.entities.slice().reverse(),
    relationships: seed.relationships.slice().reverse(),
    layers: seed.layers.slice().reverse(),
  }, { year: 2025 });

  assert.deepEqual(coordinates(first), coordinates(reversed));
  assert.deepEqual(
    first.edges.map((edge) => edge.id),
    reversed.edges.map((edge) => edge.id),
  );
  assert.equal(first.edges.length, 9);
  assert.equal(first.edges.some((edge) =>
    /modelled|taxonomy-only/.test(String(edge.evidenceStatus))), false);
  assert.ok(first.clusters.length > 4);
  assert.equal(first.nodes.length, seed.entities.length);
});

test('company focus returns exactly the published one-hop upstream and downstream graph', () => {
  const result = Atlas.neighborhood(seed, 'nvda', { year: 2025 });

  assert.equal(result.entity.id, 'nvda');
  assert.deepEqual(
    result.upstream.map((item) => item.entity.id).sort(),
    ['fabrinet', 'hon-hai', 'micron', 'samsung', 'sk-hynix', 'tsmc', 'wistron'],
  );
  assert.deepEqual(
    result.downstream.map((item) => item.entity.id).sort(),
    ['cloud-class', 'enterprise-ai-class'],
  );
  assert.equal(result.neighborIds.has('openai'), false);
});

test('highway draws only evidence-backed relationships and does not invent flow amounts', () => {
  const layout = Atlas.layoutHighway(seed, { year: 2025, focusId: 'nvda' });

  assert.equal(layout.edges.length, 9);
  assert.equal(layout.edges.some((edge) => edge.evidenceStatus === 'taxonomy-only'), false);
  assert.equal(layout.edges.some((edge) => edge.evidenceStatus === 'modelled-category-link'), false);
  assert.equal(layout.edges.every((edge) => edge.amount == null && edge.value == null), true);
  assert.equal(layout.rootId, 'nvda');
  assert.ok(layout.edges.every((edge) => edge.path.startsWith('M ')));
  assert.equal(layout.omittedRelationshipCount, 14);
});

test('funds and physical flows remain explicit, separate encodings', () => {
  const graph = {
    layers: [
      { id: 'upstream', order: 0 },
      { id: 'downstream', order: 1 },
    ],
    entities: [
      { id: 'supplier', name: 'Supplier', layer: 'upstream' },
      { id: 'buyer', name: 'Buyer', layer: 'downstream' },
    ],
    relationships: [
      {
        id: 'goods',
        from: 'supplier',
        to: 'buyer',
        type: 'supplier',
        sourceId: 'filing-1',
        validCanonicalYears: [2025],
      },
      {
        id: 'cash',
        from: 'buyer',
        to: 'supplier',
        type: 'payment',
        flowType: 'funds',
        sourceId: 'filing-1',
        validCanonicalYears: [2025],
      },
      {
        id: 'unsupported',
        from: 'supplier',
        to: 'buyer',
        type: 'supplier',
        evidenceStatus: 'modelled-category-link',
        validCanonicalYears: [2025],
      },
      {
        id: 'unscoped',
        from: 'supplier',
        to: 'buyer',
        type: 'supplier',
        sourceId: 'filing-1',
      },
    ],
  };
  const layout = Atlas.layoutHighway(graph, { year: 2025 });
  const kinds = Object.fromEntries(layout.edges.map((edge) => [edge.id, edge.flowKind]));

  assert.deepEqual(kinds, { cash: 'funds', goods: 'material' });
  assert.equal(layout.edges.some((edge) => edge.id === 'unsupported'), false);
  assert.equal(layout.edges.some((edge) => edge.id === 'unscoped'), false);
});

test('relationship-only edges use equal baseline widths and focus—not economic data—adds emphasis', () => {
  const graph = {
    layers: [
      { id: 'upstream', order: 0 },
      { id: 'downstream', order: 1 },
    ],
    entities: [
      { id: 'supplier', name: 'Supplier', layer: 'upstream', industryCluster: 'chips' },
      { id: 'buyer', name: 'Buyer', layer: 'downstream', industryCluster: 'ai' },
      { id: 'supplier-2', name: 'Supplier 2', layer: 'upstream', industryCluster: 'energy' },
      { id: 'buyer-2', name: 'Buyer 2', layer: 'downstream', industryCluster: 'cloud' },
    ],
    relationships: [
      {
        id: 'selected-route',
        from: 'supplier',
        to: 'buyer',
        type: 'supplier',
        sourceId: 'filing-1',
        validCanonicalYears: [2025],
        materialityWeight: 999,
        amountStatus: 'relationship-only',
      },
      {
        id: 'context-route',
        from: 'supplier-2',
        to: 'buyer-2',
        type: 'supplier',
        sourceId: 'filing-2',
        validCanonicalYears: [2025],
        amountStatus: 'relationship-only',
      },
    ],
  };
  const documentRef = new FakeDocument();
  const container = new FakeElement(documentRef, 'div');
  const visual = Atlas.createStarfield(container, graph, { year: 2025, locale: 'cn' });
  const selectedBaseline = findByAttribute(visual.root, 'data-atlas-edge', 'selected-route');
  const contextBaseline = findByAttribute(visual.root, 'data-atlas-edge', 'context-route');

  assert.equal(selectedBaseline.getAttribute('stroke-width'), contextBaseline.getAttribute('stroke-width'));
  assert.equal(selectedBaseline.getAttribute('data-visual-salience'), 'focus-only');
  assert.equal(source.includes('materialityWeight'), false);
  assert.equal(source.includes('不代表交易金额'), true);

  visual.setFocus('buyer');
  const selectedFocused = findByAttribute(visual.root, 'data-atlas-edge', 'selected-route');
  const contextFocused = findByAttribute(visual.root, 'data-atlas-edge', 'context-route');
  assert.ok(Number(selectedFocused.getAttribute('stroke-width')) >
    Number(contextFocused.getAttribute('stroke-width')));
  assert.equal(selectedFocused.getAttribute('data-selection-emphasis'), 'true');
  assert.equal(contextFocused.getAttribute('data-selection-emphasis'), 'false');
  visual.destroy();
});

test('relationship metadata never changes the unfocused width', () => {
  const graph = {
    layers: [
      { id: 'upstream', order: 0 },
      { id: 'downstream', order: 1 },
    ],
    entities: [
      { id: 'a', name: 'A', layer: 'upstream', industryCluster: 'one' },
      { id: 'b', name: 'B', layer: 'downstream', industryCluster: 'two' },
      { id: 'c', name: 'C', layer: 'upstream', industryCluster: 'three' },
      { id: 'd', name: 'D', layer: 'downstream', industryCluster: 'four' },
    ],
    relationships: [
      {
        id: 'explicit-display',
        from: 'a',
        to: 'b',
        sourceId: 'filing-a',
        validCanonicalYears: [2025],
        visualSalience: {
          presentationOnly: true,
          value: 0.9,
          method: 'curated map readability',
          sourceId: 'presentation-policy-1',
        },
      },
      {
        id: 'baseline',
        from: 'c',
        to: 'd',
        sourceId: 'filing-b',
        validCanonicalYears: [2025],
      },
    ],
  };
  const documentRef = new FakeDocument();
  const container = new FakeElement(documentRef, 'div');
  const visual = Atlas.createStarfield(container, graph, { year: 2025 });
  const explicit = findByAttribute(visual.root, 'data-atlas-edge', 'explicit-display');
  const baseline = findByAttribute(visual.root, 'data-atlas-edge', 'baseline');

  assert.equal(explicit.getAttribute('stroke-width'), baseline.getAttribute('stroke-width'));
  assert.equal(explicit.getAttribute('data-visual-salience'), 'focus-only');
  assert.equal(baseline.getAttribute('data-visual-salience'), 'focus-only');
  visual.destroy();
});

class FakeElement {
  constructor(ownerDocument, name, namespaceURI = null) {
    this.ownerDocument = ownerDocument;
    this.nodeName = String(name).toUpperCase();
    this.namespaceURI = namespaceURI;
    this.attributes = new Map();
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.listeners = new Map();
    this.textContent = '';
    this.className = '';
  }

  appendChild(child) {
    if (child == null) return child;
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  append(...children) {
    children.forEach((child) => this.appendChild(child));
  }

  insertBefore(child, before) {
    if (child.parentNode) child.parentNode.removeChild(child);
    const index = this.children.indexOf(before);
    child.parentNode = this;
    if (index < 0) this.children.push(child);
    else this.children.splice(index, 0, child);
    return child;
  }

  replaceChildren(...children) {
    this.children.forEach((child) => { child.parentNode = null; });
    this.children = [];
    this.append(...children);
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) {
      this.children.splice(index, 1);
      child.parentNode = null;
    }
    return child;
  }

  setAttribute(name, value) {
    this.attributes.set(String(name), String(value));
  }

  getAttribute(name) {
    return this.attributes.get(String(name)) ?? null;
  }

  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(listener);
  }

  removeEventListener(name, listener) {
    this.listeners.get(name)?.delete(listener);
  }

  dispatchEvent(event) {
    event.target ||= this;
    for (const listener of this.listeners.get(event.type) || []) listener.call(this, event);
    return true;
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, width: 900, height: 600 };
  }
}

class FakeDocument {
  constructor() {
    const listeners = new Map();
    this.defaultView = {
      addEventListener(name, listener) {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name).add(listener);
      },
      removeEventListener(name, listener) {
        listeners.get(name)?.delete(listener);
      },
      cancelAnimationFrame() {},
    };
  }

  createElement(name) {
    return new FakeElement(this, name);
  }

  createElementNS(namespaceURI, name) {
    return new FakeElement(this, name, namespaceURI);
  }
}

function findByAttribute(root, name, value) {
  if (root.getAttribute?.(name) === value) return root;
  for (const child of root.children || []) {
    const match = findByAttribute(child, name, value);
    if (match) return match;
  }
  return null;
}

test('interactive instance supports external search, click focus, resize and destroy cleanup', () => {
  const documentRef = new FakeDocument();
  const container = new FakeElement(documentRef, 'div');
  let focused = null;
  const visual = Atlas.createStarfield(container, seed, {
    year: 2025,
    locale: 'cn',
    onFocusChange(event) {
      focused = event.focusId;
    },
  });

  assert.equal(container.children.length, 1);
  assert.equal(visual.getState().nodeCount, seed.entities.length);
  visual.setSearchState({ query: 'NVIDIA', matchedIds: ['nvda'] });
  assert.deepEqual(visual.getState().searchIds, ['nvda']);

  const node = findByAttribute(visual.root, 'data-atlas-node', 'nvda');
  assert.ok(node);
  node.dispatchEvent({ type: 'click', preventDefault() {} });
  assert.equal(visual.getState().focusId, 'nvda');
  assert.equal(focused, 'nvda');
  assert.equal(visual.focusNeighborhood.upstream.length, 7);

  visual.zoomBy(1.5).panBy(12, -7).resize();
  assert.equal(visual.getState().transform.scale, 3.375);
  assert.equal(visual.svg.getAttribute('height'), '510');

  visual.destroy();
  assert.equal(container.children.length, 0);
  assert.equal(visual.destroyed, true);
});
