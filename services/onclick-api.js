const onlickApi = {
  async buscarDetalhesPedido(pedidoId) {
    try {
      // Você não tem acesso à API Onlick ainda
      // Retorna null para que o sistema use dados do webhook
      console.log(`⚠️ API Onlick não disponível para pedido ${pedidoId}`);
      return null;
    } catch (error) {
      console.error(`❌ Erro ao buscar pedido Onlick ${pedidoId}:`, error.message);
      return null;
    }
  },

  extrairInfoRelevante(dados) {
    if (!dados) return null;
    
    try {
      return {
        id: dados.pedido_id || dados.id,
        status: dados.status,
        invoice_number: dados.invoice_number || dados.invoiceNumber,
        data_faturamento: dados.timestamp || new Date().toISOString(),
        rastreamento: dados.tracking_number || null
      };
    } catch (error) {
      console.error('❌ Erro ao extrair info Onlick:', error.message);
      return null;
    }
  }
};

module.exports = onlickApi;