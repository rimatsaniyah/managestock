const mysql = require('mysql2');

const connection = mysql.createConnection({
  host: 'localhost',
  user: 'root',
  password: '', // sesuaikan
  database: 'managestock_db'
});

connection.connect(err => {
  if (err) throw err;
  console.log('Koneksi ke database berhasil');
});

module.exports = connection;
