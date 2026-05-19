// services/jet-api.js
const axios = require('axios');

const API_KEY = process.env.JET_API_TOKEN;

if (!API_KEY) {
  console.warn('⚠️ Aviso: JET_API_TOKEN não configurado. As buscas de pedidos falharão.');
}

const BASE_URL = 'https://openapi.plataformaneo.com.br/order/api/v1/id';
const cachePedidos = new Map();

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function buscarDetalhesPedido(idOrder, tentativa = 1) {
  const maxTentativas = 3;

  // Verifica cache
  if (cachePedidos.has(idOrder)) {
    const cached = cachePedidos.get(idOrder);
    if (Date.now() - cached.timestamp < 86400000) {
      console.log(`📦 Pedido ${idOrder} veio do cache`);
      return cached.dados;
    }
  }

  const url = `${BASE_URL}/${idOrder}`;

  for (let tentativaAtual = 1; tentativaAtual <= maxTentativas; tentativaAtual++) {
    try {
      console.log(`🔍 Buscando pedido ${idOrder} (tentativa ${tentativaAtual}/${maxTentativas})...`);
      const inicio = Date.now();

      const response = await axios({
        method: 'GET',
        url: url,
        headers: {
          'apiKey': API_KEY,
          'Content-Type': 'application/json'
        },
        timeout: 60000 // ✅ Aumentado para 60 segundos
      });

      const tempo = Date.now() - inicio;

      if (response.data) {
        console.log(`✅ Pedido ${idOrder} obtido em ${tempo / 1000}s`);
        const dados = response.data.result || response.data;
        cachePedidos.set(idOrder, { dados: dados, timestamp: Date.now() });
        return dados;
      }

    } catch (error) {
      const isTimeout = error.code === 'ECONNABORTED';
      const status = error.response?.status;

      if (isTimeout) {
        console.log(`⏳ Timeout na tentativa ${tentativaAtual}, aguardando 3s...`);
        await delay(3000);
        continue;
      }

      if (status === 404 && tentativaAtual < maxTentativas) {
        console.log(`⚠️ Pedido ${idOrder} não encontrado (404), aguardando e tentando novamente...`);
        await delay(3000);
        continue;
      }

      if (tentativaAtual === maxTentativas) {
        console.error(`❌ Erro ao buscar pedido ${idOrder}:`, isTimeout ? 'Timeout' : (status || error.message));
      }
    }
  }

  return null;
}

function extrairInfoRelevante(detalhes) {
  if (!detalhes) return null;

  return {
    id: detalhes.idOrder,
    numero_marketplace: detalhes.marketPlaceNumberOrder,
    marketplace: detalhes.marketPlaceName,
    cliente: detalhes.nameCustomer,
    email: detalhes.email,
    telefone: detalhes.phone1,
    cpf_cnpj: detalhes.cpf_cnpj,
    status: detalhes.historyListOrderStatus?.[0]?.statusCode || 'DESCONHECIDO',
    valor_total: detalhes.total,
    valor_frete: detalhes.totalShipping,
    desconto: detalhes.totalDiscount,
    data_pedido: detalhes.dateOrder,
    endereco: {
      rua: detalhes.address?.streetAddress,
      numero: detalhes.address?.number,
      complemento: detalhes.address?.complement,
      bairro: detalhes.address?.neighbourhood,
      cidade: detalhes.address?.city,
      estado: detalhes.address?.state,
      cep: detalhes.address?.zipCode,
      destinatario: detalhes.address?.receiver
    },
    produtos: (detalhes.orderItems || []).map(item => ({
      id: item.idProduct,
      codigo: item.productCode,
      nome: item.name?.replace(/<[^>]*>/g, '').substring(0, 100),
      quantidade: item.quantity,
      preco_unitario: item.unitPrice,
      total: item.total,
      marca: item.brand,
      categoria: item.category
    })),
    pagamento: {
      metodo: detalhes.namePaymentMethodGateway,
      parcelas: detalhes.numberOfInstallments,
      valor_parcela: detalhes.valueOfInstallment
    },
    rastreamento: {
      transportadora: detalhes.shippingCompany,
      numero_rastreamento: detalhes.historyListOrderStatus?.[0]?.orderInfo?.trackingNumber || null,
      link_rastreamento: detalhes.historyListOrderStatus?.[0]?.trackingLink || null
    }
  };
}

function statusCache() {
  const total = cachePedidos.size;
  console.log(`📊 Cache: ${total} pedido${total !== 1 ? 's' : ''} armazenado${total !== 1 ? 's' : ''}`);
}

const jetApi = {
  buscarDetalhesPedido,
  extrairInfoRelevante,
  statusCache
};

module.exports = jetApi;