// routes/upload.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const spreadsheetImport = require('../services/spreadsheet-import');

const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.xlsx', '.xls', '.csv'];
    const ext = file.originalname.substring(file.originalname.lastIndexOf('.')).toLowerCase();
    cb(null, allowed.includes(ext));
  }
});

// Página de upload
router.get('/upload', (req, res) => {
  res.render('upload');
});

// Processar upload
router.post('/upload/compare', upload.single('planilha'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nenhum arquivo enviado' });
    }
    
    const resultado = await spreadsheetImport.compareWithIntegrated(req.file.buffer);
    res.json(resultado);
    
  } catch (error) {
    console.error('Erro no upload:', error);
    res.status(500).json({ error: error.message });
  }
});

// Histórico de comparações
router.get('/upload/historico', async (req, res) => {
  const pool = require('../config/database');
  const result = await pool.query(`
    SELECT * FROM comparacoes_planilhas 
    ORDER BY realizada_em DESC 
    LIMIT 20
  `);
  res.json(result.rows);
});

module.exports = router;