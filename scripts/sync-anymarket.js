// scripts/sync-anymarket.js
require('dotenv').config();
const axios = require('axios');
const pool = require('../config/database');
const anymarketApi = require('../services/anymarket-api');
const { STATUS_MAP } = require('../config/constants');
const { v4: uuidv4 } = require('uuid');

const API_KEY = process.env.ANYMARKET_API_KEY;
const BASE_URL = 'https://api.anymarket.com.br/v2';

const args = process.argv.slice(2).reduce((acc, arg) => {
  const [k, v] = arg.replace('--', '').split('=');
  acc[k] = v || true;
  return acc;
}, {});

const DIAS        = parseInt(args.dias || 30);
const STATUS_FILTER = args.status || null;
const DRY_RUN     = args['dry-run'] === true || args['dry-run'] === 'true';
const LIMIT_PAG   = 100; // máximo permitido pela API

const STATUS_ATIVOS = [
  'PAID_WAITING_SHIP',
  'INVOICED',
  'PAID_WAITING_DELIVERY'
];

const delay = ms => new Promise(r => setTimeout(r, ms));

async function buscarPagina(offset, createdAfter, createdBefore, status) {
  const params = {
    limit: LIMIT_PAG,
    offset,
    sort: 'createdAt',
    sortDirection: 'ASC'
  };
  if (createdAfter)  params.createdAfter  = createdAfter;
  if (createdBefore) params.createdBefore = createdBefore;
  if (status)        params.status        = status;

  const response = await axios.get(`${BASE_URL}/orders`, {
    headers: { 'gumgaToken': API_KEY, 'Content-Type': 'application/json' },
    params,
    timeout: 60000
  });
  return response.data;
}

async function salvarPedido(dadosCompletos, dryRun) {
  const info = anymarketApi.extrairInfoRelevante(dadosCompletos);
  if (!info || !info.numero_marketplace) {
    return false;
  }

  const { numero_marketplace, id_anymarket, marketplace, status } = info;
  const normalizedStatus = STATUS_MAP.ANYMARKET[status] || status;

  if (dryRun) {
    console.log(`  [DRY-RUN] ${numero_marketplace} | ${marketplace} | ${status}`);
    return true;
  }

  try {
    await pool.query(
      `INSERT INTO pedidos_mapeamento 
         (id_anymarket, numero_marketplace, marketplace_origem)
       VALUES ($1, $2, $3)
       ON CONFLICT (numero_marketplace) DO UPDATE SET
         id_anymarket = $1, atualizado_em = NOW()`,
      [String(id_anymarket), numero_marketplace, marketplace]
    );

    await pool.query(
      `INSERT INTO tracking_events
         (id, pedido_id, origem, status, timestamp, payload, dados_completos)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (pedido_id, origem, status) DO UPDATE SET
         timestamp       = EXCLUDED.timestamp,
         dados_completos = EXCLUDED.dados_completos`,
      [
        uuidv4(),
        numero_marketplace,
        'ANYMARKET',
        normalizedStatus,
        new Date(dadosCompletos.lastUpdate || dadosCompletos.createdAt),
        JSON.stringify({ sync: true, id: dadosCompletos.id }),
        JSON.stringify(info)
      ]
    );
    return true;
  } catch (err) {
    console.error(`  ❌ Erro ao salvar ${numero_marketplace}:`, err.message);
    return false;
  }
}

async function buscarTodosStatus(status, createdAfter, createdBefore) {
  let offset = 0;
  let pagina = 1;
  let totalSalvos = 0;
  let totalErros  = 0;
  let totalPedidos = null; // descobrimos na primeira página

  console.log(`\n── Status: ${status} ──`);

  while (true) {
    try {
      console.log(`  📄 Página ${pagina} (offset ${offset})${totalPedidos ? ` de ~${totalPedidos}` : ''}...`);

      const resultado = await buscarPagina(offset, createdAfter, createdBefore, status);

      // A AnyMarket retorna a lista em diferentes estruturas
      const pedidos = 
        resultado.content ||
        resultado._embedded?.orders ||
        resultado.orders ||
        (Array.isArray(resultado) ? resultado : []);

      // Pega total na primeira página
      if (totalPedidos === null) {
        totalPedidos = resultado.totalElements || resultado.total || pedidos.length;
        console.log(`  → Total encontrado: ~${totalPedidos} pedidos`);
      }

      if (!pedidos.length) {
        console.log(`  ✅ Fim — sem mais pedidos`);
        break;
      }

      console.log(`  → ${pedidos.length} pedidos nesta página`);

      for (const pedido of pedidos) {
        process.stdout.write(`     ⟳ ID ${pedido.id} → `);

        // Busca detalhes completos (listagem não traz items/buyer)
        let dadosCompletos = null;
        for (let tentativa = 1; tentativa <= 3; tentativa++) {
          dadosCompletos = await anymarketApi.buscarDetalhesPedido(pedido.id);
          if (dadosCompletos) break;
          if (tentativa < 3) {
            process.stdout.write(`retry ${tentativa}... `);
            await delay(2000);
          }
        }

        if (!dadosCompletos) {
          process.stdout.write(`❌ sem dados\n`);
          totalErros++;
          continue;
        }

        const ok = await salvarPedido(dadosCompletos, DRY_RUN);
        if (ok) {
          process.stdout.write(`✅ ${dadosCompletos.marketPlaceId || '?'}\n`);
          totalSalvos++;
        } else {
          process.stdout.write(`⚠️  pulado\n`);
        }

        await delay(150); // respeita rate limit entre pedidos
      }

      // Avança para próxima página
      offset += LIMIT_PAG;
      pagina++;

      // Para quando retornou menos que o limite (última página)
      if (pedidos.length < LIMIT_PAG) {
        console.log(`  ✅ Última página atingida`);
        break;
      }

      // Para quando já buscou todos
      if (totalPedidos && offset >= totalPedidos) {
        console.log(`  ✅ Todos os registros buscados`);
        break;
      }

      await delay(500); // pausa entre páginas

    } catch (err) {
      if (err.response?.status === 429) {
        console.log(`\n  ⏳ Rate limit — aguardando 15s...`);
        await delay(15000);
        continue; // tenta a mesma página novamente
      }
      console.error(`\n  ❌ Erro na página ${pagina}:`, err.response?.status, err.message);
      break;
    }
  }

  return { totalSalvos, totalErros };
}

async function main() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║     SYNC ANYMARKET → BANCO DE DADOS         ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  if (!API_KEY) {
    console.error('❌ ANYMARKET_API_KEY não configurado no .env');
    process.exit(1);
  }

  const agora  = new Date();
  const inicio = new Date(agora);
  inicio.setDate(inicio.getDate() - DIAS);

  // Formato que a AnyMarket aceita
 // const fmt = d => d.toISOString().slice(0, 19) + '-03:00';
  const fmt = d => d.toISOString();
  const createdAfter  = fmt(inicio);
  const createdBefore = fmt(agora);

  console.log(`📅 Período : ${inicio.toLocaleDateString('pt-BR')} → ${agora.toLocaleDateString('pt-BR')}`);
  console.log(`🔍 Status  : ${STATUS_FILTER || STATUS_ATIVOS.join(', ')}`);
  console.log(`📦 Modo    : ${DRY_RUN ? '⚠️  DRY-RUN (nada será salvo)' : '✅ PRODUÇÃO'}\n`);

  const statusParaBuscar = STATUS_FILTER ? [STATUS_FILTER] : STATUS_ATIVOS;

  let totalGeral = 0;
  let errosGeral = 0;

  for (const status of statusParaBuscar) {
    const { totalSalvos, totalErros } = await buscarTodosStatus(status, createdAfter, createdBefore);
    totalGeral += totalSalvos;
    errosGeral += totalErros;
  }

  console.log('\n╔══════════════════════════════════════════════╗');
  console.log(`║  CONCLUÍDO                                   ║`);
  console.log(`║  Salvos      : ${String(totalGeral).padEnd(28)}║`);
  console.log(`║  Erros/Pulos : ${String(errosGeral).padEnd(28)}║`);
  console.log('╚══════════════════════════════════════════════╝\n');

  await pool.end();
  process.exit(0);
}

main().catch(err => {
  console.error('❌ Erro fatal:', err.message);
  process.exit(1);
});