const API_BASE = 'http://localhost:3000'; // sesuaikan dengan backend kamu

const startDateInput = document.getElementById('startDate');
const endDateInput = document.getElementById('endDate');
const filterBtn = document.getElementById('filterBtn');

const salesPerMonthCtx = document.getElementById('salesPerMonthChart').getContext('2d');
const salesPerCategoryCtx = document.getElementById('salesPerCategoryChart').getContext('2d');
const topProductsTableBody = document.querySelector('#topProductsTable tbody');

let salesPerMonthChart, salesPerCategoryChart;

filterBtn.addEventListener('click', () => {
  const startDate = startDateInput.value;
  const endDate = endDateInput.value;
  loadDashboard(startDate, endDate);
});

// Fungsi utama untuk load data dashboard
async function loadDashboard(startDate, endDate) {
  try {
    // Fetch semua transaksi penjualan dari backend
    const res = await fetch(`${API_BASE}/transactions`);
    if (!res.ok) throw new Error('Gagal fetch data transaksi');
    let transactions = await res.json();

    // Filter transaksi berdasarkan tanggal jika ada
    if (startDate) {
      transactions = transactions.filter(t => new Date(t.date) >= new Date(startDate));
    }
    if (endDate) {
      transactions = transactions.filter(t => new Date(t.date) <= new Date(endDate));
    }

    // Fetch semua produk untuk dapatkan info nama dan kategori
    const resProd = await fetch(`${API_BASE}/products?limit=1000`);
    if (!resProd.ok) throw new Error('Gagal fetch data produk');
    const products = await resProd.json();

    // Buat map produk id ke objek produk untuk lookup cepat
    const productMap = {};
    products.forEach(p => productMap[p.id] = p);

    // Tambahkan info produk ke transaksi
    transactions = transactions.map(t => ({
      ...t,
      productName: productMap[t.productId]?.name || 'Unknown',
      category: productMap[t.productId]?.category || 'Unknown'
    }));

    renderSalesPerMonth(transactions);
    renderSalesPerCategory(transactions);
    renderTopProducts(transactions);

  } catch (error) {
    alert('Error load dashboard: ' + error.message);
  }
}

function renderSalesPerMonth(transactions) {
  const monthlySales = {};

  transactions.forEach(t => {
    if (t.type !== 'sell') return;
    const date = new Date(t.date);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    monthlySales[key] = (monthlySales[key] || 0) + (t.total_price || 0);
  });

  const labels = Object.keys(monthlySales).sort();
  const data = labels.map(k => monthlySales[k]);

  if (salesPerMonthChart) salesPerMonthChart.destroy();

  salesPerMonthChart = new Chart(salesPerMonthCtx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Total Penjualan per Bulan (Rp)',
        data,
        backgroundColor: 'rgba(54, 162, 235, 0.7)',
      }]
    },
    options: {
      responsive: true,
      scales: {
        y: { beginAtZero: true }
      },
      plugins: {
        tooltip: {
          callbacks: {
            label: ctx => 'Rp ' + ctx.parsed.y.toLocaleString('id-ID')
          }
        }
      }
    }
  });
}

function renderSalesPerCategory(transactions) {
  const categorySales = {};

  transactions.forEach(t => {
    if (t.type !== 'sell') return;
    const cat = t.category || 'Unknown';
    categorySales[cat] = (categorySales[cat] || 0) + (t.total_price || 0);
  });

  const labels = Object.keys(categorySales);
  const data = labels.map(k => categorySales[k]);

  if (salesPerCategoryChart) salesPerCategoryChart.destroy();

  salesPerCategoryChart = new Chart(salesPerCategoryCtx, {
    type: 'pie',
    data: {
      labels,
      datasets: [{
        label: 'Penjualan per Kategori',
        data,
        backgroundColor: labels.map(() => `hsl(${Math.random() * 360}, 70%, 60%)`),
      }]
    },
    options: { responsive: true }
  });
}

function renderTopProducts(transactions) {
  const productSales = {};

  transactions.forEach(t => {
    if (t.type !== 'sell') return;
    const pid = t.productId || t.product_id;
    if (!productSales[pid]) productSales[pid] = { name: '', quantity: 0, total: 0 };

    productSales[pid].quantity += t.quantity;
    productSales[pid].total += t.total_price || 0;
  });

  const sorted = Object.entries(productSales)
    .map(([id, data]) => ({ id, ...data, name: data.name || 'Unknown' }))
    .sort((a, b) => b.quantity - a.quantity)
    .slice(0, 10);

  topProductsTableBody.innerHTML = '';

  sorted.forEach((item, idx) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${idx + 1}</td>
      <td>${item.name || item.id}</td>
      <td>${item.quantity}</td>
      <td>${item.total.toLocaleString('id-ID', { style: 'currency', currency: 'IDR' })}</td>
    `;
    topProductsTableBody.appendChild(tr);
  });
}

// Load data awal
loadDashboard();
