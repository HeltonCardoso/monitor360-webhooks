// public/js/dashboard.js

// Função para mostrar alertas
function showAlert(message, type = 'info') {
  const alertContainer = document.getElementById('alertContainer');
  const alertId = 'alert-' + Date.now();
  
  const alertHtml = `
    <div class="alert alert-${type} alert-dismissible fade show" id="${alertId}" role="alert">
      ${message}
      <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
    </div>
  `;
  
  alertContainer.innerHTML += alertHtml;
  
  // Auto-remover após 5 segundos
  setTimeout(() => {
    const alert = document.getElementById(alertId);
    if (alert) alert.remove();
  }, 5000);
}

// Função para formatar moeda
function formatarMoeda(valor) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  }).format(valor);
}

// Função para formatar data
function formatarData(data) {
  return new Date(data).toLocaleString('pt-BR');
}