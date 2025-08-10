const http = require('http');
const url = require('url');
const { InventoryManager, NotFoundError, InsufficientStockError, InvalidRequestError } = require('./InventoryManager');
const mysql = require('mysql2/promise');

const DB_CONFIG = {
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'managestock_db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
};

(async () => {
  const pool = await mysql.createPool(DB_CONFIG);
  const manager = new InventoryManager(pool, { lowStockThreshold: 5, logFile: 'transactions.log' });

  manager.on('lowStock', info => {
    console.warn('NOTIF: Stok rendah:', info);
  });

  function parseJsonBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
        if (body.length > 1e6) {
          req.connection.destroy();
          reject(new InvalidRequestError('Request body terlalu besar'));
        }
      });
      req.on('end', () => {
        if (!body) return resolve({});
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new InvalidRequestError('JSON body tidak valid'));
        }
      });
      req.on('error', reject);
    });
  }

  function sendJson(res, statusCode, data) {
    const json = JSON.stringify(data);
    res.writeHead(statusCode, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(json),
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end(json);
  }

  const server = http.createServer(async (req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      return res.end();
    }

    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;
    const method = req.method;

    try {
      // POST /products - tambah produk
      if (method === 'POST' && pathname === '/products') {
        const body = await parseJsonBody(req);
        const { productCode, name, price, stock, category } = body;

        if (!name || price == null || stock == null || !category) {
          return sendJson(res, 400, { error: 'Field wajib diisi: name, price, stock, category' });
        }

        const result = await manager.addProduct(productCode, name, Number(price), Number(stock), category);
        return sendJson(res, 201, { message: 'Produk berhasil ditambahkan', ...result });
      }

      // GET /products - list produk
      if (method === 'GET' && pathname === '/products') {
        const { category, page = '1', limit = '10' } = parsedUrl.query;
        const products = await manager.getAllProducts({ category, page: Number(page), limit: Number(limit) });
        return sendJson(res, 200, products);
      }

      // PUT /products/:id - update produk
      if (method === 'PUT' && pathname.startsWith('/products/')) {
        const idOrCode = pathname.split('/')[2];
        const body = await parseJsonBody(req);

        if (body.quantity != null && body.transactionType) {
          try {
            const updatedProduct = await manager.updateStock(idOrCode, Number(body.quantity), body.transactionType);
            return sendJson(res, 200, { message: 'Stok berhasil diperbarui', product: updatedProduct });
          } catch (err) {
            if (err instanceof NotFoundError) return sendJson(res, 404, { error: err.message });
            if (err instanceof InsufficientStockError) return sendJson(res, 400, { error: err.message });
            if (err instanceof InvalidRequestError) return sendJson(res, 400, { error: err.message });
            throw err;
          }
        }

        const fieldsToUpdate = {};
        if (body.name) fieldsToUpdate.name = body.name;
        if (body.price != null) fieldsToUpdate.price = Number(body.price);
        if (body.category) fieldsToUpdate.category = body.category;
        if (body.stock != null) fieldsToUpdate.stock = Number(body.stock);

        if (Object.keys(fieldsToUpdate).length === 0) {
          return sendJson(res, 400, { error: 'Tidak ada field untuk diupdate' });
        }

        const product = await manager._resolveProduct(idOrCode);
        if (!product) return sendJson(res, 404, { error: 'Produk tidak ditemukan' });

        const setParts = [];
        const params = [];
        for (const key in fieldsToUpdate) {
          setParts.push(`${key} = ?`);
          params.push(fieldsToUpdate[key]);
        }
        params.push(product.id);
        const sql = `UPDATE products SET ${setParts.join(', ')} WHERE id = ?`;
        await pool.execute(sql, params);

        const [updatedRows] = await pool.execute('SELECT * FROM products WHERE id = ?', [product.id]);
        return sendJson(res, 200, { message: 'Produk berhasil diupdate', product: updatedRows[0] });
      }

      // POST /transactions - buat transaksi baru (cek duplikat)
      if (method === 'POST' && pathname === '/transactions') {
        const body = await parseJsonBody(req);
        const { transactionId, productId, quantity, type, customerId } = body;

        if (!transactionId || !productId || quantity == null || !type) {
          return sendJson(res, 400, { error: 'Field wajib diisi: transactionId, productId, quantity, type' });
        }

        // Cek duplikat transactionId
        const [existing] = await pool.execute('SELECT * FROM transactions WHERE transaction_id = ?', [transactionId]);
        if (existing.length > 0) {
          return sendJson(res, 400, { error: `transactionId '${transactionId}' sudah digunakan` });
        }

        const result = await manager.createTransaction(transactionId, productId, Number(quantity), type, customerId);
        return sendJson(res, 201, { message: 'Transaksi berhasil dibuat', ...result });
      }

      // GET /transactions - list transaksi
      if (method === 'GET' && pathname === '/transactions') {
        const [transactions] = await pool.execute('SELECT * FROM transactions ORDER BY date DESC');
        return sendJson(res, 200, transactions);
      }

      // GET /reports/inventory - total nilai inventaris
      if (method === 'GET' && pathname === '/reports/inventory') {
        const totalValue = await manager.getInventoryValue();
        return sendJson(res, 200, { total_inventory_value: totalValue });
      }

      // GET /reports/low-stock - produk stok rendah
      if (method === 'GET' && pathname === '/reports/low-stock') {
        const threshold = parsedUrl.query.threshold ? Number(parsedUrl.query.threshold) : undefined;
        const lowStockList = await manager.getLowStockList(threshold);
        return sendJson(res, 200, lowStockList);
      }

      // GET /products/:id/history - riwayat produk
      if (method === 'GET' && pathname.startsWith('/products/') && pathname.endsWith('/history')) {
        const idOrCode = pathname.split('/')[2];
        try {
          const history = await manager.getProductHistory(idOrCode);
          return sendJson(res, 200, history);
        } catch (err) {
          if (err instanceof NotFoundError) return sendJson(res, 404, { error: err.message });
          throw err;
        }
      }

      // fallback endpoint tidak ditemukan
      sendJson(res, 404, { error: 'Endpoint tidak ditemukan' });

    } catch (err) {
      console.error('Error server:', err);
      if (err instanceof InvalidRequestError) {
        return sendJson(res, 400, { error: err.message });
      }
      sendJson(res, 500, { error: 'Internal Server Error', detail: err.message });
    }
  });

  server.listen(3000, () => {
    console.log('Server berjalan di http://localhost:3000');
  });
})();
