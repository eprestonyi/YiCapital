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
      background: '#01040b',
      surface: '#071321',
      surfaceSoft: '#0b1a2b',
      text: '#e8f3ff',
      muted: '#7895b5',
      line: '#284463',
      focus: '#49e3ff',
      material: '#6e9af4',
      funds: '#b54bfa',
      evidence: '#71839a',
      warning: '#f3c969',
      cluster: Object.freeze(['#3578f6', '#9d5cf5', '#20b9bd', '#e05ac7', '#4f6fff', '#1f93d1'])
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
      region: 'industry region',
      regionSelected: 'selected region',
      focusWidth: 'line width highlights the current focus; it is not transaction value',
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
      region: '产业区域',
      regionSelected: '已选择区域',
      focusWidth: '线宽仅强调当前焦点，不代表交易金额',
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
      region: '產業區域',
      regionSelected: '已選擇區域',
      focusWidth: '線寬僅強調目前焦點，不代表交易金額',
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

  function regionLabel(value) {
    return String(value || 'unclassified')
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function annotateEdgeSalience(edges) {
    return edges.map((edge) => ({
      ...edge,
      visualSalience: {
      status: 'focus-only',
      value: null,
      method: null,
      sourceId: null
      }
    }));
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
    clusters.forEach((cluster) => {
      let best = null;
      let bestClearance = -Infinity;
      const paddingX = Math.min(width * 0.23, Math.max(92, cluster.rx * 0.7));
      const paddingY = Math.min(height * 0.28, Math.max(68, cluster.ry * 0.7));
      for (let attempt = 0; attempt < 72; attempt += 1) {
        const point = candidatePoint(cluster.key, attempt, width, height, paddingX, paddingY);
        const clearance = centers.length
          ? Math.min(...centers.map((center) => {
            const dx = (point.x - center.x) / Math.max(1, cluster.rx + center.rx);
            const dy = (point.y - center.y) / Math.max(1, cluster.ry + center.ry);
            return Math.hypot(dx, dy);
          }))
          : Infinity;
        if (clearance > bestClearance) {
          bestClearance = clearance;
          best = point;
        }
        if (clearance >= 1.12) break;
      }
      centers.push({
        ...best,
        key: cluster.key,
        count: cluster.entities.length,
        rx: cluster.rx,
        ry: cluster.ry
      });
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
    const clusters = [...grouped.entries()].map(([key, entities]) => {
      const count = entities.length;
      const radius = 34 + Math.sqrt(count) * 24;
      return {
        key,
        entities: entities.slice().sort((left, right) => stableCompare(left.id, right.id)),
        rx: radius * 1.5,
        ry: radius
      };
    }).sort((left, right) => stableCompare(left.key, right.key));
    const centers = clusterCenters(clusters, width, height);
    const nodes = [];
    const clusterLayout = [];

    clusters.forEach((cluster, clusterIndex) => {
      const center = centers[clusterIndex];
      const count = cluster.entities.length;
      clusterLayout.push({
        key: cluster.key,
        label: regionLabel(cluster.key),
        x: center.x,
        y: center.y,
        rx: cluster.rx,
        ry: cluster.ry,
        count
      });
      cluster.entities.forEach((entity, entityIndex) => {
        const baseAngle = (stableHash(`${cluster.key}:orbit`) % 360) * Math.PI / 180;
        const angle = count <= 6
          ? baseAngle + entityIndex * Math.PI * 2 / Math.max(1, count)
          : baseAngle + entityIndex * GOLDEN_ANGLE;
        const distance = count === 1
          ? 0
          : count <= 6
            ? Math.min(cluster.ry * 0.58, 30 + count * 5)
            : 22 + Math.sqrt(entityIndex + 0.4) * 22;
        nodes.push({
          ...entity,
          clusterKey: cluster.key,
          x: clamp(center.x + Math.cos(angle) * distance, 28, width - 28),
          y: clamp(center.y + Math.sin(angle) * distance * 0.72, 34, height - 34),
          radius: entity.kind === 'company' ? 6 : 4.5,
          labelSide: Math.cos(angle) < -0.16 ? 'left' : 'right'
        });
      });
    });

    const nodeMap = new Map(nodes.map((node) => [node.id, node]));
    const edges = annotateEdgeSalience(graph.relationships
      .filter((relation) => hasEvidence(relation, settings.year))
      .map((relation) => ({
      ...relation,
      source: nodeMap.get(relation.from),
      target: nodeMap.get(relation.to)
    })).filter((edge) => edge.source && edge.target));

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

    const edges = annotateEdgeSalience(relationships.map((relation) => {
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
    }).filter(Boolean));

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

  function edgeStrokeWidth(_edge, base, selectedBoost) {
    return finiteNumber(base, 1.35) + (selectedBoost ? 1.8 : 0);
  }

  function edgeSalienceLabel(instance) {
    return copyFor(instance.options.locale).focusWidth;
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
    const outsideRegion = instance.state.regionKey && node.clusterKey !== instance.state.regionKey;
    const dimmed = (instance.state.focusId && !nearby.has(node.id)) ||
      (!instance.state.focusId && outsideRegion);
    const group = svgElement(documentRef, 'g', {
      transform: `translate(${node.x} ${node.y})`,
      role: 'button',
      tabindex: '0',
      'aria-label': nodeAria(instance, node),
      'data-atlas-node': node.id,
      'data-atlas-node-name': node.name || node.id,
      'data-atlas-node-ticker': node.ticker || null,
      opacity: dimmed ? 0.1 : 1
    });
    group.style.cursor = 'pointer';
    const radius = layoutMode === 'starfield'
      ? (isFocus ? 10 : isSearch ? 8.5 : node.radius || 6)
      : (isFocus ? 9 : isSearch ? 8 : 6);
    const labelOnLeft = layoutMode === 'starfield' && node.labelSide === 'left';
    const labelX = layoutMode === 'starfield'
      ? (labelOnLeft ? -radius - 7 : radius + 7)
      : 10;
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
      x: labelX,
      y: node.ticker ? -1 : 3,
      fill: instance.palette.text,
      'font-size': layoutMode === 'starfield' ? 10.5 : 10.5,
      'font-family': 'ui-monospace, SFMono-Regular, Menlo, monospace',
      'font-weight': isFocus ? 700 : 500,
      'text-anchor': labelOnLeft ? 'end' : 'start'
    }, node.name || node.id);
    const ticker = node.ticker
      ? svgElement(documentRef, 'text', {
        x: labelX,
        y: 11,
        fill: instance.palette.muted,
        'font-size': 7.5,
        'font-family': 'ui-monospace, SFMono-Regular, Menlo, monospace',
        'font-weight': 500,
        'letter-spacing': 0.45,
        'text-anchor': labelOnLeft ? 'end' : 'start',
        'data-atlas-ticker-label': node.id
      }, node.ticker)
      : null;
    const title = svgElement(documentRef, 'title', {}, nodeAria(instance, node));
    append(group, [title, halo, core, label, ticker]);

    const select = (event) => {
      if (event?.type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
      if (event?.preventDefault) event.preventDefault();
      instance.setFocus(instance.state.focusId === node.id ? null : node.id, true);
    };
    instance.listen(group, 'click', select, true);
    instance.listen(group, 'keydown', select, true);
    instance.listen(group, 'dblclick', (event) => {
      if (event?.preventDefault) event.preventDefault();
      instance.zoomToNode(node.id, 2.65);
    }, true);
    return group;
  }

  function createRegionGroup(instance, cluster, index, documentRef) {
    const copy = copyFor(instance.options.locale);
    const selected = instance.state.regionKey === cluster.key;
    const dimmed = instance.state.regionKey && !selected && !instance.state.focusId;
    const color = instance.palette.cluster[index % instance.palette.cluster.length];
    const group = svgElement(documentRef, 'g', {
      'data-atlas-region-visual': cluster.key,
      opacity: dimmed ? 0.18 : 1
    });
    group.style.pointerEvents = 'none';
    const rotation = (stableHash(`${cluster.key}:rotation`) % 29) - 14;
    group.append(
      svgElement(documentRef, 'ellipse', {
        cx: cluster.x,
        cy: cluster.y,
        rx: cluster.rx * 1.14,
        ry: cluster.ry * 1.14,
        fill: `url(#${instance.id}-nebula-${index})`,
        opacity: selected ? 0.96 : 0.76,
        filter: `url(#${instance.id}-nebula-soft)`,
        transform: `rotate(${rotation} ${cluster.x} ${cluster.y})`
      }),
      svgElement(documentRef, 'ellipse', {
        cx: cluster.x,
        cy: cluster.y,
        rx: cluster.rx * 0.82,
        ry: cluster.ry * 0.58,
        fill: `url(#${instance.id}-nebula-${index})`,
        opacity: selected ? 0.94 : 0.62,
        transform: `rotate(${-rotation * 1.7} ${cluster.x} ${cluster.y})`
      }),
      svgElement(documentRef, 'ellipse', {
        cx: cluster.x,
        cy: cluster.y,
        rx: cluster.rx,
        ry: cluster.ry,
        fill: 'none',
        stroke: selected ? instance.palette.focus : color,
        'stroke-width': selected ? 1.8 : 0.65,
        'stroke-dasharray': selected ? '0' : '2 7',
        opacity: selected ? 0.78 : 0.34,
        transform: `rotate(${rotation} ${cluster.x} ${cluster.y})`
      })
    );
    for (let dustIndex = 0; dustIndex < 22; dustIndex += 1) {
      const angle = (stableHash(`${cluster.key}:dust-a:${dustIndex}`) % 360) * Math.PI / 180;
      const radiusFactor = Math.sqrt(
        stableHash(`${cluster.key}:dust-r:${dustIndex}`) / 4294967295
      ) * 0.82;
      const x = cluster.x + Math.cos(angle) * cluster.rx * radiusFactor;
      const y = cluster.y + Math.sin(angle) * cluster.ry * radiusFactor;
      group.appendChild(svgElement(documentRef, 'circle', {
        cx: x.toFixed(2),
        cy: y.toFixed(2),
        r: dustIndex % 9 === 0 ? 1.4 : dustIndex % 4 === 0 ? 0.85 : 0.48,
        fill: dustIndex % 5 === 0 ? instance.palette.text : color,
        opacity: 0.18 + (stableHash(`${cluster.key}:dust-o:${dustIndex}`) % 48) / 100
      }));
    }
    const labelY = Math.max(18, cluster.y - cluster.ry - 11);
    const labelWidth = clamp(cluster.label.length * 6.5 + 24, 68, 210);
    const hitTarget = svgElement(documentRef, 'g', {
      role: 'button',
      tabindex: '0',
      'aria-label': `${cluster.label} · ${copy.region}${selected ? ` · ${copy.regionSelected}` : ''}`,
      'data-atlas-region': cluster.key,
      'data-atlas-region-selected': selected ? 'true' : 'false'
    });
    hitTarget.style.pointerEvents = 'all';
    hitTarget.style.cursor = 'zoom-in';
    const centerHit = svgElement(documentRef, 'circle', {
      cx: cluster.x,
      cy: cluster.y,
      r: Math.min(22, Math.max(13, cluster.ry * 0.22)),
      fill: color,
      'fill-opacity': 0.001,
      stroke: 'none',
      'pointer-events': 'all',
      'aria-hidden': 'true'
    });
    centerHit.style.cursor = 'zoom-in';
    hitTarget.append(
      svgElement(documentRef, 'rect', {
        x: cluster.x - labelWidth / 2,
        y: labelY - 12,
        width: labelWidth,
        height: 18,
        rx: 5,
        fill: instance.palette.background,
        'fill-opacity': selected ? 0.58 : 0.22,
        stroke: selected ? instance.palette.focus : 'none',
        'stroke-width': selected ? 0.7 : 0,
        'pointer-events': 'all'
      }),
      svgElement(documentRef, 'text', {
        x: cluster.x,
        y: labelY,
        fill: selected ? instance.palette.text : instance.palette.muted,
        'text-anchor': 'middle',
        'font-size': selected ? 10 : 9,
        'font-family': 'ui-monospace, SFMono-Regular, Menlo, monospace',
        'font-weight': selected ? 700 : 600,
        'letter-spacing': 1.15,
        'pointer-events': 'none'
      }, cluster.label.toUpperCase()),
      svgElement(documentRef, 'title', {}, `${cluster.label} · ${copy.region}`)
    );
    group.append(centerHit, hitTarget);
    const select = (event) => {
      if (event?.type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
      if (event?.preventDefault) event.preventDefault();
      instance.setRegion(selected ? null : cluster.key, true);
    };
    instance.listen(centerHit, 'click', select, true);
    instance.listen(hitTarget, 'click', select, true);
    instance.listen(hitTarget, 'keydown', select, true);
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
    group.append(
      svgElement(documentRef, 'line', {
        x1: 750,
        x2: 778,
        y1: 0,
        y2: 0,
        stroke: instance.palette.focus,
        'stroke-width': 4.2,
        'stroke-linecap': 'round'
      }),
      svgElement(documentRef, 'text', {
        x: 786,
        y: 4,
        fill: instance.palette.muted,
        'font-size': 8.5,
        'font-family': 'ui-monospace, SFMono-Regular, Menlo, monospace'
      }, copy.focusWidth)
    );
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
    const spaceGradient = svgElement(documentRef, 'radialGradient', {
      id: `${instance.id}-space`,
      cx: '48%',
      cy: '44%',
      r: '78%'
    });
    spaceGradient.append(
      svgElement(documentRef, 'stop', {
        offset: '0%',
        'stop-color': '#102744',
        'stop-opacity': 0.92
      }),
      svgElement(documentRef, 'stop', {
        offset: '38%',
        'stop-color': '#071324',
        'stop-opacity': 0.98
      }),
      svgElement(documentRef, 'stop', {
        offset: '72%',
        'stop-color': '#020812',
        'stop-opacity': 1
      }),
      svgElement(documentRef, 'stop', {
        offset: '100%',
        'stop-color': instance.palette.background,
        'stop-opacity': 1
      })
    );
    const glow = svgElement(documentRef, 'filter', {
      id: `${instance.id}-glow`,
      x: '-80%',
      y: '-80%',
      width: '260%',
      height: '260%'
    });
    glow.appendChild(svgElement(documentRef, 'feGaussianBlur', { stdDeviation: 12 }));
    const nebulaSoft = svgElement(documentRef, 'filter', {
      id: `${instance.id}-nebula-soft`,
      x: '-35%',
      y: '-45%',
      width: '170%',
      height: '190%'
    });
    nebulaSoft.appendChild(svgElement(documentRef, 'feGaussianBlur', { stdDeviation: 7.5 }));
    layout.clusters.forEach((cluster, index) => {
      const color = instance.palette.cluster[index % instance.palette.cluster.length];
      const gradient = svgElement(documentRef, 'radialGradient', {
        id: `${instance.id}-nebula-${index}`,
        cx: `${43 + (stableHash(`${cluster.key}:cx`) % 15)}%`,
        cy: `${39 + (stableHash(`${cluster.key}:cy`) % 17)}%`,
        r: '64%'
      });
      gradient.append(
        svgElement(documentRef, 'stop', {
          offset: '0%',
          'stop-color': instance.palette.text,
          'stop-opacity': 0.54
        }),
        svgElement(documentRef, 'stop', {
          offset: '17%',
          'stop-color': color,
          'stop-opacity': 0.5
        }),
        svgElement(documentRef, 'stop', {
          offset: '48%',
          'stop-color': color,
          'stop-opacity': 0.24
        }),
        svgElement(documentRef, 'stop', {
          offset: '78%',
          'stop-color': color,
          'stop-opacity': 0.07
        }),
        svgElement(documentRef, 'stop', {
          offset: '100%',
          'stop-color': instance.palette.background,
          'stop-opacity': 0
        })
      );
      defs.appendChild(gradient);
    });
    defs.append(
      spaceGradient,
      glow,
      nebulaSoft,
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
      fill: `url(#${instance.id}-space)`,
      'data-atlas-pan-surface': 'true'
    });
    viewport.appendChild(background);

    for (let index = 0; index < 360; index += 1) {
      const x = 16 + (stableHash(`star-x:${index}`) / 4294967295) * (layout.width - 32);
      const y = 16 + (stableHash(`star-y:${index}`) / 4294967295) * (layout.height - 32);
      viewport.appendChild(svgElement(documentRef, 'circle', {
        cx: x.toFixed(2),
        cy: y.toFixed(2),
        r: index % 43 === 0 ? 1.65 : index % 17 === 0 ? 1.15 : index % 5 === 0 ? 0.75 : 0.4,
        fill: index % 31 === 0
          ? instance.palette.focus
          : index % 23 === 0
            ? instance.palette.funds
            : instance.palette.text,
        opacity: 0.12 + (stableHash(`star-o:${index}`) % 58) / 100,
        'pointer-events': 'none'
      }));
    }

    layout.clusters.forEach((cluster, index) => {
      viewport.appendChild(createRegionGroup(instance, cluster, index, documentRef));
    });

    const nearby = instance.focusNeighborhood.neighborIds;
    layout.edges.forEach((edge) => {
      const touchesFocus = instance.state.focusId &&
        (edge.from === instance.state.focusId || edge.to === instance.state.focusId);
      const touchesRegion = instance.state.regionKey &&
        (edge.source.clusterKey === instance.state.regionKey ||
          edge.target.clusterKey === instance.state.regionKey);
      const isConnected = instance.state.focusId
        ? touchesFocus
        : instance.state.regionKey
          ? touchesRegion
          : true;
      const dx = edge.target.x - edge.source.x;
      const dy = edge.target.y - edge.source.y;
      const curve = ((stableHash(edge.id) % 31) - 15) / 100;
      const controlX = (edge.source.x + edge.target.x) / 2 - dy * curve;
      const controlY = (edge.source.y + edge.target.y) / 2 + dx * curve;
      const color = edgeColor(instance, edge.flowKind);
      const pathData = `M ${edge.source.x} ${edge.source.y} Q ${controlX} ${controlY} ${edge.target.x} ${edge.target.y}`;
      const selectionEmphasis = Boolean(touchesFocus || (!instance.state.focusId && touchesRegion));
      const strokeWidth = edgeStrokeWidth(edge, 1.2, selectionEmphasis);
      if (selectionEmphasis) {
        viewport.appendChild(svgElement(documentRef, 'path', {
          d: pathData,
          fill: 'none',
          stroke: color,
          'stroke-width': strokeWidth + 5,
          'stroke-linecap': 'round',
          opacity: instance.state.focusId && !isConnected ? 0.02 : 0.1,
          filter: `url(#${instance.id}-glow)`,
          'aria-hidden': 'true'
        }));
      }
      const path = svgElement(documentRef, 'path', {
        d: pathData,
        fill: 'none',
        stroke: color,
        'stroke-width': strokeWidth,
        'stroke-linecap': 'round',
        'stroke-dasharray': edge.flowKind === 'funds' ? '7 5' : edge.flowKind === 'evidence' ? '3 5' : '0',
        opacity: !isConnected ? 0.05 : edge.evidenceStatus?.startsWith('disclosed') ? 0.78 : 0.42,
        'marker-end': `url(#${instance.id}-${edge.flowKind})`,
        'data-atlas-edge': edge.id,
        'data-visual-salience': edge.visualSalience?.status || 'focus-only',
        'data-selection-emphasis': selectionEmphasis ? 'true' : 'false'
      });
      path.appendChild(svgElement(
        documentRef,
        'title',
        {},
        `${edge.source.name} → ${edge.target.name} · ${edgeSalienceLabel(instance, edge)}`
      ));
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
      const strokeWidth = edgeStrokeWidth(
        edge,
        1.75,
        Boolean(instance.state.focusId && connected)
      );
      const path = svgElement(documentRef, 'path', {
        d: edge.path,
        fill: 'none',
        stroke: color,
        'stroke-width': strokeWidth,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        'stroke-dasharray': edge.flowKind === 'funds' ? '9 6' : edge.flowKind === 'evidence' ? '3 5' : '0',
        opacity: connected ? 0.88 : 0.18,
        'marker-end': `url(#${instance.id}-${edge.flowKind})`,
        'data-atlas-edge': edge.id,
        'data-flow-kind': edge.flowKind,
        'data-visual-salience': edge.visualSalience?.status || 'focus-only',
        'data-selection-emphasis': instance.state.focusId && connected ? 'true' : 'false'
      });
      const amount = edge.amount != null || edge.value != null
        ? String(edge.amount ?? edge.value)
        : copy.amountUnknown;
      path.appendChild(svgElement(
        documentRef,
        'title',
        {},
        `${edge.source.name} → ${edge.target.name} · ${edge.type || copy.evidenceLink} · ${amount} · ${edgeSalienceLabel(instance, edge)}`
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
    const initialFocusEntity = settings.focusId
      ? graph.entities.find((entity) => entity.id === settings.focusId) || null
      : null;
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
        focusId: initialFocusEntity?.id || null,
        regionKey: settings.regionKey || (
          initialFocusEntity ? entityCluster(initialFocusEntity) : null
        ),
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
        if (this.state.regionKey &&
          !this.graph.entities.some((entity) => entityCluster(entity) === this.state.regionKey)) {
          this.state.regionKey = null;
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
        if (normalized && this.mode === 'starfield') {
          const entity = this.graph.entities.find((item) => item.id === normalized);
          this.state.regionKey = entity ? entityCluster(entity) : this.state.regionKey;
        }
        this.render();
        if (this.mode === 'starfield') {
          if (normalized && this.options.autoZoomOnFocus !== false) this.zoomToNode(normalized);
          else if (this.state.regionKey) this.zoomToRegion(this.state.regionKey);
          else this.fit();
        }
        if (notify && typeof this.options.onFocusChange === 'function') {
          this.options.onFocusChange({
            ...this.focusNeighborhood,
            focusId: normalized
          });
        }
        return this;
      },

      setRegion(regionKey, notify) {
        if (this.destroyed || this.mode !== 'starfield') return this;
        const normalized = regionKey &&
          this.graph.entities.some((entity) => entityCluster(entity) === regionKey)
          ? String(regionKey)
          : null;
        this.state.regionKey = normalized;
        this.options.regionKey = normalized;
        if (normalized && this.state.focusId) {
          const focus = this.graph.entities.find((entity) => entity.id === this.state.focusId);
          if (!focus || entityCluster(focus) !== normalized) {
            this.state.focusId = null;
            this.options.focusId = null;
          }
        }
        this.render();
        if (normalized) this.zoomToRegion(normalized);
        else if (this.state.focusId) this.zoomToNode(this.state.focusId);
        else this.fit();
        if (notify && typeof this.options.onRegionChange === 'function') {
          this.options.onRegionChange({
            regionKey: normalized,
            entities: normalized
              ? this.graph.entities.filter((entity) => entityCluster(entity) === normalized)
              : []
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
          if (this.state.focusId && this.mode === 'starfield') {
            const focus = this.graph.entities.find((entity) => entity.id === this.state.focusId);
            this.state.regionKey = focus ? entityCluster(focus) : this.state.regionKey;
          }
        }
        this.render();
        if (this.mode === 'starfield' && this.state.focusId && this.options.autoZoomOnFocus !== false) {
          this.zoomToNode(this.state.focusId);
        }
        return this;
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

      zoomToNode(nodeId, scale) {
        if (this.destroyed || this.mode !== 'starfield') return this;
        const node = this.layout?.nodes?.find((item) => item.id === nodeId);
        if (!node) return this;
        const nextScale = clamp(
          finiteNumber(scale, 2.25),
          finiteNumber(this.options.minScale, DEFAULTS.minScale),
          finiteNumber(this.options.maxScale, DEFAULTS.maxScale)
        );
        this.transform.scale = nextScale;
        this.transform.x = this.layout.width / 2 - node.x * nextScale;
        this.transform.y = this.layout.height / 2 - node.y * nextScale;
        this.applyTransform();
        return this;
      },

      zoomToRegion(regionKey) {
        if (this.destroyed || this.mode !== 'starfield') return this;
        const region = this.layout?.clusters?.find((cluster) => cluster.key === regionKey);
        if (!region) return this;
        const horizontal = this.layout.width / Math.max(1, region.rx * 2 + 180);
        const vertical = this.layout.height / Math.max(1, region.ry * 2 + 120);
        const nextScale = clamp(
          Math.min(horizontal, vertical),
          Math.max(1.12, finiteNumber(this.options.minScale, DEFAULTS.minScale)),
          Math.min(2.75, finiteNumber(this.options.maxScale, DEFAULTS.maxScale))
        );
        this.transform.scale = nextScale;
        this.transform.x = this.layout.width / 2 - region.x * nextScale;
        this.transform.y = this.layout.height / 2 - region.y * nextScale;
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
          regionKey: this.state.regionKey,
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
    if (instance.mode === 'starfield' && instance.state.focusId &&
      instance.options.autoZoomOnFocus !== false) {
      instance.zoomToNode(instance.state.focusId);
    } else if (instance.mode === 'starfield' && instance.state.regionKey) {
      instance.zoomToRegion(instance.state.regionKey);
    }

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
