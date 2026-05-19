// services/jet-api.js
const axios = require('axios');

const jetApi = {
  async buscarDetalhesPedido(numeroPedido) {
    try {
      console.log(`🔍 Consultando JET: Pedido ${numeroPedido}`);

      const url = `https://api.jet.com.br/v1/${numeroPedido}`;
      
      const response = await axios.get(url, {
        headers: {
          'Authorization': `Bearer ${process.env.JET_API_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      });

      if (response.data?.result) {
        console.log(`✅ Pedido JET ${numeroPedido} encontrado`);
        return response.data.result;
      }

      console.warn(`⚠️ Resposta vazia para pedido ${numeroPedido}`);
      return null;

    } catch (error) {
      console.error(`❌ Erro ao buscar pedido JET ${numeroPedido}:`, error.message);
      return null;
    }
  },

  extrairInfoRelevante(dados) {
    if (!dados) return null;

    try {
      return {
        id: dados.idOrder,
        numero_marketplace: dados.marketPlaceNumberOrder,
        marketplace: dados.marketPlaceName,
        cliente: dados.nameCustomer,
        email: dados.email,
        telefone: dados.phone1,
        cpf_cnpj: dados.cpf_cnpj,
        status: dados.historyListOrderStatus?.[0]?.statusCode || 'DESCONHECIDO',
        valor_total: dados.total,
        valor_frete: dados.totalShipping,
        desconto: dados.totalDiscount,
        data_pedido: dados.dateOrder,
        endereco: {
          rua: dados.address?.streetAddress,
          numero: dados.address?.number,
          complemento: dados.address?.complement,
          bairro: dados.address?.neighbourhood,
          cidade: dados.address?.city,
          estado: dados.address?.state,
          cep: dados.address?.zipCode,
          destinatario: dados.address?.receiver
        },
        produtos: (dados.orderItems || []).map(item => ({
          id: item.idProduct,
          codigo: item.productCode,
          nome: item.name?.replace(/<[^>]*>/g, ''), // Remove HTML tags
          quantidade: item.quantity,
          preco_unitario: item.unitPrice,
          total: item.total,
          marca: item.brand,
          categoria: item.category
        })),
        pagamento: {
          metodo: dados.namePaymentMethodGateway,
          parcelas: dados.numberOfInstallments,
          valor_parcela: dados.valueOfInstallment
        },
        rastreamento: {
          transportadora: dados.shippingCompany,
          numero_rastreamento: dados.historyListOrderStatus?.[0]?.orderInfo?.trackingNumber || null,
          link_rastreamento: dados.historyListOrderStatus?.[0]?.trackingLink || null
        }
      };
    } catch (error) {
      console.error('❌ Erro ao extrair info JET:', error.message);
      return null;
    }
  }
};

module.exports = jetApi;