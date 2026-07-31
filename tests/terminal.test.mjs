import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEED_PATH = 'assets/data/atlas-seed.json';
const I18N_PATH = 'assets/yc-i18n.js';

const terminalPages = [
  {
    file: 'terminal.html',
    htmlLang: 'zh-Hant',
    terminalLang: 'tw',
    titleToken: '易終端',
    navLabel: '易終端',
    assetPrefix: 'assets/',
  },
  {
    file: 'cn/terminal.html',
    htmlLang: 'zh-Hans',
    terminalLang: 'cn',
    titleToken: '易终端',
    navLabel: '易终端',
    assetPrefix: '../assets/',
  },
  {
    file: 'en/terminal.html',
    htmlLang: 'en',
    terminalLang: 'en',
    titleToken: 'Terminal',
    navLabel: 'Terminal',
    assetPrefix: '../assets/',
  },
];

let seedPromise;

function readText(relativePath) {
  return readFile(path.join(ROOT, relativePath), 'utf8');
}

function loadSeed() {
  seedPromise ??= readText(SEED_PATH).then((source) => JSON.parse(source));
  return seedPromise;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function attribute(tag, name) {
  const match = tag.match(
    new RegExp(`\\b${escapeRegExp(name)}\\s*=\\s*(["'])(.*?)\\1`, 'i'),
  );
  return match?.[2] ?? null;
}

function classNames(tag) {
  return new Set((attribute(tag, 'class') ?? '').split(/\s+/).filter(Boolean));
}

function anchorTags(html) {
  return [...html.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)].map((match) => match[0]);
}

function textContent(fragment) {
  return fragment
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function resourceTags(html, tagName) {
  return [...html.matchAll(new RegExp(`<${tagName}\\b[^>]*>`, 'gi'))].map(
    (match) => match[0],
  );
}

function isRemoteResource(reference) {
  return /^(?:[a-z]+:)?\/\//i.test(reference) || reference.startsWith('data:');
}

function nearlyEqual(actual, expected, message) {
  const scale = Math.max(1, Math.abs(actual), Math.abs(expected));
  assert.ok(
    Math.abs(actual - expected) <= scale * 1e-9,
    `${message}: expected ${expected}, received ${actual}`,
  );
}

function metricValue(rows, metric, context) {
  assert.ok(Array.isArray(rows), `${context} must be an array`);
  const matches = rows.filter((row) => row.metric === metric);
  assert.equal(matches.length, 1, `${context} must contain one ${metric} metric`);
  assert.ok(
    Number.isFinite(matches[0].value),
    `${context}.${metric} must contain a finite numeric value`,
  );
  return matches[0].value;
}

async function listHtmlFiles(directory = ROOT) {
  const found = [];
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await listHtmlFiles(absolutePath)));
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      found.push(path.relative(ROOT, absolutePath).split(path.sep).join('/'));
    }
  }

  return found.sort();
}

function expectedTerminalHref(relativeHtmlPath) {
  const parts = relativeHtmlPath.split('/');
  const localeRoot = parts[0] === 'cn' || parts[0] === 'en' ? parts[0] : '';
  const target = localeRoot ? `${localeRoot}/terminal.html` : 'terminal.html';
  return path.posix
    .relative(path.posix.dirname(relativeHtmlPath), target)
    .replace(/\.html$/, '');
}

function collectSourceReferences(value, trail = '$', output = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectSourceReferences(item, `${trail}[${index}]`, output),
    );
    return output;
  }

  if (!value || typeof value !== 'object') return output;

  for (const [key, child] of Object.entries(value)) {
    const childTrail = `${trail}.${key}`;
    if (key === 'sourceId') {
      output.push({ sourceId: child, trail: childTrail });
    } else if (key === 'sourceIds') {
      assert.ok(Array.isArray(child), `${childTrail} must be an array`);
      child.forEach((sourceId, index) =>
        output.push({ sourceId, trail: `${childTrail}[${index}]` }),
      );
    } else {
      collectSourceReferences(child, childTrail, output);
    }
  }

  return output;
}

test('the three localized Terminal pages have the correct shell and asset paths', async (t) => {
  for (const page of terminalPages) {
    await t.test(page.file, async () => {
      const html = await readText(page.file);
      const htmlOpen = html.match(/<html\b[^>]*>/i)?.[0];
      assert.ok(htmlOpen, `${page.file} must contain an html element`);
      assert.equal(attribute(htmlOpen, 'lang'), page.htmlLang);

      const title = textContent(html.match(/<title\b[^>]*>[\s\S]*?<\/title>/i)?.[0] ?? '');
      assert.ok(title.includes(page.titleToken), `${page.file} title must contain ${page.titleToken}`);
      assert.match(title, /Yi\s*Capital/i, `${page.file} title must identify YiCapital`);

      const bodyOpen = html.match(/<body\b[^>]*>/i)?.[0];
      assert.ok(bodyOpen, `${page.file} must contain a body element`);
      assert.equal(
        attribute(bodyOpen, 'data-terminal-lang'),
        page.terminalLang,
        `${page.file} must declare its Terminal locale`,
      );

      const anchors = anchorTags(html);
      const homeMarks = anchors.filter((anchor) =>
        classNames(anchor).has('terminal-home-mark'),
      );
      assert.equal(homeMarks.length, 1, `${page.file} must contain one compact Terminal home mark`);
      assert.equal(attribute(homeMarks[0], 'href'), 'terminal');
      assert.equal(textContent(homeMarks[0]), 'YC');
      assert.doesNotMatch(
        html,
        /class=(["'])[^"']*\bterminal-site-header\b[^"']*\1/i,
        `${page.file} must not render the large website navigation inside Terminal`,
      );
      assert.equal(
        anchors.filter((anchor) => attribute(anchor, 'data-i18n') === 'nav.terminal').length,
        0,
        `${page.file} must not duplicate Terminal as a large navigation tab`,
      );
      const searchInput = html.match(/<input\b[^>]*id=["']terminal-search["'][^>]*>/i)?.[0];
      assert.ok(searchInput, `${page.file} must contain the global Terminal search`);
      assert.equal(attribute(searchInput, 'role'), 'combobox');
      assert.equal(attribute(searchInput, 'aria-haspopup'), 'listbox');

      const styles = resourceTags(html, 'link')
        .filter((tag) => (attribute(tag, 'rel') ?? '').split(/\s+/).includes('stylesheet'))
        .map((tag) => attribute(tag, 'href'))
        .filter(Boolean);
      const scripts = resourceTags(html, 'script')
        .map((tag) => attribute(tag, 'src'))
        .filter(Boolean);

      const expectedStyles = ['style.css', 'terminal-v2.css'].map(
        (file) => page.assetPrefix + file,
      );
      const expectedScripts = [
        'portal-config.js',
        'yc-i18n.js',
        'yc-atlas-visuals.js',
        'yc-terminal-v2.js',
      ].map((file) => page.assetPrefix + file);

      for (const expected of expectedStyles) {
        assert.ok(
          styles.some((reference) => reference.split(/[?#]/, 1)[0] === expected),
          `${page.file} must load ${expected}`,
        );
      }
      for (const expected of expectedScripts) {
        assert.ok(
          scripts.some((reference) => reference.split(/[?#]/, 1)[0] === expected),
          `${page.file} must load ${expected}`,
        );
      }

      for (const reference of [...styles, ...scripts].filter(
        (item) => !isRemoteResource(item),
      )) {
        const cleanReference = reference.split(/[?#]/, 1)[0];
        const resolved = path.resolve(path.dirname(path.join(ROOT, page.file)), cleanReference);
        assert.ok(
          resolved === ROOT || resolved.startsWith(`${ROOT}${path.sep}`),
          `${page.file} resource escapes the site root: ${reference}`,
        );
        await access(resolved);
      }
    });
  }
});

test('site navigation links use the correct Terminal route depth and Terminal stays search-first', async () => {
  const htmlFiles = await listHtmlFiles();
  const legacyContactLabels = new Set(['聯繫我們', '联系我们']);
  let terminalLinkCount = 0;
  let terminalUtilityNavCount = 0;
  const legacyContacts = [];

  for (const relativePath of htmlFiles) {
    const html = await readText(relativePath);
    for (const anchor of anchorTags(html)) {
      const key = attribute(anchor, 'data-i18n');
      const label = textContent(anchor);

      if (key === 'nav.terminal') {
        terminalLinkCount += 1;
        assert.equal(
          attribute(anchor, 'href'),
          expectedTerminalHref(relativePath),
          `${relativePath} has an incorrect Terminal link depth`,
        );
      }
      if (key === 'nav.about') {
        if (/(^|\/)terminal\.html$/.test(relativePath)) terminalUtilityNavCount += 1;
      }
      if (legacyContactLabels.has(label) || /^contact$/i.test(label)) {
        legacyContacts.push(`${relativePath}: ${label}`);
      }
    }
  }

  assert.ok(terminalLinkCount > 0, 'the site must expose at least one nav.terminal link');
  assert.equal(terminalUtilityNavCount, 0, 'Terminal pages must not restore the website navigation');
  assert.deepEqual(legacyContacts, [], 'legacy Contact labels must be removed from HTML');
});

test('i18n recognizes Terminal and preserves query parameters before the hash', async () => {
  const source = await readText(I18N_PATH);
  const tripledMatch = source.match(/const\s+TRIPLED\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(tripledMatch, 'yc-i18n.js must declare TRIPLED');
  const tripledPages = [...tripledMatch[1].matchAll(/['"]([^'"]+)['"]/g)].map(
    (match) => match[1],
  );
  assert.ok(tripledPages.includes('terminal'), 'TRIPLED must include terminal');
  assert.match(
    source,
    /'ut\.contact'\s*:\s*\[\s*'關於我們'\s*,\s*'关于我们'\s*,\s*'ABOUT'\s*\]/,
  );

  const location = {
    pathname: '/cn/terminal.html',
    search: '?year=2025&company=nvda',
    hash: '#network',
    href: '',
  };
  const storageWrites = [];
  const sandbox = {
    document: {
      readyState: 'loading',
      createElement: () => ({}),
      head: { appendChild: () => {} },
      addEventListener: () => {},
    },
    localStorage: {
      setItem: (...args) => storageWrites.push(args),
    },
    location,
    window: {},
  };

  vm.runInNewContext(source, sandbox, { filename: I18N_PATH });
  sandbox.window.YCI.set('en');

  assert.equal(
    location.href,
    '/en/terminal?year=2025&company=nvda#network',
    'the language switch must preserve search before hash',
  );
  assert.deepEqual(storageWrites, [['yc-lang', 'en']]);
});

test('Terminal v2 uses the production API contract and fails closed without synthetic facts', async () => {
  const source = await readText('assets/yc-terminal-v2.js');
  assert.match(source, /window\.YC_API/);
  assert.match(source, /\/api\/terminal\/bootstrap/);
  assert.match(source, /\/api\/terminal\/stock-detail/);
  assert.match(source, /domain:\s*'Stocks'/);
  assert.match(source, /dataset:\s*'index_global'/);
  assert.match(source, /assetForSelection\(\)/);
  assert.match(source, /selectedYearRange\(\)/);
  assert.match(source, /validateAtlas\(seed\)/);
  assert.match(source, /is_complete\s*===\s*false/);
  assert.match(source, /activeFunction\.loader\s*===\s*['"]unavailable['"]/);
  assert.match(source, /return records\[state\.year\]\s*\|\|\s*null/);
  assert.match(source, /disclosedTitle\s*\|\|\s*disclosedBody/);
  assert.match(source, /newsRows\(newsResult\.data,\s*newsResult\.meta\?\.source/);
  assert.match(source, /TUSHARE \+ YICAPITAL WAREHOUSE/);
  assert.match(source, /endpoint:\s*'warehouse\.stockDetail'/);
  assert.match(source, /source:\s*'YICAPITAL WAREHOUSE'/);
  assert.doesNotMatch(source, /TUSHARE \/ WAREHOUSE/);
  assert.match(source, /replaceChildren\(/);
  assert.match(source, /setAttribute\('role',\s*'tab'\)/);
  for (const code of ['DES', 'RES', 'FA', 'MODL', 'SPLC', 'GP', 'HP', 'VAL', 'VWAP', 'AVAT']) {
    assert.match(source, new RegExp(`['\"]${code}['\"]`), `missing stock function ${code}`);
  }
  assert.doesNotMatch(source, /\.innerHTML\s*=/);
  assert.doesNotMatch(source, /synthetic|sampleQuote|fallbackPrice/i);
  assert.doesNotMatch(source, /return match \|\| state\.entityMap\.get\(['"]nvda['"]\)/);
  assert.doesNotMatch(source, /28 家候選|28 家候选|processing 28 candidate/);
});

test('atlas seed parses and every sourceId resolves to a declared source', async () => {
  const seed = await loadSeed();
  assert.equal(typeof seed, 'object');
  assert.ok(Array.isArray(seed.sources));

  const sourceIds = seed.sources.map((source) => source.id);
  assert.equal(new Set(sourceIds).size, sourceIds.length, 'source ids must be unique');
  const knownSources = new Set(sourceIds);
  const references = collectSourceReferences(seed);
  assert.ok(references.length > 0, 'the seed must contain source references');

  for (const reference of references) {
    assert.equal(
      typeof reference.sourceId,
      'string',
      `${reference.trail} must be a string`,
    );
    assert.ok(
      knownSources.has(reference.sourceId),
      `${reference.trail} does not resolve: ${reference.sourceId}`,
    );
  }
});

test('atlas relationships have valid endpoints and disclosed evidence has a source', async () => {
  const seed = await loadSeed();
  assert.ok(Array.isArray(seed.entities));
  assert.ok(Array.isArray(seed.relationships));

  const entityIds = seed.entities.map((entity) => entity.id);
  assert.equal(new Set(entityIds).size, entityIds.length, 'entity ids must be unique');
  const knownEntities = new Set(entityIds);
  const knownSources = new Set(seed.sources.map((source) => source.id));

  for (const relationship of seed.relationships) {
    assert.ok(
      knownEntities.has(relationship.from),
      `${relationship.id}.from does not resolve: ${relationship.from}`,
    );
    assert.ok(
      knownEntities.has(relationship.to),
      `${relationship.id}.to does not resolve: ${relationship.to}`,
    );
    assert.equal(
      relationship.amountStatus,
      'relationship-only',
      `${relationship.id} must not imply a known amount`,
    );
    assert.ok(
      Array.isArray(relationship.validCanonicalYears) &&
        relationship.validCanonicalYears.length > 0,
      `${relationship.id} must be explicitly year-scoped`,
    );
    if (/disclosed/i.test(relationship.evidenceStatus ?? '')) {
      assert.ok(
        relationship.sourceId,
        `${relationship.id} is disclosed but has no sourceId`,
      );
      for (const year of relationship.validCanonicalYears) {
        const sourceId = relationship.evidenceByCanonicalYear?.[String(year)];
        assert.ok(sourceId, `${relationship.id} lacks evidence for ${year}`);
        assert.ok(knownSources.has(sourceId), `${relationship.id} ${year} source does not resolve`);
      }
    }
  }
});

test('financial flows, balance sheets, and equity bridges reconcile', async () => {
  const seed = await loadSeed();
  const knownEntities = new Set(seed.entities.map((entity) => entity.id));
  const financialCompanies = Object.entries(seed.financials ?? {});
  assert.ok(financialCompanies.length > 0, 'the seed must contain financial actuals');

  for (const [companyId, years] of financialCompanies) {
    assert.ok(knownEntities.has(companyId), `financial company does not resolve: ${companyId}`);
    const orderedYears = Object.entries(years).sort(
      ([, left], [, right]) => left.canonicalYear - right.canonicalYear,
    );
    let previousClosingEquity = null;
    let previousCanonicalYear = null;

    for (const [yearKey, record] of orderedYears) {
      const context = `${companyId}.${yearKey}`;
      assert.equal(String(record.canonicalYear), yearKey, `${context} canonicalYear mismatch`);

      const { revenue, costOfRevenue, operatingExpenses, operatingIncome } = record.flow;
      for (const [metric, value] of Object.entries(record.flow)) {
        assert.ok(Number.isFinite(value), `${context}.flow.${metric} must be finite`);
        nearlyEqual(
          value,
          metricValue(record.income, metric, `${context}.income`),
          `${context}.flow.${metric} must match income`,
        );
      }
      nearlyEqual(
        revenue - costOfRevenue - operatingExpenses,
        operatingIncome,
        `${context} operating flow does not reconcile`,
      );

      const assets = metricValue(record.balance, 'assets', `${context}.balance`);
      const liabilities = metricValue(record.balance, 'liabilities', `${context}.balance`);
      const balanceEquity = metricValue(
        record.balance,
        'stockholdersEquity',
        `${context}.balance`,
      );
      nearlyEqual(
        assets,
        liabilities + balanceEquity,
        `${context} balance sheet does not reconcile`,
      );

      const openingEquity = metricValue(record.equity, 'openingEquity', `${context}.equity`);
      const closingEquity = metricValue(record.equity, 'closingEquity', `${context}.equity`);
      const equityMovements = record.equity
        .filter((row) => row.metric !== 'openingEquity' && row.metric !== 'closingEquity')
        .reduce((sum, row) => {
          assert.ok(Number.isFinite(row.value), `${context}.equity.${row.metric} must be finite`);
          return sum + row.value;
        }, 0);
      nearlyEqual(
        openingEquity + equityMovements,
        closingEquity,
        `${context} equity bridge does not reconcile`,
      );
      nearlyEqual(
        closingEquity,
        balanceEquity,
        `${context} closing equity must match the balance sheet`,
      );

      if (
        previousClosingEquity !== null
        && record.canonicalYear === previousCanonicalYear + 1
      ) {
        nearlyEqual(
          openingEquity,
          previousClosingEquity,
          `${context} opening equity must match the prior closing equity`,
        );
      }
      previousClosingEquity = closingEquity;
      previousCanonicalYear = record.canonicalYear;
    }
  }
});

test('coverage metadata equals the counts in the published seed', async () => {
  const seed = await loadSeed();
  const graphCoverage = seed.coverage?.graph;
  const financialCoverage = seed.coverage?.financialActuals;
  assert.ok(graphCoverage, 'coverage.graph is required');
  assert.ok(financialCoverage, 'coverage.financialActuals is required');

  const financialCompanies = Object.values(seed.financials ?? {});
  const canonicalYearCount = financialCompanies.reduce(
    (total, years) => total + Object.keys(years).length,
    0,
  );
  const directDisclosedRelationshipCount = seed.relationships.filter(
    (relationship) => /disclosed/i.test(relationship.evidenceStatus ?? ''),
  ).length;

  assert.equal(graphCoverage.entityCount, seed.entities.length);
  assert.equal(graphCoverage.relationshipCount, seed.relationships.length);
  assert.equal(
    graphCoverage.directDisclosedRelationshipCount,
    directDisclosedRelationshipCount,
  );
  assert.equal(financialCoverage.companyCount, financialCompanies.length);
  assert.equal(financialCoverage.canonicalYearCount, canonicalYearCount);
});
