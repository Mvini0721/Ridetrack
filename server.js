// server.js
const express = require('express');
const cors = require('cors');
const { MailParser } = require('mailparser');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.raw({ type: 'message/rfc822', limit: '10mb' }));

// Banco de dados SQLite
const db = new sqlite3.Database('./rides.db', (err) => {
  if (err) console.error(err);
  else console.log('✓ Banco de dados conectado');
});

// Criar tabelas
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    unique_email TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS rides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    platform TEXT NOT NULL,
    value REAL NOT NULL,
    origin TEXT,
    destination TEXT,
    datetime DATETIME NOT NULL,
    raw_email TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);
});

// Gerar email único para usuário
function generateUniqueEmail() {
  return `corridas-${crypto.randomBytes(6).toString('hex')}@ridetrack.app`;
}

// Parsear email do Uber
function parseUberReceipt(text, html) {
  const ride = { platform: 'uber' };
  
  // Extrair valor
  const valueMatch = text.match(/R\$\s*([0-9,]+\.?[0-9]*)/i) || 
                     html.match(/R\$\s*([0-9,]+\.?[0-9]*)/i);
  if (valueMatch) {
    ride.value = parseFloat(valueMatch[1].replace(',', '.'));
  }

  // Extrair origem e destino
  const routeMatch = text.match(/(?:De|From):\s*(.+?)\s*(?:Para|To):\s*(.+?)(?:\n|$)/is);
  if (routeMatch) {
    ride.origin = routeMatch[1].trim();
    ride.destination = routeMatch[2].trim();
  }

  // Extrair data
  const dateMatch = text.match(/(\d{1,2})\s+de\s+(\w+)\s+de\s+(\d{4})/i);
  if (dateMatch) {
    const months = {
      'janeiro': 0, 'fevereiro': 1, 'março': 2, 'abril': 3,
      'maio': 4, 'junho': 5, 'julho': 6, 'agosto': 7,
      'setembro': 8, 'outubro': 9, 'novembro': 10, 'dezembro': 11
    };
    const month = months[dateMatch[2].toLowerCase()];
    ride.datetime = new Date(dateMatch[3], month, dateMatch[1]);
  }

  return ride.value ? ride : null;
}

// Parsear email do 99
function parse99Receipt(text, html) {
  const ride = { platform: '99' };
  
  // Extrair valor
  const valueMatch = text.match(/R\$\s*([0-9,]+\.?[0-9]*)/i) || 
                     html.match(/R\$\s*([0-9,]+\.?[0-9]*)/i);
  if (valueMatch) {
    ride.value = parseFloat(valueMatch[1].replace(',', '.'));
  }

  // Extrair origem e destino
  const originMatch = text.match(/(?:Origem|Partida):\s*(.+?)(?:\n|$)/i);
  const destMatch = text.match(/(?:Destino|Chegada):\s*(.+?)(?:\n|$)/i);
  
  if (originMatch) ride.origin = originMatch[1].trim();
  if (destMatch) ride.destination = destMatch[1].trim();

  // Extrair data
  const dateMatch = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (dateMatch) {
    ride.datetime = new Date(dateMatch[3], dateMatch[2] - 1, dateMatch[1]);
  }

  return ride.value ? ride : null;
}

// Processar email recebido
async function processEmail(rawEmail, userEmail) {
  return new Promise((resolve, reject) => {
    const parser = new MailParser();
    
    parser.on('end', async (mail) => {
      const from = mail.from?.text?.toLowerCase() || '';
      const subject = mail.subject?.toLowerCase() || '';
      const text = mail.text || '';
      const html = mail.html || '';
      
      let ride = null;

      // Detectar plataforma e parsear
      if (from.includes('uber') || subject.includes('uber')) {
        ride = parseUberReceipt(text, html);
      } else if (from.includes('99') || subject.includes('99')) {
        ride = parse99Receipt(text, html);
      }

      if (ride) {
        ride.raw_email = rawEmail;
        
        // Buscar user_id
        db.get('SELECT id FROM users WHERE unique_email = ?', [userEmail], (err, user) => {
          if (err || !user) {
            reject(new Error('Usuário não encontrado'));
            return;
          }

          // Inserir corrida
          db.run(
            `INSERT INTO rides (user_id, platform, value, origin, destination, datetime, raw_email)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [user.id, ride.platform, ride.value, ride.origin, ride.destination, 
             ride.datetime || new Date(), ride.raw_email],
            function(err) {
              if (err) reject(err);
              else resolve({ ...ride, id: this.lastID });
            }
          );
        });
      } else {
        reject(new Error('Não foi possível extrair informações do email'));
      }
    });

    parser.write(rawEmail);
    parser.end();
  });
}

// ROTAS DA API

// Criar novo usuário
app.post('/api/users', (req, res) => {
  const { email } = req.body;
  const uniqueEmail = generateUniqueEmail();

  db.run(
    'INSERT INTO users (email, unique_email) VALUES (?, ?)',
    [email, uniqueEmail],
    function(err) {
      if (err) {
        return res.status(400).json({ error: 'Email já cadastrado' });
      }
      res.json({ 
        id: this.lastID, 
        email, 
        uniqueEmail,
        message: 'Configure seus apps para enviar recibos para: ' + uniqueEmail
      });
    }
  );
});

// Buscar dados do usuário
app.get('/api/users/:email', (req, res) => {
  db.get(
    'SELECT * FROM users WHERE email = ? OR unique_email = ?',
    [req.params.email, req.params.email],
    (err, user) => {
      if (err || !user) {
        return res.status(404).json({ error: 'Usuário não encontrado' });
      }
      res.json(user);
    }
  );
});

// Receber email (webhook)
app.post('/api/webhook/email', async (req, res) => {
  const toEmail = req.headers['x-to-email'] || req.query.to;
  const rawEmail = req.body.toString();

  try {
    const ride = await processEmail(rawEmail, toEmail);
    res.json({ success: true, ride });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Listar corridas do usuário
app.get('/api/rides/:userEmail', (req, res) => {
  db.get('SELECT id FROM users WHERE email = ? OR unique_email = ?', 
    [req.params.userEmail, req.params.userEmail], 
    (err, user) => {
      if (err || !user) {
        return res.status(404).json({ error: 'Usuário não encontrado' });
      }

      db.all(
        'SELECT * FROM rides WHERE user_id = ? ORDER BY datetime DESC',
        [user.id],
        (err, rides) => {
          if (err) return res.status(500).json({ error: err.message });
          res.json(rides);
        }
      );
    }
  );
});

// Adicionar corrida manual
app.post('/api/rides', (req, res) => {
  const { userEmail, platform, value, origin, destination, datetime } = req.body;

  db.get('SELECT id FROM users WHERE email = ? OR unique_email = ?',
    [userEmail, userEmail],
    (err, user) => {
      if (err || !user) {
        return res.status(404).json({ error: 'Usuário não encontrado' });
      }

      db.run(
        `INSERT INTO rides (user_id, platform, value, origin, destination, datetime)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [user.id, platform, value, origin, destination, datetime || new Date()],
        function(err) {
          if (err) return res.status(500).json({ error: err.message });
          res.json({ 
            id: this.lastID, 
            platform, 
            value, 
            origin, 
            destination, 
            datetime 
          });
        }
      );
    }
  );
});

// Deletar corrida
app.delete('/api/rides/:id', (req, res) => {
  db.run('DELETE FROM rides WHERE id = ?', [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, deleted: this.changes });
  });
});

// Estatísticas do usuário
app.get('/api/stats/:userEmail', (req, res) => {
  db.get('SELECT id FROM users WHERE email = ? OR unique_email = ?',
    [req.params.userEmail, req.params.userEmail],
    (err, user) => {
      if (err || !user) {
        return res.status(404).json({ error: 'Usuário não encontrado' });
      }

      db.all(
        'SELECT * FROM rides WHERE user_id = ?',
        [user.id],
        (err, rides) => {
          if (err) return res.status(500).json({ error: err.message });

          const total = rides.reduce((sum, r) => sum + r.value, 0);
          const count = rides.length;
          const avg = count > 0 ? total / count : 0;

          const now = new Date();
          const monthRides = rides.filter(r => {
            const d = new Date(r.datetime);
            return d.getMonth() === now.getMonth() && 
                   d.getFullYear() === now.getFullYear();
          });
          const monthTotal = monthRides.reduce((sum, r) => sum + r.value, 0);

          res.json({
            totalSpent: total,
            totalRides: count,
            averageRide: avg,
            monthSpent: monthTotal,
            monthRides: monthRides.length
          });
        }
      );
    }
  );
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`📧 Webhook de email: http://localhost:${PORT}/api/webhook/email`);
});

module.exports = app;