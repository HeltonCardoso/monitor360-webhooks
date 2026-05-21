// server.js

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
require('dotenv').config();

const webhookRoutes = require('./routes/webhooks');
const healthRoutes = require('./routes/health');
const dashboardRoutes = require('./routes/dashboard');
const uploadRoutes = require('./routes/upload');

const app = express();

// ✅ CONFIGURAR HELMET COM CSP RELAXADO
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "https://cdn.jsdelivr.net"],
      fontSrc: ["'self'", "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net"],
    }
  }
}));

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// View engine
app.set('view engine', 'ejs');
app.set('views', './views');
app.use(express.static('public'));

// Dashboard routes
app.use('/', dashboardRoutes);

// Webhook routes
app.use('/webhooks', webhookRoutes);

// Health routes
app.use('/health', healthRoutes);

app.use('/upload', uploadRoutes);

// API info
app.get('/api', (req, res) => {
  res.json({
    message: 'Monitor360 Webhooks API',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      health: '/health',
      dashboard: '/',
      webhooks: {
        anymarket: '/webhooks/anymarket',
        jet: '/webhooks/jet',
        onclick: '/webhooks/onclick'
      }
    }
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Erro:', err);
  res.status(500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Servidor rodando na porta ${PORT}`);
});