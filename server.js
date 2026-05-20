// server.js

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
require('dotenv').config();

const webhookRoutes = require('./routes/webhooks');
const healthRoutes = require('./routes/health');
const dashboardRoutes = require('./routes/dashboard');

const app = express();

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// View engine ✅ ADICIONE ISTO
app.set('view engine', 'ejs');
app.set('views', './views');

app.use(express.static('public'));

// ✅ REMOVA A ROTA '/' DAQUI
// app.get('/', (req, res) => { ... }) ← DELETE ESTA SEÇÃO

// ✅ DASHBOARD ROUTES PRIMEIRO
app.use('/', dashboardRoutes);

// Webhook routes
app.use('/webhooks', webhookRoutes);

// Health routes
app.use('/health', healthRoutes);

// ✅ API INFO em /api (não em /)
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