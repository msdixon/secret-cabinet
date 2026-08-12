'use strict';

// #193 route-extraction seam-map, module 3 of 7 — the document-upload route.
// Self-contained: no session state, no ROSTER, just multer + PDF text
// extraction. `multer` and `PDFParser` are required here directly rather
// than passed in as deps — they're stdlib-adjacent parsing tools, not
// app state or another module's function, same reasoning `auth.js` uses for
// not taking `fs` as a dependency.

const multer = require('multer');
const PDFParser = require('pdf2json');
const path = require('path');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

function extractPdfText(buffer) {
  return new Promise((resolve, reject) => {
    const parser = new PDFParser(null, true); // true = raw text mode
    parser.on('pdfParser_dataError', err => reject(err.parserError));
    parser.on('pdfParser_dataReady', () => {
      const text = parser.getRawTextContent()
        .replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
      resolve(text);
    });
    parser.parseBuffer(buffer);
  });
}

function registerUploadRoutes(app) {
  // POST /api/upload — extract text from .txt, .md, or .pdf file
  app.post('/api/upload', (req, res, next) => {
    upload.single('file')(req, res, err => {
      if (err) {
        const msg = err.code === 'LIMIT_FILE_SIZE'
          ? 'File too large — maximum 25 MB'
          : err.message || 'Upload failed';
        return res.status(400).json({ error: msg });
      }
      next();
    });
  }, async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const { originalname, mimetype, buffer } = req.file;
    const ext = path.extname(originalname).toLowerCase();

    try {
      let text = '';
      if (ext === '.pdf' || mimetype === 'application/pdf') {
        text = await extractPdfText(buffer);
      } else {
        // .txt and .md — read as UTF-8
        text = buffer.toString('utf8');
      }
      // Normalise whitespace
      text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
      if (!text) return res.status(422).json({ error: 'No readable text found in file' });
      res.json({ text, filename: originalname });
    } catch (err) {
      console.error('Upload error:', err);
      res.status(500).json({ error: 'Could not extract text from file' });
    }
  });
}

module.exports = { registerUploadRoutes, extractPdfText };
