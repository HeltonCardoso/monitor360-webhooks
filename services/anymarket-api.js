// services/anymarket-api.js
const axios = require('axios');

const API_KEY = process.env.ANYMARKET_API_KEY;
const BASE_URL = 'https://api.anymarket.com.br/v2';

if (!API_KEY) {
  console.warn('⚠️ Aviso: ANYMARKET_API_KEY não configurado.');
}

const anymarketApi = {
  async buscarDetalhesPedido(pedidoId) {
    try {
      const url = `${BASE_URL}/orders/${pedidoId}`;
      
      console.log(`🔍 Consultando AnyMarket: ${url}`);

      const response = await axios.get(url, {
        headers: {
          'Content-Type': 'application/json',
          'gumgaToken': API_KEY  // ✅ HEADER CORRETO
        },
        timeout: 60000
      });

      if (response.data) {
        console.log(`✅ Pedido AnyMarket ${pedidoId} encontrado`);
        return response.data;
      }

      return null;

    } catch (error) {
      console.error(
        `❌ Erro ao buscar pedido AnyMarket ${pedidoId}:`,
        error.response?.status,
        error.message
      );
      return null;
    }
  },

  extrairInfoRelevante(dados) {
    if (!dados) return null;

    try {
      return {
        // IDs
        id_anymarket: dados.id,
        numero_marketplace: dados.marketPlaceId,  // ✅ CAMPO CHAVE PARA CONECTAR COM JET
        marketplace_number: dados.marketPlaceNumber || dados.marketPlaceId,
        marketplace: dados.marketPlace,
        
        // Cliente
        cliente: dados.buyer?.name || 'N/A',
        email: dados.buyer?.email || 'N/A',
        telefone: dados.buyer?.cellPhone || dados.buyer?.phone || 'N/A',
        cpf_cnpj: dados.buyer?.document || 'N/A',
        documento_tipo: dados.buyer?.documentType || 'N/A',
        
        // Status
        status: dados.status || 'DESCONHECIDO',
        status_marketplace: dados.marketPlaceStatus || 'DESCONHECIDO',
        transmissao_status: dados.transmissionStatus || 'DESCONHECIDO',
        
        // Valores
        valor_total: dados.total || 0,
        valor_bruto: dados.gross || 0,
        valor_frete: dados.freight || dados.sellerFreight || 0,
        desconto: dados.discount || 0,
        juros: dados.interestValue || 0,
        
        // Datas
        data_pedido: dados.createdAt,
        data_pagamento: dados.paymentDate,
        data_atualizacao: dados.lastUpdate,
        
        // Endereço de Entrega
        endereco: {
          rua: dados.shipping?.street || dados.shipping?.address || '',
          numero: dados.shipping?.number || '',
          complemento: dados.shipping?.comment || '',
          bairro: dados.shipping?.neighborhood || '',
          cidade: dados.shipping?.city || '',
          estado: dados.shipping?.state || '',
          cep: dados.shipping?.zipCode || '',
          pais: dados.shipping?.country || 'BR',
          destinatario: dados.shipping?.receiverName || ''
        },
        
        // Endereço de Cobrança
        endereco_cobranca: {
          rua: dados.billingAddress?.street || dados.billingAddress?.address || '',
          numero: dados.billingAddress?.number || '',
          complemento: dados.billingAddress?.comment || '',
          bairro: dados.billingAddress?.neighborhood || '',
          cidade: dados.billingAddress?.city || '',
          estado: dados.billingAddress?.state || '',
          cep: dados.billingAddress?.zipCode || '',
          pais: dados.billingAddress?.country || 'BR',
          documento: dados.billingAddress?.shipmentUserDocument || ''
        },
        
        // Produtos
        produtos: (dados.items || []).map(item => ({
          id: item.product?.id || item.sku?.id,
          codigo: item.sku?.partnerId || item.sku?.id,
          ean: item.sku?.ean || '',
          nome: item.product?.title || item.sku?.title || 'Produto',
          quantidade: item.amount || 1,
          preco_unitario: item.unit || 0,
          preco_bruto: item.gross || 0,
          preco_total: item.total || 0,
          desconto_item: item.discount || 0,
          marca: item.brand || 'N/A',
          categoria: item.category || 'N/A',
          id_marketplace: item.idInMarketPlace || item.marketPlaceId,
          // shippingtype identifica ME2 (ex: "me2 - Coleta Normal")
          // usado para não gerar anomalia quando pedido ML fica em FATURADO aguardando bipagem
          shippingtype: item.shippings?.[0]?.shippingtype || '',
          estoque: (item.stocks || []).map(s => ({
            local_id: s.stockLocalId,
            quantidade: s.amount,
            nome: s.stockName
          }))
        })),
        
        // Pagamento
        pagamento: {
          metodo: dados.payments?.[0]?.method || 'N/A',
          metodo_normalizado: dados.payments?.[0]?.paymentMethodNormalized || 'N/A',
          status: dados.payments?.[0]?.status || 'DESCONHECIDO',
          valor: dados.payments?.[0]?.value || 0,
          parcelas: dados.payments?.[0]?.installments || 1,
          taxa_gateway: dados.payments?.[0]?.gatewayFee || 0,
          taxa_marketplace: dados.payments?.[0]?.marketplaceFee || 0,
          operadora_cartao: dados.payments?.[0]?.cardOperator || null
        },
        
        // Rastreamento
        rastreamento: {
          transportadora: dados.tracking?.carrier || 'N/A',
          numero_rastreamento: dados.tracking?.number || null,
          url_rastreamento: dados.tracking?.url || null,
          data_envio: dados.tracking?.shippedDate || null,
          data_entrega: dados.tracking?.deliveredDate || null,
          data_estimada: dados.tracking?.estimateDate || dados.shipping?.promisedShippingTime || null,
          status_entrega: dados.tracking?.status || 'DESCONHECIDO'
        },
        
        // Envio
        envio: {
          tipo: dados.metadata?.logistic_type || 'DESCONHECIDO',
          opcao_id: dados.shippingOptionId,
          tempo_promisso: dados.shipping?.promisedShippingTime,
          tempo_despacho: dados.shipping?.promisedDispatchTime,
          frete_gratis: dados.items?.[0]?.freeShipping || false
        },
        
        // Nota Fiscal
        nota_fiscal: dados.invoice ? {
          numero: dados.invoice?.number,
          serie: dados.invoice?.series,
          data: dados.invoice?.date,
          chave_acesso: dados.invoice?.accessKey,
          cfop: dados.invoice?.cfop,
          tipo_contribuinte: dados.invoice?.companyStateTaxId
        } : null,
        
        // Metadados
        metadata: dados.metadata || {},
        
        // Marketplace específico
        marketplace_url: dados.marketPlaceUrl || null,
        marketplace_status_envio: dados.marketPlaceShipmentStatus || null,
        marketplace_substatus_envio: dados.marketPlaceShipmentSubstatus || null
      };

    } catch (error) {
      console.error('❌ Erro ao extrair info AnyMarket:', error.message);
      return null;
    }
  }
};

module.exports = anymarketApi;