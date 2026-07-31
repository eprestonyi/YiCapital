(function (scope) {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const VERSION = '1.0.0';
  const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
  let instanceSequence = 0;

  const DEFAULTS = Object.freeze({
    width: 1200,
    starfieldHeight: 680,
    highwayHeight: 620,
    minScale: 0.45,
    maxScale: 4,
    locale: 'en',
    palette: Object.freeze({
      background: '#020810',
      surface: '#071421',
      surfaceSoft: '#0b1b2a',
      text: '#dce8f4',
      muted: '#7890a8',
      line: '#29415f',
      focus: '#22d3ee',
      material: '#6e9af4',
      funds: '#b54bfa',
      evidence: '#71839a',
      warning: '#f3c969',
      cluster: Object.freeze(['#335f9d', '#593b88', '#225f70', '#6b4b75', '#3c596f'])
    })
  });

  const COPY = Object.freeze({
    en: Object.freeze({
      zoomIn: 'Zoom in',
      zoomOut: 'Zoom out',
      fit: 'Fit graph',
      relations: 'Published relationship list',
      noRelations: 'No evidence-backed relationships are available for this view.',
      upstream: 'upstream',
      downstream: 'downstream',
      amountUnknown: 'amount not disclosed',
      evidenceLink: 'evidence relationship',
      materialFlow: 'physical / service flow',
      fundsFlow: 'funds flow (only when explicitly recorded)',
      graph: 'Atlas network graph',
      highway: 'Supply-chain highway',
      searchMatch: 'search match',
      focused: 'focused',
      stage: 'stage'
    }),
    cn: Object.freeze({
      zoomIn: '放大',
      zoomOut: '缩小',
      fit: '适合画布',
      relations: '已发布关系清单',
      noRelations: '当前视图没有具备证据的已发布关系。',
      upstream: '上游',
      downstream: '下游',
      amountUnknown: '金额未披露',
      evidenceLink: '证据关系',
      materialFlow: '实物／服务流',
      fundsFlow: '资金流（仅明确记录时显示）',
      graph: 'Atlas 星云关系图',
      highway: '供应链高速公路',
      searchMatch: '搜索匹配',
      focused: '当前焦点',
      stage: '阶段'
    }),
    tw: Object.freeze({
      zoomIn: '放大',
      zoomOut: '縮小',
      fit: '適合畫布',
      relations: '已發布關係清單',
      noRelations: '目前視圖沒有具備證據的已發布關係。',
      upstream: '上游',
      downstream: '下游',
      amountUnknown: '金額未披露',
      evidenceLink: '證據關係',
      materialFlow: '實物／服務流',
      fundsFlow: '資金流（僅明確記錄時顯示）',
      graph: 'Atlas 星雲關係圖',
      highway: '供應鏈高速公路',
      searchMatch: '搜尋匹配',
      focused: '目前焦點',
      stage: '階段'
    })
  });

  function finiteNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function stableHash(value) {
    const text = String(value == null ? '' : value);
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function stableCompare(left, right) {
    return String(left).localeCompare(String(right), 'en');
  }

  function localize(value, locale) {
    if (value == null) return '';
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    const language = ['tw', 'cn', 'en'].includes(locale) ? locale : 'en';
    return String(value[language] || value.en || value.cn || value.tw || '');
  }

  function copyFor(locale) {
    return COPY[['tw', 'cn', 'en'].includes(locale) ? locale : 'en'];
  }

  function mergePalette(palette) {
    return {
      ...DEFAULTS.palette,
      ...(palette && typeof palette === 'object' ? palette : {}),
      cluster: Array.isArray(palette?.cluster) && palette.cluster.length
        ? palette.cluster.slice()
        : DEFAULTS.palette.cluster.slice()
    };
  }

  function normalizedYear(year) {
    if (year == null || year === '') return null;
    const number = Number(year);
    return Number.isInteger(number) ? number : String(year);
  }

  function relationshipApplies(relation, year) {
    const canonicalYear = normalizedYear(year);
    if (canonicalYear == null) return true;
    if (!Array.isArray(relation.validCanonicalYears)) return false;
    return relation.validCanonicalYears.map(String).includes(String(canonicalYear));
  }

  function hasEvidence(relation, year) {
    if (!relation || typeof relation !== 'object') return false;
    if (!relationshipApplies(relation, year)) return false;
    const evidenceStatus = String(relation.evidenceStatus || '');
    if (/(modelled|modeled|taxonomy-only|candidate|inferred|estimated|unverified)/i.test(evidenceStatus)) {
      return false;
    }
    const canonicalYear = normalizedYear(year);
    if (canonicalYear != null && relation.evidenceByCanonicalYear?.[String(canonicalYear)]) return true;
    if (typeof relation.sourceId === 'string' && relation.sourceId.trim()) return true;
    if (Array.isArray(relation.sourceIds) && relation.sourceIds.some(Boolean)) return true;
    if (Array.isArray(relation.evidence) && relation.evidence.length) return true;
    if (relation.evidence && typeof relation.evidence === 'object') return true;
    return /^(disclosed|verified|audited|documented|primary)/i.test(evidenceStatus);
  }

  function normalizeFlowKind(relation) {
    const explicit = String(
      relation.flowKind || relation.flowType || relation.flow?.kind || relation.flow?.type || ''
    ).toLowerCase();
    if (/fund|money|cash|payment|revenue|consideration/.test(explicit)) return 'funds';
    if (/material|physical|goods|service|compute|data|license/.test(explicit)) return 'material';
    const type = String(relation.type || '').toLowerCase();
    if (/payment|fund|cash|revenue|consideration/.test(type)) return 'funds';
    if (/supplier|customer|assembly|packag|manufactur|foundry|logistic|service|license|hosting/.test(type)) {
      return 'material';
    }
    return 'evidence';
  }

  function normalizeGraph(input, options) {
    if (!input || typeof input !== 'object') throw new TypeError('Atlas graph must be an object.');
    if (!Array.isArray(input.entities) || !Array.isArray(input.relationships)) {
      throw new TypeError('Atlas graph requires entities and relationships arrays.');
    }
    const settings = options || {};
    const warnings = [];
    const ids = new Set();
    const entities = input.entities.map((entity) => {
      if (!entity || typeof entity.id !== 'string' || !entity.id.trim()) {
        throw new TypeError('Every Atlas entity requires a non-empty id.');
      }
      if (ids.has(entity.id)) throw new TypeError(`Duplicate Atlas entity id: ${entity.id}`);
      ids.add(entity.id);
      return { ...entity };
    }).sort((left, right) => stableCompare(left.id, right.id));

    const relationships = input.relationships.filter((relation) => {
      if (!relation || typeof relation.from !== 'string' || typeof relation.to !== 'string') {
        warnings.push('invalid_relationship_omitted');
        return false;
      }
      if (!ids.has(relation.from) || !ids.has(relation.to)) {
        warnings.push(`orphan_relationship_omitted:${relation.id || `${relation.from}-${relation.to}`}`);
        return false;
      }
      return relationshipApplies(relation, settings.year);
    }).map((relation, index) => ({
      ...relation,
      id: relation.id || `${relation.from}-${relation.to}-${index}`,
      flowKind: normalizeFlowKind(relation)
    })).sort((left, right) => stableCompare(left.id, right.id));

    const suppliedLayers = Array.isArray(input.layers) ? input.layers : [];
    const layerIds = new Set();
    const layers = suppliedLayers.map((layer, index) => {
      const id = String(layer?.id || `layer-${index}`);
      layerIds.add(id);
      return { ...layer, id, order: finiteNumber(layer?.order, index) };
    });
    entities.forEach((entity) => {
      const id = String(entity.layer || 'unclassified');
      if (!layerIds.has(id)) {
        layerIds.add(id);
        layers.push({ id, order: layers.length, label: id });
      }
    });
    layers.sort((left, right) => {
      const order = finiteNumber(left.order, 0) - finiteNumber(right.order, 0);
      return order || stableCompare(left.id, right.id);
    });

    return {
      entities,
      relationships,
      layers,
      warnings: [...new Set(warnings)],
      source: input
    };
  }

  function evidenceRelationships(input, options) {
    const graph = normalizeGraph(input, options);
    return graph.relationships.filter((relation) => hasEvidence(relation, options?.year));
  }

  function entityCluster(entity) {
    return String(
      entity.industryCluster || entity.industry || entity.cluster || entity.layer || 'unclassified'
    );
  }

  function candidatePoint(key, attempt, width, height, paddingX, paddingY) {
    const first = stableHash(`${key}:x:${attempt}`) / 4294967295;
    const second = stableHash(`${key}:y:${attempt}`) / 4294967295;
    return {
      x: paddingX + first * Math.max(1, width - paddingX * 2),
      y: paddingY + second * Math.max(1, height - paddingY * 2)
    };
  }

  function clusterCenters(clusters, width, height) {
    const centers = [];
    const minDistance = Math.max(112, Math.min(width, height) / Math.max(3.2, Math.sqrt(clusters.length)));
    clusters.forEach((cluster) => {
      let best = null;
      let bestDistance = -1;
      for (let attempt = 0; attempt < 48; attempt += 1) {
        const point = candidatePoint(cluster.key, attempt, width, height, 105, 82);
        const distance = centers.length
          ? Math.min(...centers.map((center) => Math.hypot(point.x - center.x, point.y - center.y)))
          : Infinity;
        if (distance > bestDistance) {
          bestDistance = distance;
          best = point;
        }
        if (distance >= minDistance) break;
      }
      centers.push({ ...best, key: cluster.key, count: cluster.entities.length });
    });
    return centers;
  }

  function layoutStarfield(input, options) {
    const settings = options || {};
    const width = finiteNumber(settings.width, DEFAULTS.width);
    const height = finiteNumber(settings.height, DEFAULTS.starfieldHeight);
    const graph = normalizeGraph(input, settings);
    const grouped = new Map();
    graph.entities.forEach((entity) => {
      const key = entityCluster(entity);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(entity);
    });
    const clusters = [...grouped.entries()].map(([key, entities]) => ({
      key,
      entities: entities.slice().sort((left, right) => stableCompare(left.id, right.id))
    })).sort((left, right) => stableCompare(left.key, right.key));
    const centers = clusterCenters(clusters, width, height);
    const nodes = [];
    const clusterLayout = [];

    clusters.forEach((cluster, clusterIndex) => {
      const center = centers[clusterIndex];
      const count = cluster.entities.length;
      const radius = 28 + Math.sqrt(count) * 22;
      clusterLayout.push({
        key: cluster.key,
        x: center.x,
        y: center.y,
        rx: radius * 1.36,
        ry: radius,
        count
      });
      cluster.entities.forEach((entity, entityIndex) => {
        const hashOffset = (stableHash(entity.id) % 360) * Math.PI / 180;
        const angle = hashOffset + entityIndex * GOLDEN_ANGLE;
        const distance = count === 1 ? 0 : 18 + Math.sqrt(entityIndex + 0.3) * 17;
        nodes.push({
          ...entity,
          clusterKey: cluster.key,
          x: clamp(center.x + Math.cos(angle) * distance, 28, width - 28),
          y: clamp(center.y + Math.sin(angle) * distance * 0.72, 34, height - 34),
          radius: entity.kind === 'company' ? 6 : 4.5
        });
      });
    });

    const nodeMap = new Map(nodes.map((node) => [node.id, node]));
    const edges = graph.relationships
      .filter((relation) => hasEvidence(relation, settings.year))
      .map((relation) => ({
      ...relation,
      source: nodeMap.get(relation.from),
      target: nodeMap.get(relation.to)
    })).filter((edge) => edge.source && edge.target);

    return {
      width,
      height,
      nodes: nodes.sort((left, right) => stableCompare(left.id, right.id)),
      edges,
      clusters: clusterLayout,
      layers: graph.layers,
      warnings: graph.warnings
    };
  }

  function orderHighwayLanes(nodesByLayer, relationships, layerOrder) {
    const ranks = new Map();
    layerOrder.forEach((layerId) => {
      (nodesByLayer.get(layerId) || []).forEach((node, index) => ranks.set(node.id, index));
    });
    for (let pass = 0; pass < 6; pass += 1) {
      const order = pass % 2 === 0 ? layerOrder : layerOrder.slice().reverse();
      order.forEach((layerId) => {
        const nodes = nodesByLayer.get(layerId) || [];
        nodes.sort((left, right) => {
          const leftNeighbors = relationships
            .filter((relation) => relation.from === left.id || relation.to === left.id)
            .map((relation) => ranks.get(relation.from === left.id ? relation.to : relation.from))
            .filter(Number.isFinite);
          const rightNeighbors = relationships
            .filter((relation) => relation.from === right.id || relation.to === right.id)
            .map((relation) => ranks.get(relation.from === right.id ? relation.to : relation.from))
            .filter(Number.isFinite);
          const leftMean = leftNeighbors.length
            ? leftNeighbors.reduce((sum, value) => sum + value, 0) / leftNeighbors.length
            : ranks.get(left.id);
          const rightMean = rightNeighbors.length
            ? rightNeighbors.reduce((sum, value) => sum + value, 0) / rightNeighbors.length
            : ranks.get(right.id);
          return leftMean - rightMean || stableCompare(left.id, right.id);
        });
        nodes.forEach((node, index) => ranks.set(node.id, index));
      });
    }
  }

  function layoutHighway(input, options) {
    const settings = options || {};
    const width = finiteNumber(settings.width, DEFAULTS.width);
    const height = finiteNumber(settings.height, DEFAULTS.highwayHeight);
    const graph = normalizeGraph(input, settings);
    const relationships = graph.relationships.filter((relation) => hasEvidence(relation, settings.year));
    const connectedIds = new Set();
    relationships.forEach((relation) => {
      connectedIds.add(relation.from);
      connectedIds.add(relation.to);
    });
    if (settings.focusId && graph.entities.some((entity) => entity.id === settings.focusId)) {
      connectedIds.add(settings.focusId);
    }
    const visibleEntities = graph.entities.filter((entity) => connectedIds.has(entity.id));
    const orderedLayers = graph.layers.map((layer) => layer.id);
    const nodesByLayer = new Map(orderedLayers.map((layerId) => [layerId, []]));
    visibleEntities.forEach((entity) => {
      if (!nodesByLayer.has(entity.layer)) nodesByLayer.set(entity.layer, []);
      nodesByLayer.get(entity.layer).push({ ...entity });
    });
    nodesByLayer.forEach((nodes) => nodes.sort((left, right) => stableCompare(left.id, right.id)));
    orderHighwayLanes(nodesByLayer, relationships, orderedLayers);

    const left = 92;
    const right = width - 72;
    const top = 92;
    const bottom = height - 56;
    const stageGap = orderedLayers.length > 1 ? (right - left) / (orderedLayers.length - 1) : 0;
    const stages = graph.layers.map((layer, index) => ({
      ...layer,
      x: orderedLayers.length === 1 ? width / 2 : left + stageGap * index,
      index
    }));
    const stageMap = new Map(stages.map((stage) => [stage.id, stage]));
    const nodes = [];
    orderedLayers.forEach((layerId) => {
      const layerNodes = nodesByLayer.get(layerId) || [];
      const laneGap = layerNodes.length > 1 ? (bottom - top) / (layerNodes.length - 1) : 0;
      layerNodes.forEach((entity, index) => {
        nodes.push({
          ...entity,
          x: stageMap.get(layerId)?.x ?? width / 2,
          y: layerNodes.length === 1 ? (top + bottom) / 2 : top + laneGap * index,
          lane: index
        });
      });
    });
    const nodeMap = new Map(nodes.map((node) => [node.id, node]));
    const degree = new Map(nodes.map((node) => [node.id, 0]));
    relationships.forEach((relation) => {
      degree.set(relation.from, (degree.get(relation.from) || 0) + 1);
      degree.set(relation.to, (degree.get(relation.to) || 0) + 1);
    });
    const rootId = settings.focusId && nodeMap.has(settings.focusId)
      ? settings.focusId
      : [...degree.entries()].sort((leftEntry, rightEntry) => {
        return rightEntry[1] - leftEntry[1] || stableCompare(leftEntry[0], rightEntry[0]);
      })[0]?.[0] || null;

    const edges = relationships.map((relation) => {
      const source = nodeMap.get(relation.from);
      const target = nodeMap.get(relation.to);
      if (!source || !target) return null;
      const direction = String(relation.flowDirection || relation.flow?.direction || 'from-to');
      const reverse = direction === 'to-from' || direction === 'reverse';
      const visualSource = reverse ? target : source;
      const visualTarget = reverse ? source : target;
      const span = visualTarget.x - visualSource.x;
      const bend = Math.max(42, Math.abs(span) * 0.38);
      const firstX = visualSource.x + Math.sign(span || 1) * bend;
      const secondX = visualTarget.x - Math.sign(span || 1) * bend;
      return {
        ...relation,
        source,
        target,
        visualSource,
        visualTarget,
        isTrunk: relation.from === rootId || relation.to === rootId,
        path: `M ${visualSource.x} ${visualSource.y} C ${firstX} ${visualSource.y}, ${secondX} ${visualTarget.y}, ${visualTarget.x} ${visualTarget.y}`
      };
    }).filter(Boolean);

    return {
      width,
      height,
      nodes,
      edges,
      stages,
      rootId,
      warnings: graph.warnings,
      omittedRelationshipCount: graph.relationships.length - relationships.length
    };
  }

  function neighborhood(input, focusId, options) {
    const graph = normalizeGraph(input, options);
    const entityMap = new Map(graph.entities.map((entity) => [entity.id, entity]));
    const focus = entityMap.get(focusId) || null;
    const relations = focus
      ? graph.relationships.filter((relation) =>
          hasEvidence(relation, options?.year)
          && (relation.from === focusId || relation.to === focusId))
      : [];
    const upstream = relations
      .filter((relation) => relation.to === focusId)
      .map((relation) => ({ relation, entity: entityMap.get(relation.from) }))
      .filter((item) => item.entity);
    const downstream = relations
      .filter((relation) => relation.from === focusId)
      .map((relation) => ({ relation, entity: entityMap.get(relation.to) }))
      .filter((item) => item.entity);
    return {
      entity: focus,
      relations,
      upstream,
      downstream,
      neighborIds: new Set([
        ...(focus ? [focus.id] : []),
        ...upstream.map((item) => item.entity.id),
        ...downstream.map((item) => item.entity.id)
      ])
    };
  }

  function svgElement(documentRef, name, attributes, text) {
    const element = documentRef.createElementNS(SVG_NS, name);
    Object.entries(attributes || {}).forEach(([key, value]) => {
      if (value != null) element.setAttribute(key, String(value));
    });
    if (text != null) element.textContent = String(text);
    return element;
  }

  function htmlElement(documentRef, name, attributes, text) {
    const element = documentRef.createElement(name);
    Object.entries(attributes || {}).forEach(([key, value]) => {
      if (key === 'className') element.className = String(value);
      else if (key === 'type') element.type = String(value);
      else element.setAttribute(key, String(value));
    });
    if (text != null) element.textContent = String(text);
    return element;
  }

  function setStyles(element, styles) {
    Object.entries(styles).forEach(([key, value]) => {
      element.style[key] = value;
    });
    return element;
  }

  function append(parent, children) {
    children.filter(Boolean).forEach((child) => parent.appendChild(child));
    return parent;
  }

  function marker(documentRef, id, color) {
    const element = svgElement(documentRef, 'marker', {
      id,
      viewBox: '0 0 10 10',
      refX: 8,
      refY: 5,
      markerWidth: 6,
      markerHeight: 6,
      orient: 'auto-start-reverse'
    });
    element.appendChild(svgElement(documentRef, 'path', {
      d: 'M 0 0 L 10 5 L 0 10 z',
      fill: color
    }));
    return element;
  }

  function createControls(instance, documentRef) {
    const copy = copyFor(instance.options.locale);
    const controls = setStyles(htmlElement(documentRef, 'div', {
      'aria-label': copy.graph,
      role: 'group'
    }), {
      position: 'absolute',
      top: '10px',
      right: '10px',
      zIndex: '3',
      display: 'flex',
      gap: '4px'
    });
    [
      { label: copy.zoomIn, text: '+', action: () => instance.zoomBy(1.24) },
      { label: copy.zoomOut, text: '−', action: () => instance.zoomBy(0.8) },
      { label: copy.fit, text: 'FIT', action: () => instance.fit() }
    ].forEach((control) => {
      const button = setStyles(htmlElement(documentRef, 'button', {
        type: 'button',
        'aria-label': control.label
      }, control.text), {
        minWidth: control.text === 'FIT' ? '38px' : '28px',
        height: '28px',
        padding: '0 7px',
        border: `1px solid ${instance.palette.line}`,
        borderRadius: '3px',
        background: instance.palette.surface,
        color: instance.palette.text,
        font: '600 10px ui-monospace, SFMono-Regular, Menlo, monospace',
        cursor: 'pointer'
      });
      instance.listen(button, 'click', control.action);
      controls.appendChild(button);
    });
    return controls;
  }

  function createFallback(instance, relationships, documentRef) {
    const copy = copyFor(instance.options.locale);
    const details = setStyles(htmlElement(documentRef, 'details'), {
      marginTop: '6px',
      borderTop: `1px solid ${instance.palette.line}`,
      color: instance.palette.muted,
      font: '500 11px ui-monospace, SFMono-Regular, Menlo, monospace'
    });
    const summary = setStyles(htmlElement(documentRef, 'summary', {}, copy.relations), {
      padding: '9px 4px',
      cursor: 'pointer',
      color: instance.palette.text
    });
    const list = setStyles(htmlElement(documentRef, 'ul'), {
      margin: '0',
      padding: '0 0 10px 22px'
    });
    const entityMap = new Map(instance.graph.entities.map((entity) => [entity.id, entity]));
    if (!relationships.length) {
      list.appendChild(htmlElement(documentRef, 'li', {}, copy.noRelations));
    } else {
      relationships.forEach((relation) => {
        const source = entityMap.get(relation.from);
        const target = entityMap.get(relation.to);
        const amount = relation.amount != null || relation.value != null
          ? String(relation.amount ?? relation.value)
          : copy.amountUnknown;
        const flowLabel = relation.flowKind === 'funds'
          ? copy.fundsFlow
          : relation.flowKind === 'material'
            ? copy.materialFlow
            : copy.evidenceLink;
        const item = htmlElement(
          documentRef,
          'li',
          {},
          `${source?.name || relation.from} → ${target?.name || relation.to} · ${flowLabel} · ${amount}`
        );
        list.appendChild(item);
      });
    }
    details.append(summary, list);
    return details;
  }

  function edgeColor(instance, flowKind) {
    if (flowKind === 'funds') return instance.palette.funds;
    if (flowKind === 'material') return instance.palette.material;
    return instance.palette.evidence;
  }

  function nodeAria(instance, node) {
    const copy = copyFor(instance.options.locale);
    const flags = [];
    if (instance.state.focusId === node.id) flags.push(copy.focused);
    if (instance.state.searchIds.has(node.id)) flags.push(copy.searchMatch);
    const role = localize(node.role, instance.options.locale);
    return [node.name || node.id, node.ticker, role, ...flags].filter(Boolean).join(' · ');
  }

  function createNodeGroup(instance, node, layoutMode, documentRef) {
    const isFocus = instance.state.focusId === node.id;
    const isSearch = instance.state.searchIds.has(node.id);
    const nearby = instance.focusNeighborhood.neighborIds;
    const dimmed = instance.state.focusId && !nearby.has(node.id);
    const group = svgElement(documentRef, 'g', {
      transform: `translate(${node.x} ${node.y})`,
      role: 'button',
      tabindex: '0',
      'aria-label': nodeAria(instance, node),
      'data-atlas-node': node.id,
      opacity: dimmed ? 0.1 : 1
    });
    group.style.cursor = 'pointer';
    const radius = layoutMode === 'starfield'
      ? (isFocus ? 10 : isSearch ? 8.5 : node.radius || 6)
      : (isFocus ? 9 : isSearch ? 8 : 6);
    const halo = svgElement(documentRef, 'circle', {
      r: radius + (isFocus ? 12 : isSearch ? 7 : 3),
      fill: isFocus ? instance.palette.focus : isSearch ? instance.palette.warning : instance.palette.material,
      opacity: isFocus ? 0.14 : isSearch ? 0.12 : 0.05
    });
    const core = svgElement(documentRef, 'circle', {
      r: radius,
      fill: isFocus
        ? instance.palette.focus
        : node.kind === 'company'
          ? instance.palette.material
          : instance.palette.evidence,
      stroke: isSearch ? instance.palette.warning : instance.palette.text,
      'stroke-width': isFocus || isSearch ? 1.6 : 0.55
    });
    const label = svgElement(documentRef, 'text', {
      x: layoutMode === 'starfield' ? radius + 7 : 10,
      y: 3,
      fill: instance.palette.text,
      'font-size': layoutMode === 'starfield' ? 10 : 10.5,
      'font-family': 'ui-monospace, SFMono-Regular, Menlo, monospace',
      'font-weight': isFocus ? 700 : 500
    }, node.name || node.id);
    const title = svgElement(documentRef, 'title', {}, nodeAria(instance, node));
    group.append(title, halo, core, label);

    const select = (event) => {
      if (event?.type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
      if (event?.preventDefault) event.preventDefault();
      instance.setFocus(instance.state.focusId === node.id ? null : node.id, true);
    };
    instance.listen(group, 'click', select, true);
    instance.listen(group, 'keydown', select, true);
    return group;
  }

  function renderLegend(instance, documentRef) {
    const copy = copyFor(instance.options.locale);
    const group = svgElement(documentRef, 'g', {
      transform: `translate(28 ${instance.layout.height - 23})`,
      'aria-hidden': 'true'
    });
    [
      ['material', copy.materialFlow, '0'],
      ['funds', copy.fundsFlow, '7 5'],
      ['evidence', copy.evidenceLink, '3 5']
    ].forEach((item, index) => {
      const x = index * 250;
      group.append(
        svgElement(documentRef, 'line', {
          x1: x,
          x2: x + 24,
          y1: 0,
          y2: 0,
          stroke: edgeColor(instance, item[0]),
          'stroke-width': item[0] === 'material' ? 2.5 : 2,
          'stroke-dasharray': item[2]
        }),
        svgElement(documentRef, 'text', {
          x: x + 31,
          y: 4,
          fill: instance.palette.muted,
          'font-size': 9,
          'font-family': 'ui-monospace, SFMono-Regular, Menlo, monospace'
        }, item[1])
      );
    });
    return group;
  }

  function renderStarfield(instance, documentRef) {
    const layout = layoutStarfield(instance.graph.source, {
      ...instance.options,
      width: DEFAULTS.width,
      height: finiteNumber(instance.options.height, DEFAULTS.starfieldHeight)
    });
    instance.layout = layout;
    const copy = copyFor(instance.options.locale);
    const svg = svgElement(documentRef, 'svg', {
      viewBox: `0 0 ${layout.width} ${layout.height}`,
      width: '100%',
      height: String(layout.height),
      role: 'img',
      'aria-label': copy.graph,
      preserveAspectRatio: 'xMidYMid meet'
    });
    setStyles(svg, {
      display: 'block',
      width: '100%',
      touchAction: 'none',
      background: instance.palette.background,
      borderRadius: '4px'
    });
    const defs = svgElement(documentRef, 'defs');
    const glow = svgElement(documentRef, 'filter', {
      id: `${instance.id}-glow`,
      x: '-80%',
      y: '-80%',
      width: '260%',
      height: '260%'
    });
    glow.appendChild(svgElement(documentRef, 'feGaussianBlur', { stdDeviation: 12 }));
    defs.append(
      glow,
      marker(documentRef, `${instance.id}-material`, instance.palette.material),
      marker(documentRef, `${instance.id}-funds`, instance.palette.funds),
      marker(documentRef, `${instance.id}-evidence`, instance.palette.evidence)
    );
    svg.appendChild(defs);
    const viewport = svgElement(documentRef, 'g', { 'data-atlas-viewport': 'true' });
    const background = svgElement(documentRef, 'rect', {
      x: 0,
      y: 0,
      width: layout.width,
      height: layout.height,
      fill: instance.palette.background,
      'data-atlas-pan-surface': 'true'
    });
    viewport.appendChild(background);

    for (let index = 0; index < 150; index += 1) {
      const x = 16 + (stableHash(`star-x:${index}`) / 4294967295) * (layout.width - 32);
      const y = 16 + (stableHash(`star-y:${index}`) / 4294967295) * (layout.height - 32);
      viewport.appendChild(svgElement(documentRef, 'circle', {
        cx: x.toFixed(2),
        cy: y.toFixed(2),
        r: index % 17 === 0 ? 1.35 : index % 5 === 0 ? 0.9 : 0.55,
        fill: instance.palette.text,
        opacity: 0.12 + (stableHash(`star-o:${index}`) % 42) / 100
      }));
    }

    layout.clusters.forEach((cluster, index) => {
      const color = instance.palette.cluster[index % instance.palette.cluster.length];
      viewport.append(
        svgElement(documentRef, 'ellipse', {
          cx: cluster.x,
          cy: cluster.y,
          rx: cluster.rx,
          ry: cluster.ry,
          fill: color,
          opacity: 0.14,
          filter: `url(#${instance.id}-glow)`
        }),
        svgElement(documentRef, 'ellipse', {
          cx: cluster.x,
          cy: cluster.y,
          rx: cluster.rx,
          ry: cluster.ry,
          fill: color,
          opacity: 0.055,
          stroke: color,
          'stroke-width': 0.8
        }),
        svgElement(documentRef, 'text', {
          x: cluster.x,
          y: Math.max(18, cluster.y - cluster.ry - 8),
          fill: instance.palette.muted,
          'text-anchor': 'middle',
          'font-size': 9,
          'font-family': 'ui-monospace, SFMono-Regular, Menlo, monospace',
          'letter-spacing': 1.1
        }, cluster.key.toUpperCase())
      );
    });

    const nearby = instance.focusNeighborhood.neighborIds;
    layout.edges.forEach((edge) => {
      const isConnected = !instance.state.focusId ||
        edge.from === instance.state.focusId || edge.to === instance.state.focusId;
      const dx = edge.target.x - edge.source.x;
      const dy = edge.target.y - edge.source.y;
      const curve = ((stableHash(edge.id) % 31) - 15) / 100;
      const controlX = (edge.source.x + edge.target.x) / 2 - dy * curve;
      const controlY = (edge.source.y + edge.target.y) / 2 + dx * curve;
      const color = edgeColor(instance, edge.flowKind);
      const path = svgElement(documentRef, 'path', {
        d: `M ${edge.source.x} ${edge.source.y} Q ${controlX} ${controlY} ${edge.target.x} ${edge.target.y}`,
        fill: 'none',
        stroke: color,
        'stroke-width': isConnected ? 1.7 : 0.8,
        'stroke-dasharray': edge.flowKind === 'funds' ? '7 5' : edge.flowKind === 'evidence' ? '3 5' : '0',
        opacity: instance.state.focusId && !isConnected ? 0.05 : edge.evidenceStatus?.startsWith('disclosed') ? 0.72 : 0.36,
        'marker-end': `url(#${instance.id}-${edge.flowKind})`,
        'data-atlas-edge': edge.id
      });
      path.appendChild(svgElement(documentRef, 'title', {}, `${edge.source.name} → ${edge.target.name}`));
      viewport.appendChild(path);
    });
    layout.nodes.forEach((node) => {
      if (!instance.state.focusId || nearby.has(node.id) || instance.options.showContext !== false) {
        viewport.appendChild(createNodeGroup(instance, node, 'starfield', documentRef));
      }
    });
    svg.append(viewport, renderLegend(instance, documentRef));
    instance.svg = svg;
    instance.viewport = viewport;
    instance.applyTransform();
    instance.bindPanZoom();
    return {
      svg,
      relationships: layout.edges
    };
  }

  function renderHighway(instance, documentRef) {
    const layout = layoutHighway(instance.graph.source, {
      ...instance.options,
      focusId: instance.state.focusId,
      width: DEFAULTS.width,
      height: finiteNumber(instance.options.height, DEFAULTS.highwayHeight)
    });
    instance.layout = layout;
    const copy = copyFor(instance.options.locale);
    const svg = svgElement(documentRef, 'svg', {
      viewBox: `0 0 ${layout.width} ${layout.height}`,
      width: '100%',
      height: String(layout.height),
      role: 'img',
      'aria-label': copy.highway,
      preserveAspectRatio: 'xMidYMid meet'
    });
    setStyles(svg, {
      display: 'block',
      width: '100%',
      touchAction: 'none',
      background: instance.palette.background,
      borderRadius: '4px'
    });
    const defs = svgElement(documentRef, 'defs');
    defs.append(
      marker(documentRef, `${instance.id}-material`, instance.palette.material),
      marker(documentRef, `${instance.id}-funds`, instance.palette.funds),
      marker(documentRef, `${instance.id}-evidence`, instance.palette.evidence)
    );
    svg.appendChild(defs);
    const viewport = svgElement(documentRef, 'g', { 'data-atlas-viewport': 'true' });
    viewport.appendChild(svgElement(documentRef, 'rect', {
      x: 0,
      y: 0,
      width: layout.width,
      height: layout.height,
      fill: instance.palette.background,
      'data-atlas-pan-surface': 'true'
    }));
    const stageWidth = layout.stages.length > 1
      ? (layout.stages[1].x - layout.stages[0].x) * 0.82
      : layout.width * 0.72;
    layout.stages.forEach((stage, index) => {
      viewport.append(
        svgElement(documentRef, 'rect', {
          x: stage.x - stageWidth / 2,
          y: 46,
          width: stageWidth,
          height: layout.height - 98,
          rx: 5,
          fill: index % 2 === 0 ? instance.palette.surface : instance.palette.surfaceSoft,
          opacity: 0.5,
          stroke: instance.palette.line,
          'stroke-width': 0.7
        }),
        svgElement(documentRef, 'text', {
          x: stage.x,
          y: 31,
          fill: instance.palette.muted,
          'text-anchor': 'middle',
          'font-size': 10,
          'font-family': 'ui-monospace, SFMono-Regular, Menlo, monospace',
          'letter-spacing': 0.9
        }, localize(stage.label, instance.options.locale) || stage.id)
      );
    });

    layout.edges.forEach((edge) => {
      const connected = !instance.state.focusId ||
        edge.from === instance.state.focusId || edge.to === instance.state.focusId;
      const color = edgeColor(instance, edge.flowKind);
      const path = svgElement(documentRef, 'path', {
        d: edge.path,
        fill: 'none',
        stroke: color,
        'stroke-width': edge.isTrunk ? 4.2 : 2.2,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        'stroke-dasharray': edge.flowKind === 'funds' ? '9 6' : edge.flowKind === 'evidence' ? '3 5' : '0',
        opacity: connected ? 0.88 : 0.18,
        'marker-end': `url(#${instance.id}-${edge.flowKind})`,
        'data-atlas-edge': edge.id,
        'data-flow-kind': edge.flowKind
      });
      const amount = edge.amount != null || edge.value != null
        ? String(edge.amount ?? edge.value)
        : copy.amountUnknown;
      path.appendChild(svgElement(
        documentRef,
        'title',
        {},
        `${edge.source.name} → ${edge.target.name} · ${edge.type || copy.evidenceLink} · ${amount}`
      ));
      viewport.appendChild(path);
    });
    layout.nodes.forEach((node) => viewport.appendChild(createNodeGroup(instance, node, 'highway', documentRef)));
    svg.append(viewport, renderLegend(instance, documentRef));
    instance.svg = svg;
    instance.viewport = viewport;
    instance.applyTransform();
    instance.bindPanZoom();
    return {
      svg,
      relationships: layout.edges
    };
  }

  function createVisualization(mode, container, input, options) {
    if (!container || typeof container.appendChild !== 'function') {
      throw new TypeError('A DOM container is required.');
    }
    const documentRef = container.ownerDocument || scope.document;
    if (!documentRef || typeof documentRef.createElement !== 'function') {
      throw new TypeError('A DOM document is required.');
    }
    const settings = {
      locale: 'en',
      minScale: DEFAULTS.minScale,
      maxScale: DEFAULTS.maxScale,
      showContext: true,
      ...(options || {})
    };
    const palette = mergePalette(settings.palette);
    const graph = normalizeGraph(input, settings);
    instanceSequence += 1;
    const instanceId = `yc-atlas-${mode}-${stableHash(graph.entities.map((item) => item.id).join('|'))}-${instanceSequence}`;
    const root = setStyles(htmlElement(documentRef, 'div', {
      'data-yc-atlas-visual': mode,
      'data-yc-atlas-version': VERSION
    }), {
      position: 'relative',
      width: '100%',
      minWidth: '0',
      color: palette.text,
      background: palette.background,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace'
    });
    const stage = htmlElement(documentRef, 'div', { 'data-atlas-stage': 'true' });
    root.append(stage);
    container.appendChild(root);

    const instance = {
      id: instanceId,
      mode,
      container,
      root,
      stage,
      graph,
      options: settings,
      palette,
      state: {
        focusId: settings.focusId || null,
        searchQuery: String(settings.searchState?.query || ''),
        searchIds: new Set(
          Array.isArray(settings.searchState?.matchedIds) ? settings.searchState.matchedIds : []
        )
      },
      transform: { x: 0, y: 0, scale: 1 },
      layout: null,
      svg: null,
      viewport: null,
      destroyed: false,
      persistentListeners: [],
      renderListeners: [],
      resizeObserver: null,
      resizeFrame: null,
      focusNeighborhood: neighborhood(input, settings.focusId || null, settings),

      listen(target, eventName, listener, renderScoped) {
        target.addEventListener(eventName, listener);
        const dispose = () => target.removeEventListener(eventName, listener);
        (renderScoped ? this.renderListeners : this.persistentListeners).push(dispose);
      },

      clearRenderListeners() {
        this.renderListeners.splice(0).forEach((dispose) => dispose());
      },

      render() {
        if (this.destroyed) return this;
        this.clearRenderListeners();
        this.stage.replaceChildren();
        this.focusNeighborhood = neighborhood(this.graph.source, this.state.focusId, this.options);
        const rendered = this.mode === 'starfield'
          ? renderStarfield(this, documentRef)
          : renderHighway(this, documentRef);
        this.stage.append(
          rendered.svg,
          createFallback(this, rendered.relationships, documentRef)
        );
        return this;
      },

      update(nextInput, nextOptions) {
        if (this.destroyed) return this;
        this.options = { ...this.options, ...(nextOptions || {}) };
        this.palette = mergePalette(this.options.palette);
        this.graph = normalizeGraph(nextInput, this.options);
        if (this.state.focusId && !this.graph.entities.some((entity) => entity.id === this.state.focusId)) {
          this.state.focusId = null;
        }
        return this.render();
      },

      setFocus(focusId, notify) {
        if (this.destroyed) return this;
        const normalized = focusId && this.graph.entities.some((entity) => entity.id === focusId)
          ? focusId
          : null;
        this.state.focusId = normalized;
        this.options.focusId = normalized;
        this.render();
        if (notify && typeof this.options.onFocusChange === 'function') {
          this.options.onFocusChange({
            ...this.focusNeighborhood,
            focusId: normalized
          });
        }
        return this;
      },

      setSearchState(searchState) {
        if (this.destroyed) return this;
        const next = searchState || {};
        this.state.searchQuery = String(next.query || '');
        this.state.searchIds = new Set(
          Array.isArray(next.matchedIds) ? next.matchedIds.filter((id) => typeof id === 'string') : []
        );
        if (Object.prototype.hasOwnProperty.call(next, 'focusId')) {
          this.state.focusId = next.focusId &&
            this.graph.entities.some((entity) => entity.id === next.focusId)
            ? next.focusId
            : null;
          this.options.focusId = this.state.focusId;
        }
        return this.render();
      },

      applyTransform() {
        if (!this.viewport) return;
        this.viewport.setAttribute(
          'transform',
          `translate(${this.transform.x} ${this.transform.y}) scale(${this.transform.scale})`
        );
      },

      zoomBy(factor, point) {
        if (this.destroyed) return this;
        const current = this.transform.scale;
        const next = clamp(
          current * finiteNumber(factor, 1),
          finiteNumber(this.options.minScale, DEFAULTS.minScale),
          finiteNumber(this.options.maxScale, DEFAULTS.maxScale)
        );
        const anchor = point || {
          x: (this.layout?.width || DEFAULTS.width) / 2,
          y: (this.layout?.height || DEFAULTS.starfieldHeight) / 2
        };
        const worldX = (anchor.x - this.transform.x) / current;
        const worldY = (anchor.y - this.transform.y) / current;
        this.transform.x = anchor.x - worldX * next;
        this.transform.y = anchor.y - worldY * next;
        this.transform.scale = next;
        this.applyTransform();
        return this;
      },

      panBy(deltaX, deltaY) {
        if (this.destroyed) return this;
        this.transform.x += finiteNumber(deltaX, 0);
        this.transform.y += finiteNumber(deltaY, 0);
        this.applyTransform();
        return this;
      },

      fit() {
        if (this.destroyed) return this;
        this.transform = { x: 0, y: 0, scale: 1 };
        this.applyTransform();
        return this;
      },

      bindPanZoom() {
        if (!this.svg) return;
        let dragging = null;
        this.listen(this.svg, 'wheel', (event) => {
          event.preventDefault();
          const rect = this.svg.getBoundingClientRect();
          const x = (event.clientX - rect.left) * (this.layout.width / Math.max(1, rect.width));
          const y = (event.clientY - rect.top) * (this.layout.height / Math.max(1, rect.height));
          this.zoomBy(event.deltaY < 0 ? 1.12 : 0.89, { x, y });
        }, true);
        this.listen(this.svg, 'pointerdown', (event) => {
          const isSurface = event.target === this.svg ||
            event.target?.getAttribute?.('data-atlas-pan-surface') === 'true';
          if (!isSurface) return;
          dragging = { x: event.clientX, y: event.clientY };
          if (this.svg.setPointerCapture && event.pointerId != null) {
            this.svg.setPointerCapture(event.pointerId);
          }
        }, true);
        this.listen(this.svg, 'pointermove', (event) => {
          if (!dragging) return;
          const rect = this.svg.getBoundingClientRect();
          const factor = this.layout.width / Math.max(1, rect.width);
          this.panBy((event.clientX - dragging.x) * factor, (event.clientY - dragging.y) * factor);
          dragging = { x: event.clientX, y: event.clientY };
        }, true);
        const stop = () => { dragging = null; };
        this.listen(this.svg, 'pointerup', stop, true);
        this.listen(this.svg, 'pointercancel', stop, true);
      },

      resize() {
        if (this.destroyed || !this.svg) return this;
        const width = finiteNumber(this.root.getBoundingClientRect?.().width, DEFAULTS.width);
        const designWidth = this.layout?.width || DEFAULTS.width;
        const designHeight = this.layout?.height || DEFAULTS.starfieldHeight;
        const minimum = this.mode === 'starfield' ? 360 : 390;
        const height = clamp(width * designHeight / designWidth, minimum, designHeight);
        this.svg.setAttribute('height', String(Math.round(height)));
        return this;
      },

      getState() {
        return {
          mode: this.mode,
          focusId: this.state.focusId,
          searchQuery: this.state.searchQuery,
          searchIds: [...this.state.searchIds],
          transform: { ...this.transform },
          warnings: this.layout?.warnings?.slice() || [],
          nodeCount: this.layout?.nodes?.length || 0,
          edgeCount: this.layout?.edges?.length || 0,
          omittedRelationshipCount: this.layout?.omittedRelationshipCount || 0
        };
      },

      destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        this.clearRenderListeners();
        this.persistentListeners.splice(0).forEach((dispose) => dispose());
        if (this.resizeObserver) this.resizeObserver.disconnect();
        const view = documentRef.defaultView || scope;
        if (this.resizeFrame != null && view.cancelAnimationFrame) {
          view.cancelAnimationFrame(this.resizeFrame);
        }
        if (this.root.parentNode) this.root.parentNode.removeChild(this.root);
        this.svg = null;
        this.viewport = null;
      }
    };

    root.insertBefore(createControls(instance, documentRef), stage);
    instance.render();
    instance.resize();

    const ResizeObserverRef = documentRef.defaultView?.ResizeObserver || scope.ResizeObserver;
    if (typeof ResizeObserverRef === 'function') {
      instance.resizeObserver = new ResizeObserverRef(() => instance.resize());
      instance.resizeObserver.observe(root);
    } else {
      const view = documentRef.defaultView || scope;
      if (view && typeof view.addEventListener === 'function') {
        instance.listen(view, 'resize', () => instance.resize());
      }
    }
    return instance;
  }

  function createStarfield(container, input, options) {
    return createVisualization('starfield', container, input, options);
  }

  function createHighway(container, input, options) {
    return createVisualization('highway', container, input, options);
  }

  const api = Object.freeze({
    VERSION,
    createStarfield,
    createHighway,
    evidenceRelationships,
    hasEvidence,
    layoutStarfield,
    layoutHighway,
    neighborhood,
    normalizeFlowKind,
    normalizeGraph,
    stableHash
  });

  scope.YCAtlasVisuals = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
