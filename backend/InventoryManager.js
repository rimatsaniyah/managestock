const fs = require('fs');
const { EventEmitter } = require('events');

class NotFoundError extends Error { constructor(msg){ super(msg); this.name='NotFoundError'; } }
class InsufficientStockError extends Error { constructor(msg){ super(msg); this.name='InsufficientStockError'; } }
class InvalidRequestError extends Error { constructor(msg){ super(msg); this.name='InvalidRequestError'; } }

class InventoryManager extends EventEmitter {
  constructor(dbPool, opts = {}) {
    super();
    this.db = dbPool;
    this.lowStockThreshold = opts.lowStockThreshold ?? 5;
    this.logFile = opts.logFile ?? 'transactions.log';
  }

  async _logTransaction(text) {
    const line = `[${new Date().toISOString()}] ${text}\n`;
    fs.appendFile(this.logFile, line, (err) => {
      if (err) console.error('Gagal menulis log:', err);
    });
  }

  async _resolveProduct(productIdentifier) {
    let sql, params;
    if (!isNaN(productIdentifier)) {
      sql = 'SELECT * FROM products WHERE id = ? LIMIT 1';
      params = [Number(productIdentifier)];
    } else {
      sql = 'SELECT * FROM products WHERE productCode = ? LIMIT 1';
      params = [productIdentifier];
    }
    const [rows] = await this.db.execute(sql, params);
    return rows.length ? rows[0] : null;
  }

  async generateProductCode() {
    const [rows] = await this.db.execute('SELECT productCode FROM products ORDER BY id DESC LIMIT 1');
    if (!rows.length || !rows[0].productCode) return 'P001';
    const last = rows[0].productCode;
    const num = parseInt(last.replace(/^P0*/, '') || '0', 10) + 1;
    return `P${String(num).padStart(3, '0')}`;
  }

  async addProduct(productCode, name, price, stock, category) {
    if (price == null || stock == null || !name || !category) {
      throw new InvalidRequestError('Field wajib diisi');
    }
    if (price < 0 || stock < 0) throw new InvalidRequestError('Harga atau stok tidak boleh negatif');

    let code = productCode;
    if (!code) code = await this.generateProductCode();

    const sql = `INSERT INTO products (productCode, name, price, stock, category, created_at)
                 VALUES (?, ?, ?, ?, ?, NOW())`;
    await this.db.execute(sql, [code, name, price, stock, category]);
    return { productCode: code };
  }

  async updateStock(productIdentifier, quantity, transactionType) {
    if (!quantity || quantity <= 0) throw new InvalidRequestError('Quantity harus > 0');
    const type = String(transactionType).toLowerCase();
    const mode = (type === 'buy' || type === 'add') ? 'add' :
                 (type === 'sell' || type === 'sale') ? 'sell' : null;
    if (!mode) throw new InvalidRequestError('Jenis transaksi tidak valid');

    const product = await this._resolveProduct(productIdentifier);
    if (!product) throw new NotFoundError('Produk tidak ditemukan');

    let newStock = Number(product.stock);
    if (mode === 'add') {
      newStock += Number(quantity);
    } else {
      if (newStock < quantity) throw new InsufficientStockError('Stok tidak mencukupi');
      newStock -= Number(quantity);
    }

    await this.db.execute('UPDATE products SET stock = ? WHERE id = ?', [newStock, product.id]);

    if (newStock <= this.lowStockThreshold) {
      this.emit('lowStock', { productId: product.id, productCode: product.productCode, newStock });
    }

    const [rows] = await this.db.execute('SELECT * FROM products WHERE id = ?', [product.id]);
    return rows[0];
  }

  async createTransaction(transactionId, productIdentifier, quantity, type, customerId = null) {
    if (!transactionId) throw new InvalidRequestError('transactionId dibutuhkan');
    if (!productIdentifier) throw new InvalidRequestError('productId dibutuhkan');
    if (!quantity || quantity <= 0) throw new InvalidRequestError('quantity harus > 0');

    const transType = String(type).toLowerCase();
    if (!['sell', 'buy', 'sale', 'purchase', 'add'].includes(transType)) {
      throw new InvalidRequestError('type transaksi tidak valid');
    }

    const product = await this._resolveProduct(productIdentifier);
    if (!product) throw new NotFoundError('Produk tidak ditemukan');

    let discountPercent = 0;
    if (Number(quantity) >= 10) discountPercent += 5;

    if (customerId) {
      const [custRows] = await this.db.execute(
        'SELECT * FROM customers WHERE id = ? OR name = ? LIMIT 1',
        [customerId, customerId]
      );
      const customer = custRows.length ? custRows[0] : null;
      if (customer && String(customer.category).toLowerCase() === 'vip') discountPercent += 5;
    }

    const unitPrice = Number(product.price);
    const gross = unitPrice * Number(quantity);
    const totalPrice = +(gross * (1 - discountPercent / 100)).toFixed(2);

    const updateType = (['sell', 'sale'].includes(transType)) ? 'sell' : 'add';
    await this.updateStock(product.id, quantity, updateType);

    const sql = `INSERT INTO transactions (transaction_id, product_id, quantity, type, customer_id, total_price, date)
                 VALUES (?, ?, ?, ?, ?, ?, NOW())`;
    await this.db.execute(sql, [transactionId, product.id, quantity, updateType, customerId || null, totalPrice]);

    await this._logTransaction(`TID=${transactionId} PROD=${product.id}/${product.productCode} QTY=${quantity} TYPE=${updateType} TOTAL=${totalPrice}`);

    return {
      transactionId,
      productId: product.id,
      productCode: product.productCode,
      quantity,
      type: updateType,
      totalPrice
    };
  }

  async getProductsByCategory(category, page = 1, limit = 10) {
    const offset = (Math.max(1, Number(page)) - 1) * Number(limit);
    const sql = `SELECT * FROM products WHERE LOWER(category) LIKE LOWER(?) ORDER BY id LIMIT ? OFFSET ?`;
    const [rows] = await this.db.execute(sql, [`%${category}%`, Number(limit), Number(offset)]);
    return rows;
  }

  async getInventoryValue() {
    const [rows] = await this.db.execute('SELECT SUM(price * stock) AS total FROM products');
    return rows[0].total || 0;
  }

  async getProductHistory(productIdentifier) {
    const product = await this._resolveProduct(productIdentifier);
    if (!product) throw new NotFoundError('Produk tidak ditemukan');
    const [rows] = await this.db.execute('SELECT * FROM transactions WHERE product_id = ? ORDER BY date DESC', [product.id]);
    return rows;
  }

  async getAllProducts({ category = null, page = 1, limit = 10 } = {}) {
    const offset = (Math.max(1, Number(page)) - 1) * Number(limit);
    if (category) {
      const sql = 'SELECT * FROM products WHERE LOWER(category) LIKE LOWER(?) ORDER BY id LIMIT ? OFFSET ?';
      const [rows] = await this.db.execute(sql, [`%${category}%`, Number(limit), offset]);
      return rows;
    } else {
      const sql = 'SELECT * FROM products ORDER BY id LIMIT ? OFFSET ?';
      const [rows] = await this.db.execute(sql, [Number(limit), offset]);
      return rows;
    }
  }

  async getLowStockList(threshold = null) {
    const t = threshold ?? this.lowStockThreshold;
    const [rows] = await this.db.execute('SELECT * FROM products WHERE stock <= ? ORDER BY stock ASC', [t]);
    return rows;
  }
}

module.exports = { InventoryManager, NotFoundError, InsufficientStockError, InvalidRequestError };
