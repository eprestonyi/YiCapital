import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf(`  function ${name}(`);
  assert.notEqual(start, -1, `${name} not found`);
  const brace = source.indexOf('{', start);
  let depth = 0;
  for (let index = brace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

test('A-share common closes render as one finite ordinal path across calendar gaps', async () => {
  const source = await read('assets/yc-entry.js');
  const commands = [];
  const drawingContext = {
    save() {},
    restore() {},
    beginPath() {},
    stroke() {},
    moveTo(x, y) { commands.push(['moveTo', x, y]); },
    lineTo(x, y) { commands.push(['lineTo', x, y]); },
  };
  const sandbox = { context: drawingContext };
  vm.runInNewContext(
    `${extractFunction(source, 'pointAtPosition')}
     ${extractFunction(source, 'pathSeries')}
     globalThis.pointAtPosition = pointAtPosition;
     globalThis.pathSeries = pathSeries;`,
    sandbox,
  );
  const points = [
    { date: '2026-07-09', time: Date.UTC(2026, 6, 9), value: 100, position: 0 },
    { date: '2026-07-10', time: Date.UTC(2026, 6, 10), value: 101, position: 1 },
    { date: '2026-07-17', time: Date.UTC(2026, 6, 17), value: 104, position: 2 },
    { date: '2026-07-20', time: Date.UTC(2026, 6, 20), value: 103, position: 3 },
  ];
  const midpoint = sandbox.pointAtPosition(points, 1.5);
  assert.equal(midpoint.position, 1.5);
  assert.equal(midpoint.value, 102.5);
  assert.equal(Number.isFinite(midpoint.time), true);

  const last = sandbox.pathSeries(points, 0.25, 2.75, x => x * 100, y => 300 - y, '#f24545', 2.4, false);
  assert.equal(last.position, 2.75);
  assert.equal(commands.filter(command => command[0] === 'moveTo').length, 1);
  assert.ok(commands.filter(command => command[0] === 'lineTo').length >= 3);
  commands.flatMap(command => command.slice(1)).forEach(value => assert.equal(Number.isFinite(value), true));
});
