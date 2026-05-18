const express = require('express');
const router = express.Router();
const pool = require('../config/database');

router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({ 
      status: 'ok',
      timestamp: result.rows[0].now,
      uptime: process.uptime()
    });
    
  } catch (error) {
    res.status(503).json({ 
      status: 'error',
      message: error.message 
    });
  }
});

module.exports = router;