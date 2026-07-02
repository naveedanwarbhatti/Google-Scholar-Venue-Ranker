const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

async function runDblpVenueCatalogTests() {
  const { generateDblpVenueCatalog, normalizeVenueAlias } = await import('../../scripts/generate_dblp_venue_catalog.mjs');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsvr-dblp-venues-'));
  const xmlPath = path.join(tmpDir, 'dblp.xml');
  fs.writeFileSync(xmlPath, `<?xml version="1.0" encoding="UTF-8"?>
<dblp>
<article key="journals/tods/Smith24">
  <author>Alice Smith</author>
  <title>Journal paper.</title>
  <year>2024</year>
  <journal>ACM Transactions on Database Systems</journal>
</article>
<inproceedings key="conf/icse/Jones23">
  <author>Bob Jones</author>
  <title>Conference paper.</title>
  <year>2023</year>
  <booktitle>ICSE</booktitle>
</inproceedings>
<inproceedings key="conf/sensys/Wang20">
  <author>Chen Wang</author>
  <title>Workshop paper.</title>
  <year>2020</year>
  <booktitle>ENSsys@SenSys</booktitle>
</inproceedings>
<inproceedings key="conf/sensys/Li21">
  <author>De Li</author>
  <title>Main conference paper.</title>
  <year>2021</year>
  <booktitle>SenSys</booktitle>
</inproceedings>
<proceedings key="conf/middleware/DICG22">
  <title>Proceedings of the 3rd International Workshop on Distributed Infrastructure for Common Good, DICG@Middleware 2022, Quebec, Canada</title>
  <year>2022</year>
  <booktitle>DICG@Middleware</booktitle>
</proceedings>
<proceedings key="conf/middleware/Middleware00">
  <title>Middleware 2000, IFIP/ACM International Conference on Distributed Systems Platforms, New York, NY, USA, April 4-7, 2000, Proceedings</title>
  <year>2000</year>
  <booktitle>Middleware</booktitle>
</proceedings>
<proceedings key="conf/icwsm/ICWSM25">
  <title>Proceedings of the International AAAI Conference on Web and Social Media, ICWSM 2025, Copenhagen, Denmark</title>
  <year>2025</year>
  <booktitle>ICWSM</booktitle>
</proceedings>
<proceedings key="conf/www/WWW26">
  <title>Proceedings of the ACM Web Conference 2026, WWW 2026, Dubai, United Arab Emirates</title>
  <year>2026</year>
  <booktitle>WWW</booktitle>
</proceedings>
<proceedings key="conf/podc/PODC82">
  <title>ACM SIGACT-SIGOPS Symposium on Principles of Distributed Computing, Ottawa, Canada, August 18-20, 1982</title>
  <year>1982</year>
  <booktitle>PODC</booktitle>
</proceedings>
</dblp>
`);

  const catalog = await generateDblpVenueCatalog({ xmlPath });
  const entries = catalog.entries.map(([id, type, title, shortName, aliases, flags, yearStart, yearEnd, count]) => ({
    id, type, title, shortName, aliases, flags, yearStart, yearEnd, count,
  }));

  const journal = entries.find((entry) => entry.id === 'journals/tods');
  assert.ok(journal, 'Expected TODS journal entry');
  assert.strictEqual(journal.type, 'journal');
  assert.ok(catalog.aliases[normalizeVenueAlias('ACM Transactions on Database Systems')].includes(catalog.entries.findIndex((entry) => entry[0] === 'journals/tods')));

  const conference = entries.find((entry) => entry.id === 'conf/icse');
  assert.ok(conference, 'Expected ICSE conference entry');
  assert.strictEqual(conference.type, 'conference');
  assert.strictEqual(conference.yearStart, 2023);
  assert.strictEqual(conference.yearEnd, 2023);

  const parentConference = entries.find((entry) => entry.id === 'conf/sensys');
  assert.ok(parentConference, 'Expected SenSys parent conference entry');
  assert.strictEqual(parentConference.type, 'conference');

  const workshop = entries.find((entry) => entry.id.startsWith('conf/sensys#enssys'));
  assert.ok(workshop, 'Expected ENSsys workshop entry separate from parent series');
  assert.strictEqual(workshop.type, 'workshop');
  assert.ok(workshop.flags.includes('workshop'));
  assert.ok(workshop.aliases.includes('ENSsys'), 'Expected short workshop alias from @ notation');

  const dicg = entries.find((entry) => entry.id === 'conf/middleware#dicg-middleware');
  assert.ok(dicg, 'Expected DICG workshop entry');
  assert.strictEqual(dicg.type, 'workshop');
  assert.ok(
    dicg.aliases.includes('International Workshop on Distributed Infrastructure for Common Good'),
    'Expected expanded DICG alias extracted from proceedings title'
  );
  assert.ok(
    catalog.aliases[normalizeVenueAlias('International Workshop on Distributed Infrastructure for Common Good')].includes(catalog.entries.findIndex((entry) => entry[0] === dicg.id)),
    'Expected normalized expanded DICG alias in catalog index'
  );

  const middleware = entries.find((entry) => entry.id === 'conf/middleware');
  assert.ok(middleware, 'Expected Middleware conference entry');
  assert.ok(
    middleware.aliases.includes('IFIP/ACM International Conference on Distributed Systems Platforms'),
    'Expected old Middleware proceedings-title alias'
  );
  assert.ok(
    catalog.aliases[normalizeVenueAlias('IFIP/ACM International Conference on Distributed Systems Platforms')].includes(catalog.entries.findIndex((entry) => entry[0] === middleware.id)),
    'Expected normalized old Middleware alias in catalog index'
  );

  const icwsm = entries.find((entry) => entry.id === 'conf/icwsm');
  assert.ok(icwsm, 'Expected ICWSM conference entry');
  assert.ok(
    icwsm.aliases.includes('International AAAI Conference on Web and Social Media'),
    'Expected ICWSM proceedings title alias'
  );

  const www = entries.find((entry) => entry.id === 'conf/www');
  assert.ok(www, 'Expected WWW conference entry');
  assert.ok(
    www.aliases.includes('ACM Web Conference'),
    'Expected ACM Web Conference proceedings title alias'
  );

  const podc = entries.find((entry) => entry.id === 'conf/podc');
  assert.ok(podc, 'Expected PODC conference entry');
  assert.ok(
    podc.aliases.includes('ACM SIGACT-SIGOPS Symposium on Principles of Distributed Computing'),
    'Expected old PODC proceedings-title alias'
  );
  assert.ok(
    catalog.aliases[normalizeVenueAlias('ACM SIGACT-SIGOPS Symposium on Principles of Distributed Computing')].includes(catalog.entries.findIndex((entry) => entry[0] === podc.id)),
    'Expected normalized old PODC alias in catalog index'
  );

  assert.strictEqual(
    normalizeVenueAlias('Future Generation Computer Systems 107, 770-780'),
    normalizeVenueAlias('Future Gener. Comput. Syst.'),
    'Citation suffixes should be stripped before abbreviation expansion'
  );
  assert.strictEqual(
    normalizeVenueAlias('Future Generation Computer Systems 2020'),
    normalizeVenueAlias('Future Gener. Comput. Syst.'),
    'Trailing years should be stripped before matching'
  );
  assert.strictEqual(
    normalizeVenueAlias('Proceedings of the 2023 ACM on Internet Measurement Conference, 391-405'),
    'acm on internet measurement conference',
    'Embedded publication years and page ranges should be stripped from proceedings venue lines'
  );
  assert.strictEqual(
    normalizeVenueAlias('Proceedings of the ACM on Measurement and Analysis of Computing Systems 9 (3 …'),
    'acm on measurement and analysis of computing systems',
    'Truncated volume/issue suffixes should be stripped from journal venue lines'
  );

  console.log(`DBLP venue catalog tests passed (${entries.length} venues).`);
}

if (require.main === module) {
  runDblpVenueCatalogTests().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { runDblpVenueCatalogTests };
