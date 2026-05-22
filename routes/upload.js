// routes/upload.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const xlsx = require('xlsx');
const pool = require('../config/database');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function normalizeOrderId(id) {
  if (!id) return id;
  const s = id.toString().trim();
  const hifens = (s.match(/-/g) || []).length;
  return hifens >= 2 ? s.replace(/-\d+$/, '') : s;
}

function parseValor(str) {
  if (!str) return 0;
  return parseFloat(str.toString().replace('R$','').replace(/\./g,'').replace(',','.').trim()) || 0;
}

function detectarMarketplace(keys) {
  const joined = keys.join('|').toLowerCase();
  if (joined.includes('número do pedido') || joined.includes('numero do pedido') || joined.includes('data do pacote')) return 'MAGAZINE_LUIZA';
  if (keys.includes('Pedido Site MM') || (keys.includes('Pedido') && joined.includes('id do seller'))) return 'MADEIRAMADEIRA';
  if (joined.includes('pedido parceiro') || joined.includes('parceiro portal')) return 'WEBCONTINENTAL';
  if (joined.includes('order-id') || joined.includes('order id') || joined.includes('amazon')) return 'AMAZON';
  return 'DESCONHECIDO';
}

function extractMagalu(row) {
  const get = k => { const f = Object.keys(row).find(x => x.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim() === k.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim()); return f ? row[f]?.toString().trim() : null; };
  const pedidoId = get('Número do pedido') || get('Numero do pedido') || get('Número do pacote');
  return { pedido_id_original: pedidoId, pedido_id_normalizado: pedidoId ? normalizeOrderId(pedidoId) : null, marketplace: 'MAGAZINE_LUIZA', status: get('Status pacote no momento que o relatório foi solicitado') || 'DESCONHECIDO', valor_total: parseValor(get('Valor total do Pacote') || get('Valor total dos Produtos do pacote')), cliente: (get('Nome do cliente') || 'N/A').substring(0,100), data: get('Data do Pacote') || null };
}

function extractWebContinental(row) {
  let pedidoId=null, pedidoSite=null, cliente='N/A', valor=0, status='DESCONHECIDO', data=null;
  for (const [k,v] of Object.entries(row)) {
    const kl = k.toLowerCase();
    if (k==='Pedido Parceiro'||kl==='pedido parceiro') pedidoId=v?.toString().trim();
    if (k==='Pedido Site'||kl==='pedido site') pedidoSite=v?.toString().trim();
    if (k==='Cliente'||kl==='cliente') cliente=v?.toString().trim()||'N/A';
    if (k==='Total do Pedido'||kl==='total do pedido') valor=parseValor(v);
    if (k==='Status Atual'||kl==='status atual') status=v?.toString().trim()||'DESCONHECIDO';
    if (kl.includes('data cria')) data=v?.toString().trim()||null;
  }
  const id = pedidoId||pedidoSite;
  return { pedido_id_original: id, pedido_id_normalizado: id?normalizeOrderId(id):null, marketplace: 'WEBCONTINENTAL', status, valor_total: valor, cliente: (cliente||'N/A').substring(0,100), data };
}

function extractMadeiraMadeira(row) {
  let pedidoId=null, cliente='N/A', valor=0, status='DESCONHECIDO', data=null;
  for (const [k,v] of Object.entries(row)) {
    const kl = k.toLowerCase();
    if (k==='Pedido'||kl==='pedido') pedidoId=v?.toString().trim();
    if (kl.includes('cliente')&&!kl.includes('cpf')&&!kl.includes('status')) cliente=v?.toString().trim()||'N/A';
    if (kl==='valor pedido'||kl==='valor_pedido') valor=parseValor(v);
    if (k==='Status'||kl==='status') status=v?.toString().trim()||'DESCONHECIDO';
    if (kl==='data pedido'||kl==='data_pedido') data=v?.toString().trim()||null;
  }
  return { pedido_id_original: pedidoId, pedido_id_normalizado: pedidoId?normalizeOrderId(pedidoId):null, marketplace: 'MADEIRAMADEIRA', status, valor_total: valor, cliente: (cliente||'N/A').substring(0,100), data };
}

function extractAmazon(row) {
  let pedidoId=null, cliente='N/A', valor=0, data=null;
  for (const [k,v] of Object.entries(row)) {
    const kl = k.toLowerCase();
    if (kl==='order-id') pedidoId=v?.toString().trim();
    if (kl==='buyer-name') cliente=v?.toString().trim()||'N/A';
    if (kl==='item-price') valor+=parseFloat(v?.toString().trim())||0;
    if (kl==='purchase-date') data=v?.toString().trim()||null;
  }
  return { pedido_id_original: pedidoId, pedido_id_normalizado: pedidoId?normalizeOrderId(pedidoId):null, marketplace: 'AMAZON', status: 'ATIVO', valor_total: valor, cliente: (cliente||'N/A').substring(0,100), data };
}

// Mapa de status do marketplace → label legível
const STATUS_LABEL_MKT = {
  'Aprovado': 'Aprovado', 'Enviado': 'Enviado', 'Entregue': 'Entregue',
  'Cancelado': 'Cancelado', 'Devolvido': 'Devolvido',
  'ATIVO': 'Ativo', 'DESCONHECIDO': '?'
};

// Status do nosso sistema → label legível
const STATUS_LABEL_SISTEMA = {
  'PAGO_AGUARDANDO_ENVIO': 'Pago/Aguard.Envio',
  'FATURADO':              'Faturado',
  'ENVIADO':               'Enviado',
  'ENTREGUE':              'Entregue',
  'CANCELADO':             'Cancelado',
  'EM_PRODUCAO':           'Em Produção',
  'FATURADO_ENVIADO':      'Faturado/Enviado',
  'CONFIRMADO':            'Confirmado'
};

// Verifica se status marketplace e sistema estão em sincronia
function compararStatus(statusMkt, statusSistema) {
  const mkt = (statusMkt || '').toLowerCase();
  const sis = (statusSistema || '').toLowerCase();
  if (mkt.includes('entregue') && sis.includes('entregue')) return 'OK';
  if (mkt.includes('enviad') && (sis.includes('enviad') || sis.includes('confirmado'))) return 'OK';
  if (mkt.includes('cancelad') && sis.includes('cancelad')) return 'OK';
  if (mkt.includes('aprovado') && (sis.includes('pago') || sis.includes('producao'))) return 'OK';
  if (mkt.includes('enviad') && sis.includes('producao')) return 'ATRASADO';
  if (mkt.includes('entregue') && !sis.includes('entregue')) return 'ATRASADO';
  return 'DIVERGENTE';
}

router.get('/', (req, res) => res.render('upload'));

router.post('/compare', upload.single('planilha'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });

    const fileExt = req.file.originalname.toLowerCase().split('.').pop();
    const bufferStr = req.file.buffer.slice(0, 500).toString('latin1');
    const isSemicolonCsv = fileExt === 'csv' && bufferStr.includes(';');
    const isTsvOrTxt = fileExt === 'txt' || fileExt === 'tsv';

    let rawData = [];

    if (isTsvOrTxt) {
      const text = req.file.buffer.toString('utf8');
      const lines = text.split('\n').filter(l => l.trim());
      const headers = lines[0].split('\t').map(h => h.trim());
      rawData = lines.slice(1).map(line => {
        const values = line.split('\t');
        const obj = {};
        headers.forEach((h, i) => { obj[h] = values[i]?.trim() || ''; });
        return obj;
      }).filter(row => Object.values(row).some(v => v));
    } else if (isSemicolonCsv) {
      const text = req.file.buffer.toString('latin1');
      const lines = text.split('\n').filter(l => l.trim());
      const headers = lines[0].split(';').map(h => h.replace(/^"|"$/g,'').trim());
      rawData = lines.slice(1).map(line => {
        const values = line.split(';').map(v => v.replace(/^"|"$/g,'').trim());
        const obj = {};
        headers.forEach((h, i) => { obj[h] = values[i] || ''; });
        return obj;
      }).filter(row => Object.values(row).some(v => v));
    } else {
      const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
      const worksheet = workbook.Sheets[workbook.SheetNames[0]];
      rawData = xlsx.utils.sheet_to_json(worksheet, { defval: '' });
    }

    if (!rawData.length) return res.status(400).json({ error: 'Planilha vazia ou formato inválido' });

    const keys = Object.keys(rawData[0]);
    const tipoPlanilha = detectarMarketplace(keys);

    if (tipoPlanilha === 'DESCONHECIDO') {
      return res.status(400).json({
        error: 'Marketplace não reconhecido.',
        debug: { fileName: req.file.originalname, primeiraColuna: keys[0], colunas: keys.slice(0,6) }
      });
    }

    const extractors = { MAGAZINE_LUIZA: extractMagalu, WEBCONTINENTAL: extractWebContinental, MADEIRAMADEIRA: extractMadeiraMadeira, AMAZON: extractAmazon };
    const pedidosValidos = rawData.map(extractors[tipoPlanilha]).filter(p =>
      p.pedido_id_original && p.pedido_id_original !== 'N/A' && p.pedido_id_original.toString().length > 3
    );

    if (!pedidosValidos.length) return res.status(400).json({ error: 'Não foi possível identificar IDs de pedidos.', debug: { tipoPlanilha, colunas: keys.slice(0,8), amostra: rawData[0] } });

    // Monta todos os IDs possíveis para buscar
    const possiveisIds = [...new Set(pedidosValidos.flatMap(p =>
      [p.pedido_id_original, p.pedido_id_normalizado, ...[1,2,3,4,5,6,7,8,9].map(n => `${p.pedido_id_original}-${n}`)].filter(Boolean)
    ))];

    // Busca tracking_events com último status por pedido
    const result = await pool.query(`
      SELECT DISTINCT ON (pedido_id)
        pedido_id, origem, status, timestamp
      FROM tracking_events
      WHERE pedido_id = ANY($1::text[])
      ORDER BY pedido_id, timestamp DESC
    `, [possiveisIds]);

    // Monta map: pedido_id → { origem, status, timestamp }
    const integradosMap = new Map();
    result.rows.forEach(r => integradosMap.set(r.pedido_id, r));

    // Classifica cada pedido
    const integrados = [];
    const naoIntegrados = [];

    for (const p of pedidosValidos) {
      const variantes = [p.pedido_id_original, p.pedido_id_normalizado, ...[1,2,3,4,5,6,7,8,9].map(n=>`${p.pedido_id_original}-${n}`)].filter(Boolean);
      const match = variantes.find(id => integradosMap.has(id));

      if (match) {
        const trackInfo = integradosMap.get(match);
        const comparacao = compararStatus(p.status, trackInfo.status);
        integrados.push({
          pedido_id_original:    p.pedido_id_original,
          pedido_id_normalizado: p.pedido_id_normalizado,
          cliente:               p.cliente,
          valor_total:           p.valor_total,
          data:                  p.data,
          status_marketplace:    p.status,
          status_sistema:        trackInfo.status,
          estagio_sistema:       trackInfo.origem,
          ultima_atualizacao:    trackInfo.timestamp,
          comparacao            // 'OK' | 'ATRASADO' | 'DIVERGENTE'
        });
      } else {
        naoIntegrados.push({
          pedido_id_original:    p.pedido_id_original,
          pedido_id_normalizado: p.pedido_id_normalizado,
          marketplace:           p.marketplace,
          status:                p.status,
          valor_total:           p.valor_total,
          cliente:               p.cliente,
          data:                  p.data
        });
      }
    }

    // Resumo de divergências
    const divergentes  = integrados.filter(p => p.comparacao === 'DIVERGENTE').length;
    const atrasados    = integrados.filter(p => p.comparacao === 'ATRASADO').length;
    const sincronizados = integrados.filter(p => p.comparacao === 'OK').length;

    res.json({
      tipo_planilha:    tipoPlanilha,
      total_planilha:   pedidosValidos.length,
      total_integrados: integrados.length,
      total_nao_integrados: naoIntegrados.length,
      resumo_status: { sincronizados, atrasados, divergentes },
      integrados,
      nao_integrados: naoIntegrados
    });

  } catch (err) {
    console.error('❌ Erro upload:', err);
    res.status(500).json({ error: 'Erro ao processar: ' + err.message });
  }
});

module.exports = router;