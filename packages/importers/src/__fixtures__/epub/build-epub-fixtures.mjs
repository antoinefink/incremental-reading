/**
 * Build the small `.epub` fixtures used by the EPUB importer tests (T067).
 *
 * Run with `node build-epub-fixtures.mjs` from this directory. It writes three
 * tiny, committed `.epub` files (built with `fflate.zipSync`):
 *
 *   - `epub3-three-chapters.epub` — an EPUB3 with an XHTML nav + 3 spine chapters,
 *     the second of which uses `epub:type="noteref"` + an `<aside epub:type="footnote">`.
 *   - `epub2-toc-ncx.epub` — an EPUB2 with a `toc.ncx` (2 chapters).
 *   - `malformed.epub` — NOT a ZIP (raw bytes) for the `not_a_zip` error path.
 *
 * Keeping these committed (instead of building them in every test) means the
 * E2E + the main-side service test can point a picker/`importFromFile` at a real
 * file on disk. The files are tiny (a few KB each).
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";

const here = path.dirname(fileURLToPath(import.meta.url));
const enc = (s) => new TextEncoder().encode(s);

const CONTAINER = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

// --- EPUB3: nav + 3 chapters (chapter 2 has a footnote) -------------------

const E3_OPF = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>The Memory Book</dc:title>
    <dc:creator>Ada Lovelace</dc:creator>
    <dc:language>en</dc:language>
    <dc:date>2021-03-14</dc:date>
    <dc:identifier id="bookid">urn:uuid:1234-epub3</dc:identifier>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
    <item id="c3" href="chapter3.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
    <itemref idref="c3"/>
  </spine>
</package>`;

const E3_NAV = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <body>
    <nav epub:type="toc">
      <ol>
        <li><a href="chapter1.xhtml">Beginnings</a></li>
        <li><a href="chapter2.xhtml">The Spacing Effect</a></li>
        <li><a href="chapter3.xhtml">Conclusions</a></li>
      </ol>
    </nav>
  </body>
</html>`;

const E3_C1 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body>
  <h1>Beginnings</h1>
  <p>Memory is the residue of thought.</p>
  <ul><li>Encode</li><li>Store</li><li>Retrieve</li></ul>
</body></html>`;

const E3_C2 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>
  <h1>The Spacing Effect</h1>
  <h2>Why intervals matter</h2>
  <p>Distributed practice beats massed practice<a epub:type="noteref" href="#fn1">1</a>.</p>
  <p>The forgetting curve flattens with review.</p>
  <aside epub:type="footnote" id="fn1"><p>Ebbinghaus, 1885 — the original spacing study.</p></aside>
</body></html>`;

const E3_C3 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body>
  <h1>Conclusions</h1>
  <blockquote><p>Review just before forgetting.</p></blockquote>
  <p>That is the whole trick.</p>
</body></html>`;

function buildEpub3() {
  return zipSync({
    mimetype: enc("application/epub+zip"),
    "META-INF/container.xml": enc(CONTAINER),
    "OEBPS/content.opf": enc(E3_OPF),
    "OEBPS/nav.xhtml": enc(E3_NAV),
    "OEBPS/chapter1.xhtml": enc(E3_C1),
    "OEBPS/chapter2.xhtml": enc(E3_C2),
    "OEBPS/chapter3.xhtml": enc(E3_C3),
  });
}

// --- EPUB2: toc.ncx + 2 chapters ------------------------------------------

const E2_OPF = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>A Short Reader</dc:title>
    <dc:creator opf:role="aut">Grace Hopper</dc:creator>
    <dc:language>en</dc:language>
    <dc:date>1999-12-31</dc:date>
    <dc:identifier id="bookid">isbn-epub2-0001</dc:identifier>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="c1" href="ch1.html" media-type="application/xhtml+xml"/>
    <item id="c2" href="ch2.html" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="c1"/>
    <itemref idref="c2"/>
  </spine>
</package>`;

const E2_NCX = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="np1" playOrder="1"><navLabel><text>Opening</text></navLabel><content src="ch1.html"/></navPoint>
    <navPoint id="np2" playOrder="2"><navLabel><text>Closing</text></navLabel><content src="ch2.html"/></navPoint>
  </navMap>
</ncx>`;

const E2_C1 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body>
  <h1>Opening</h1>
  <p>The first chapter of a short reader.</p>
</body></html>`;

const E2_C2 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body>
  <h1>Closing</h1>
  <p>The second and final chapter.</p>
</body></html>`;

function buildEpub2() {
  return zipSync({
    mimetype: enc("application/epub+zip"),
    "META-INF/container.xml": enc(CONTAINER),
    "OEBPS/content.opf": enc(E2_OPF),
    "OEBPS/toc.ncx": enc(E2_NCX),
    "OEBPS/ch1.html": enc(E2_C1),
    "OEBPS/ch2.html": enc(E2_C2),
  });
}

writeFileSync(path.join(here, "epub3-three-chapters.epub"), buildEpub3());
writeFileSync(path.join(here, "epub2-toc-ncx.epub"), buildEpub2());
writeFileSync(path.join(here, "malformed.epub"), enc("this is not a zip archive"));

// eslint-disable-next-line no-console
console.log("Wrote EPUB fixtures to", here);
