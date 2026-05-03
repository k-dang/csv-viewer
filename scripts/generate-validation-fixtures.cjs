const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const fixtureDir = path.join(__dirname, '..', 'fixtures', 'validation');
mkdirSync(fixtureDir, { recursive: true });

writeLargeFixture(path.join(fixtureDir, 'large-rows.csv'), 100000);
writeWideFixture(path.join(fixtureDir, 'wide-columns.csv'), 180);
writeFileSync(
  path.join(fixtureDir, 'quoted-fields.csv'),
  ['id,note', '1,"contains commas, quotes ""inside"", and text"', '2,"plain"'].join('\n'),
);
writeFileSync(path.join(fixtureDir, 'malformed.csv'), ['id,note', '1,"unterminated'].join('\n'));
writeFileSync(
  path.join(fixtureDir, 'unusual-columns.csv'),
  ['"full name","select","quote""name"', '"Ada Lovelace","alpha","safe"', '"Grace Hopper","beta","unsafe"'].join('\n'),
);

console.log(`Validation fixtures written to ${fixtureDir}`);
console.log('Manual Phase 7 path: open large-rows.csv, scroll near the end, open wide-columns.csv, then test quoted, malformed, and unusual-column-name files.');

function writeLargeFixture(filePath, rowCount) {
  const lines = ['id,name,score,created_at,note'];

  for (let index = 0; index < rowCount; index += 1) {
    lines.push(
      [
        index,
        `Person ${index}`,
        index % 1000,
        `2025-01-${String((index % 28) + 1).padStart(2, '0')}`,
        `"row ${index}, quoted text"`,
      ].join(','),
    );
  }

  writeFileSync(filePath, lines.join('\n'));
}

function writeWideFixture(filePath, columnCount) {
  const headers = Array.from({ length: columnCount }, (_value, index) => `metric_${index}`);
  const rows = [headers.join(',')];

  for (let rowIndex = 0; rowIndex < 100; rowIndex += 1) {
    rows.push(headers.map((_header, columnIndex) => rowIndex * columnCount + columnIndex).join(','));
  }

  writeFileSync(filePath, rows.join('\n'));
}
