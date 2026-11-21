const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const puppeteer = require('puppeteer');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const ROOT = __dirname;
const CHAPTERS_DIR = path.join(ROOT, 'chapters');
const OUTPUT_DIR = path.join(ROOT, 'output');
const CACHE_DIR = path.join(ROOT, '.cache');
const THEME_PATH = path.join(ROOT, 'assets', 'theme.css');
const OUTPUT_PDF = path.join(OUTPUT_DIR, 'BEST_Master_Book.pdf');
const FRESH_BUILD = process.argv.includes('--fresh');

function ensureDirs() {
    [CHAPTERS_DIR, OUTPUT_DIR, CACHE_DIR].forEach((dir) => {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    });
}

function findSystemBrowser() {
    const candidates = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
    ];
    return candidates.find((p) => p && fs.existsSync(p)) || null;
}

function sha256(str) {
    return crypto.createHash('sha256').update(str).digest('hex').slice(0, 16);
}

function toRoman(num) {
    const map = [
        [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'],
        [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']
    ];
    let res = '';
    for (const [val, sym] of map) {
        while (num >= val) { res += sym; num -= val; }
    }
    return res;
}

function extractMeta(html, filename) {
    const titleMatch = html.match(/data-title="([^"]+)"/i) || html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
    const volMatch = html.match(/data-volume="([^"]+)"/i);
    const cleanFile = filename.replace(/\.html$/i, '').replace(/[_-]+/g, ' ');
    return {
        title: titleMatch ? titleMatch[1].trim() : cleanFile,
        volume: volMatch ? volMatch[1].trim() : 'BEST Master Compendium'
    };
}

function wrapHtml(bodyContent) {
    const katexCss = pathToFileURL(path.join(ROOT, 'node_modules', 'katex', 'dist', 'katex.min.css')).href;
    const katexJs = pathToFileURL(path.join(ROOT, 'node_modules', 'katex', 'dist', 'katex.min.js')).href;
    const autoRenderJs = pathToFileURL(path.join(ROOT, 'node_modules', 'katex', 'dist', 'contrib', 'auto-render.min.js')).href;
    const themeUrl = pathToFileURL(THEME_PATH).href;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <link rel="stylesheet" href="${katexCss}">
  <link rel="stylesheet" href="${themeUrl}">
</head>
<body>
  ${bodyContent}
  <script src="${katexJs}"></script>
  <script src="${autoRenderJs}"></script>
  <script>
    window.__RENDER_DONE__ = false;
    function markDone() { window.__RENDER_DONE__ = true; }
    document.addEventListener("DOMContentLoaded", function () {
      try {
        if (typeof renderMathInElement === "function") {
          renderMathInElement(document.body, {
            delimiters: [
              { left: "$$", right: "$$", display: true },
              { left: "$", right: "$", display: false }
            ],
            throwOnError: false
          });
        }
      } finally {
        if (document.fonts && document.fonts.ready) {
          document.fonts.ready.then(markDone).catch(markDone);
        } else {
          markDone();
        }
        setTimeout(markDone, 4000);
      }
    });
  </script>
</body>
</html>`;
}

async function renderHtmlToPdfBuffer(browser, bodyHtml) {
    const tmpFile = path.join(ROOT, `.tmp_render_${Date.now()}_${Math.random().toString(36).slice(2)}.html`);
    fs.writeFileSync(tmpFile, wrapHtml(bodyHtml), 'utf8');
    const page = await browser.newPage();
    try {
        await page.goto(pathToFileURL(tmpFile).href, { waitUntil: 'load', timeout: 60000 });
        await page.waitForFunction(() => window.__RENDER_DONE__ === true, { timeout: 30000 });
        const pdfUint8 = await page.pdf({
            format: 'A4',
            printBackground: true,
            preferCSSPageSize: true
        });
        return Buffer.from(pdfUint8);
    } finally {
        try {
            if (!page.isClosed()) await page.close();
        } catch (_) {
            // Prevent close errors from hiding the original render error
        }
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
}

function buildCoverHtml(totalChapters, totalContentPages) {
    const today = new Date().toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' });
    return `
  <div class="cover-page">
    <div class="cover-stripe"></div>
    <div>
      <div class="cover-kicker">Strategic Academic Alliance • Resonance / Olympiad Standard</div>
      <h1 class="cover-title">BEST ELITE<br>MASTER COMPENDIUM</h1>
      <p class="cover-subtitle">
        The Complete 250-Hour First-Principles &amp; Olympiad Bridge Edition for the
        BASE Entrance &amp; Scholarship Test (Paper 1 &amp; Paper 2). Engineered for
        Level 1 Warmup to Level 3 Rank-Booster Mastery.
      </p>
      <div class="cover-stats">
        <div class="cover-stat-card">
          <span class="cover-stat-num">${totalChapters}</span>
          <span class="cover-stat-label">Modules Compiled</span>
        </div>
        <div class="cover-stat-card">
          <span class="cover-stat-num">${totalContentPages}</span>
          <span class="cover-stat-label">Study Pages Ready</span>
        </div>
        <div class="cover-stat-card">
          <span class="cover-stat-num">L1 &rarr; L3</span>
          <span class="cover-stat-label">Escalation System</span>
        </div>
      </div>
    </div>
    <div class="cover-footer">
      <span>Paper 1: Quant Aptitude, LR &amp; Math • Paper 2: Physics, Chemistry &amp; Biology</span>
      <span>Compiled: ${today}</span>
    </div>
  </div>`;
}

function buildTocHtml(tocEntries) {
    let lastVol = '';
    const rows = tocEntries.map((entry) => {
        let volHeader = '';
        if (entry.volume !== lastVol) {
            volHeader = `<div class="toc-vol-heading">${entry.volume}</div>`;
            lastVol = entry.volume;
        }
        return `${volHeader}
      <div class="toc-row">
        <span class="toc-title">${entry.title}</span>
        <span class="toc-page">${entry.startPage}</span>
      </div>`;
    }).join('\n');

    return `
  <div class="toc-header">
    <h1>Table of Contents</h1>
  </div>
  ${rows}`;
}

async function main() {
    ensureDirs();
    if (!fs.existsSync(THEME_PATH)) {
        throw new Error('Missing assets/theme.css! Please create it first.');
    }

    const files = fs.readdirSync(CHAPTERS_DIR)
        .filter((f) => f.toLowerCase().endsWith('.html'))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

    if (files.length === 0) {
        console.log('No .html files found inside chapters/. Add at least one file and re-run.');
        return;
    }

    const themeCss = fs.readFileSync(THEME_PATH, 'utf8');
    const systemBrowser = findSystemBrowser();

    const launchOptions = {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-gpu',
            '--disable-dev-shm-usage',
            '--allow-file-access-from-files'
        ]
    };
    if (systemBrowser) {
        launchOptions.executablePath = systemBrowser;
        console.log(`\n🌐 Using system browser: ${path.basename(systemBrowser)}`);
    }

    const browser = await puppeteer.launch(launchOptions);

    try {
        console.log(`📚 Found ${files.length} module(s) in chapters/...\n`);
        const compiledChapters = [];
        let cachedCount = 0;
        let renderedCount = 0;

        for (const file of files) {
            const filePath = path.join(CHAPTERS_DIR, file);
            const html = fs.readFileSync(filePath, 'utf8');
            const meta = extractMeta(html, file);
            const hash = sha256(html + themeCss);
            const cachePdfPath = path.join(CACHE_DIR, `${file}.${hash}.pdf`);

            let pdfBuffer;
            if (!FRESH_BUILD && fs.existsSync(cachePdfPath)) {
                pdfBuffer = fs.readFileSync(cachePdfPath);
                cachedCount++;
                console.log(`  ⚡ [CACHE]    ${file}`);
            } else {
                pdfBuffer = await renderHtmlToPdfBuffer(browser, html);
                fs.writeFileSync(cachePdfPath, pdfBuffer);
                renderedCount++;
                console.log(`  🖨️  [RENDERED] ${file}`);
            }

            const doc = await PDFDocument.load(pdfBuffer);
            compiledChapters.push({
                file,
                title: meta.title,
                volume: meta.volume,
                pdfBuffer,
                pageCount: doc.getPageCount()
            });
        }

        let runningPage = 1;
        const tocEntries = compiledChapters.map((ch) => {
            const entry = { title: ch.title, volume: ch.volume, startPage: runningPage };
            runningPage += ch.pageCount;
            return entry;
        });
        const totalContentPages = runningPage - 1;

        console.log('\n🎨 Generating Cover Page & Dynamic Table of Contents...');
        const coverBuf = await renderHtmlToPdfBuffer(browser, buildCoverHtml(files.length, totalContentPages));
        const tocBuf = await renderHtmlToPdfBuffer(browser, buildTocHtml(tocEntries));

        console.log('🔗 Merging all PDFs and stamping continuous headers/footers...');
        const finalPdf = await PDFDocument.create();
        const fontRegular = await finalPdf.embedFont(StandardFonts.Helvetica);
        const fontBold = await finalPdf.embedFont(StandardFonts.HelveticaBold);

        // 1. Add Cover
        const coverDoc = await PDFDocument.load(coverBuf);
        const [coverPage] = await finalPdf.copyPages(coverDoc, [0]);
        finalPdf.addPage(coverPage);

        // 2. Add TOC (Roman numerals)
        const tocDoc = await PDFDocument.load(tocBuf);
        const copiedTocPages = await finalPdf.copyPages(tocDoc, tocDoc.getPageIndices());
        copiedTocPages.forEach((p, idx) => {
            const { width } = p.getSize();
            p.drawText('BEST Elite Master Compendium — Contents', {
                x: 40, y: 24, size: 8, font: fontRegular, color: rgb(0.4, 0.45, 0.52)
            });
            p.drawText(toRoman(idx + 1), {
                x: width - 52, y: 24, size: 8.5, font: fontBold, color: rgb(0.15, 0.25, 0.4)
            });
            finalPdf.addPage(p);
        });

        // 3. Add Chapter Pages (Continuous Arabic numbering: 1..N)
        let currentArabicPage = 1;
        for (const ch of compiledChapters) {
            const chDoc = await PDFDocument.load(ch.pdfBuffer);
            const copiedPages = await finalPdf.copyPages(chDoc, chDoc.getPageIndices());
            for (const p of copiedPages) {
                const { width } = p.getSize();
                p.drawLine({
                    start: { x: 40, y: 36 },
                    end: { x: width - 40, y: 36 },
                    thickness: 0.5,
                    color: rgb(0.8, 0.84, 0.88)
                });
                p.drawText(`${ch.volume}  •  ${ch.title}`.slice(0, 88), {
                    x: 40, y: 23, size: 7.8, font: fontRegular, color: rgb(0.38, 0.44, 0.52)
                });
                const pageStr = `Page ${currentArabicPage} of ${totalContentPages}`;
                const textWidth = fontBold.widthOfTextAtSize(pageStr, 8);
                p.drawText(pageStr, {
                    x: width - 40 - textWidth, y: 23, size: 8, font: fontBold, color: rgb(0.06, 0.16, 0.26)
                });
                finalPdf.addPage(p);
                currentArabicPage++;
            }
        }

        const finalBytes = await finalPdf.save();
        fs.writeFileSync(OUTPUT_PDF, finalBytes);

        console.log('\n✅ BUILD COMPLETE!');
        console.log(`   • Freshly rendered : ${renderedCount} file(s)`);
        console.log(`   • Reused from cache: ${cachedCount} file(s)`);
        console.log(`   • Content pages    : ${totalContentPages} (+ Cover & TOC)`);
        console.log(`   • Output PDF       : ${OUTPUT_PDF}\n`);
    } finally {
        await browser.close().catch(() => { });
    }
}

main().catch((err) => {
    console.error('\n❌ Build failed:', err);
    process.exit(1);
});