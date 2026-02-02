const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const cron = require('node-cron');
const path = require('path');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

// Middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100
});
app.use('/api/', limiter);

// File upload configuration
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'public/uploads/');
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage: storage });

// Database setup
const db = new sqlite3.Database('./database/database.db', (err) => {
    if (err) console.error(err);
    console.log('✅ Database connected');
});

// Create tables
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS contacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        phone TEXT UNIQUE,
        email TEXT,
        tags TEXT,
        custom_fields TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS campaigns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        message TEXT,
        media_url TEXT,
        media_type TEXT,
        status TEXT DEFAULT 'draft',
        scheduled_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER,
        contact_id INTEGER,
        phone TEXT,
        message TEXT,
        status TEXT DEFAULT 'pending',
        sent_at DATETIME,
        delivered_at DATETIME,
        read_at DATETIME,
        error TEXT,
        FOREIGN KEY (campaign_id) REFERENCES campaigns (id),
        FOREIGN KEY (contact_id) REFERENCES contacts (id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        content TEXT,
        variables TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
    )`);
});

// WhatsApp client initialization
let client;
let isClientReady = false;
let qrCodeData = null;

function initializeWhatsApp() {
    client = new Client({
        authStrategy: new LocalAuth({
            clientId: "whatsapp-bulk-sender"
        }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-gpu'
            ]
        }
    });

    client.on('qr', async (qr) => {
        console.log('📱 QR Code received');
        qrCodeData = await qrcode.toDataURL(qr);
        io.emit('qr', qrCodeData);
    });

    client.on('ready', () => {
        console.log('✅ WhatsApp Client is ready!');
        isClientReady = true;
        io.emit('ready', { status: 'connected' });
    });

    client.on('authenticated', () => {
        console.log('🔐 WhatsApp authenticated');
        io.emit('authenticated');
    });

    client.on('auth_failure', (msg) => {
        console.error('❌ Authentication failure:', msg);
        io.emit('auth_failure', msg);
    });

    client.on('disconnected', (reason) => {
        console.log('⚠️ WhatsApp disconnected:', reason);
        isClientReady = false;
        io.emit('disconnected', reason);
    });

    client.on('message_create', (msg) => {
        // Handle incoming messages if needed
        io.emit('message_received', {
            from: msg.from,
            body: msg.body,
            timestamp: msg.timestamp
        });
    });

    client.initialize();
}

// Initialize WhatsApp on server start
initializeWhatsApp();

// Helper function to delay between messages
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Function to send bulk messages
async function sendBulkMessages(campaignId) {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT m.*, c.name FROM messages m 
             LEFT JOIN contacts c ON m.contact_id = c.id 
             WHERE m.campaign_id = ? AND m.status = 'pending'`,
            [campaignId],
            async (err, messages) => {
                if (err) {
                    reject(err);
                    return;
                }

                let sent = 0;
                let failed = 0;

                for (const msg of messages) {
                    try {
                        if (!isClientReady) {
                            throw new Error('WhatsApp client not ready');
                        }

                        let formattedPhone = msg.phone.replace(/\D/g, '');
                        if (!formattedPhone.includes('@c.us')) {
                            formattedPhone = formattedPhone + '@c.us';
                        }

                        // Get campaign details for media
                        const campaign = await new Promise((res, rej) => {
                            db.get('SELECT * FROM campaigns WHERE id = ?', [campaignId], (err, row) => {
                                if (err) rej(err);
                                else res(row);
                            });
                        });

                        // Send message
                        if (campaign.media_url) {
                            const media = await MessageMedia.fromUrl(campaign.media_url);
                            await client.sendMessage(formattedPhone, media, {
                                caption: msg.message
                            });
                        } else {
                            await client.sendMessage(formattedPhone, msg.message);
                        }

                        // Update message status
                        db.run(
                            `UPDATE messages SET status = 'sent', sent_at = CURRENT_TIMESTAMP WHERE id = ?`,
                            [msg.id]
                        );

                        sent++;
                        io.emit('message_sent', {
                            campaignId,
                            messageId: msg.id,
                            phone: msg.phone,
                            sent,
                            total: messages.length
                        });

                        // Delay to avoid spam detection (random 3-8 seconds)
                        await delay(3000 + Math.random() * 5000);

                    } catch (error) {
                        console.error('Error sending to', msg.phone, ':', error);
                        db.run(
                            `UPDATE messages SET status = 'failed', error = ? WHERE id = ?`,
                            [error.message, msg.id]
                        );
                        failed++;
                    }
                }

                // Update campaign status
                db.run(
                    `UPDATE campaigns SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = ?`,
                    [campaignId]
                );

                resolve({ sent, failed, total: messages.length });
            }
        );
    });
}

// ==================== API ROUTES ====================

// Serve main page
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// Get WhatsApp status
app.get('/api/status', (req, res) => {
    res.json({
        ready: isClientReady,
        qr: qrCodeData
    });
});

// Logout WhatsApp
app.post('/api/logout', async (req, res) => {
    try {
        await client.logout();
        isClientReady = false;
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== CONTACTS ====================

// Get all contacts
app.get('/api/contacts', (req, res) => {
    db.all('SELECT * FROM contacts ORDER BY created_at DESC', [], (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(rows);
    });
});

// Add contact
app.post('/api/contacts', (req, res) => {
    const { name, phone, email, tags, custom_fields } = req.body;
    
    db.run(
        `INSERT INTO contacts (name, phone, email, tags, custom_fields) VALUES (?, ?, ?, ?, ?)`,
        [name, phone, email, JSON.stringify(tags), JSON.stringify(custom_fields)],
        function(err) {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }
            res.json({ id: this.lastID, success: true });
        }
    );
});

// Update contact
app.put('/api/contacts/:id', (req, res) => {
    const { name, phone, email, tags, custom_fields } = req.body;
    
    db.run(
        `UPDATE contacts SET name = ?, phone = ?, email = ?, tags = ?, custom_fields = ? WHERE id = ?`,
        [name, phone, email, JSON.stringify(tags), JSON.stringify(custom_fields), req.params.id],
        function(err) {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }
            res.json({ success: true });
        }
    );
});

// Delete contact
app.delete('/api/contacts/:id', (req, res) => {
    db.run('DELETE FROM contacts WHERE id = ?', [req.params.id], function(err) {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json({ success: true });
    });
});

// Import contacts from CSV
app.post('/api/contacts/import', upload.single('file'), (req, res) => {
    const results = [];
    
    fs.createReadStream(req.file.path)
        .pipe(csv())
        .on('data', (data) => results.push(data))
        .on('end', () => {
            const stmt = db.prepare(
                `INSERT OR IGNORE INTO contacts (name, phone, email, tags) VALUES (?, ?, ?, ?)`
            );
            
            results.forEach(row => {
                stmt.run(row.name || '', row.phone || '', row.email || '', row.tags || '');
            });
            
            stmt.finalize();
            fs.unlinkSync(req.file.path);
            
            res.json({ success: true, imported: results.length });
        });
});

// ==================== CAMPAIGNS ====================

// Get all campaigns
app.get('/api/campaigns', (req, res) => {
    db.all('SELECT * FROM campaigns ORDER BY created_at DESC', [], (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(rows);
    });
});

// Get campaign details
app.get('/api/campaigns/:id', (req, res) => {
    db.get('SELECT * FROM campaigns WHERE id = ?', [req.params.id], (err, campaign) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        
        db.all(
            'SELECT * FROM messages WHERE campaign_id = ?',
            [req.params.id],
            (err, messages) => {
                if (err) {
                    res.status(500).json({ error: err.message });
                    return;
                }
                
                res.json({
                    ...campaign,
                    messages,
                    stats: {
                        total: messages.length,
                        sent: messages.filter(m => m.status === 'sent').length,
                        failed: messages.filter(m => m.status === 'failed').length,
                        pending: messages.filter(m => m.status === 'pending').length
                    }
                });
            }
        );
    });
});

// Create campaign
app.post('/api/campaigns', upload.single('media'), (req, res) => {
    const { name, message, contacts, scheduled_at } = req.body;
    const media_url = req.file ? `/uploads/${req.file.filename}` : null;
    const media_type = req.file ? req.file.mimetype : null;
    
    db.run(
        `INSERT INTO campaigns (name, message, media_url, media_type, status, scheduled_at) 
         VALUES (?, ?, ?, ?, ?, ?)`,
        [name, message, media_url, media_type, scheduled_at ? 'scheduled' : 'draft', scheduled_at],
        function(err) {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }
            
            const campaignId = this.lastID;
            const contactIds = JSON.parse(contacts);
            
            // Create message entries for each contact
            const stmt = db.prepare(
                `INSERT INTO messages (campaign_id, contact_id, phone, message, status) 
                 VALUES (?, ?, ?, ?, 'pending')`
            );
            
            db.all(
                `SELECT * FROM contacts WHERE id IN (${contactIds.join(',')})`,
                [],
                (err, rows) => {
                    if (err) {
                        res.status(500).json({ error: err.message });
                        return;
                    }
                    
                    rows.forEach(contact => {
                        // Replace variables in message
                        let personalizedMessage = message
                            .replace(/\{name\}/g, contact.name)
                            .replace(/\{phone\}/g, contact.phone)
                            .replace(/\{email\}/g, contact.email);
                        
                        stmt.run(campaignId, contact.id, contact.phone, personalizedMessage);
                    });
                    
                    stmt.finalize();
                    res.json({ id: campaignId, success: true });
                }
            );
        }
    );
});

// Start campaign
app.post('/api/campaigns/:id/start', async (req, res) => {
    const campaignId = req.params.id;
    
    db.run(
        `UPDATE campaigns SET status = 'running' WHERE id = ?`,
        [campaignId],
        async (err) => {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }
            
            res.json({ success: true, message: 'Campaign started' });
            
            // Start sending messages in background
            try {
                const result = await sendBulkMessages(campaignId);
                console.log('Campaign completed:', result);
            } catch (error) {
                console.error('Campaign error:', error);
            }
        }
    );
});

// Pause campaign
app.post('/api/campaigns/:id/pause', (req, res) => {
    db.run(
        `UPDATE campaigns SET status = 'paused' WHERE id = ?`,
        [req.params.id],
        (err) => {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }
            res.json({ success: true });
        }
    );
});

// Delete campaign
app.delete('/api/campaigns/:id', (req, res) => {
    db.run('DELETE FROM messages WHERE campaign_id = ?', [req.params.id], (err) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        
        db.run('DELETE FROM campaigns WHERE id = ?', [req.params.id], (err) => {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }
            res.json({ success: true });
        });
    });
});

// ==================== TEMPLATES ====================

// Get all templates
app.get('/api/templates', (req, res) => {
    db.all('SELECT * FROM templates ORDER BY created_at DESC', [], (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(rows);
    });
});

// Create template
app.post('/api/templates', (req, res) => {
    const { name, content, variables } = req.body;
    
    db.run(
        `INSERT INTO templates (name, content, variables) VALUES (?, ?, ?)`,
        [name, content, JSON.stringify(variables)],
        function(err) {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }
            res.json({ id: this.lastID, success: true });
        }
    );
});

// Delete template
app.delete('/api/templates/:id', (req, res) => {
    db.run('DELETE FROM templates WHERE id = ?', [req.params.id], (err) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json({ success: true });
    });
});

// ==================== ANALYTICS ====================

app.get('/api/analytics', (req, res) => {
    const stats = {};
    
    db.get('SELECT COUNT(*) as total FROM contacts', [], (err, row) => {
        stats.totalContacts = row.total;
        
        db.get('SELECT COUNT(*) as total FROM campaigns', [], (err, row) => {
            stats.totalCampaigns = row.total;
            
            db.get('SELECT COUNT(*) as total FROM messages WHERE status = "sent"', [], (err, row) => {
                stats.messagesSent = row.total;
                
                db.get('SELECT COUNT(*) as total FROM messages WHERE status = "failed"', [], (err, row) => {
                    stats.messagesFailed = row.total;
                    
                    res.json(stats);
                });
            });
        });
    });
});

// ==================== SCHEDULER ====================

// Check for scheduled campaigns every minute
cron.schedule('* * * * *', () => {
    db.all(
        `SELECT * FROM campaigns 
         WHERE status = 'scheduled' 
         AND datetime(scheduled_at) <= datetime('now')`,
        [],
        async (err, campaigns) => {
            if (err) {
                console.error('Scheduler error:', err);
                return;
            }
            
            for (const campaign of campaigns) {
                console.log('Starting scheduled campaign:', campaign.id);
                db.run(
                    `UPDATE campaigns SET status = 'running' WHERE id = ?`,
                    [campaign.id]
                );
                
                try {
                    await sendBulkMessages(campaign.id);
                } catch (error) {
                    console.error('Error in scheduled campaign:', error);
                }
            }
        }
    );
});

// ==================== EVOLUTION API COMPATIBILITY ====================

// Evolution API - Instance info
app.get('/api/evolution/instance/:instance', (req, res) => {
    res.json({
        instance: req.params.instance,
        status: isClientReady ? 'open' : 'close',
        qrcode: qrCodeData
    });
});

// Evolution API - Send text
app.post('/api/evolution/message/sendText/:instance', async (req, res) => {
    const { number, textMessage } = req.body;
    
    try {
        if (!isClientReady) {
            throw new Error('Instance not ready');
        }
        
        let formattedPhone = number.replace(/\D/g, '');
        if (!formattedPhone.includes('@c.us')) {
            formattedPhone = formattedPhone + '@c.us';
        }
        
        await client.sendMessage(formattedPhone, textMessage.text);
        
        res.json({
            key: {
                remoteJid: formattedPhone,
                fromMe: true,
                id: Date.now().toString()
            },
            message: { conversation: textMessage.text },
            messageTimestamp: Date.now()
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Evolution API - Send media
app.post('/api/evolution/message/sendMedia/:instance', async (req, res) => {
    const { number, mediaMessage } = req.body;
    
    try {
        if (!isClientReady) {
            throw new Error('Instance not ready');
        }
        
        let formattedPhone = number.replace(/\D/g, '');
        if (!formattedPhone.includes('@c.us')) {
            formattedPhone = formattedPhone + '@c.us';
        }
        
        const media = await MessageMedia.fromUrl(mediaMessage.mediaUrl);
        await client.sendMessage(formattedPhone, media, {
            caption: mediaMessage.caption
        });
        
        res.json({
            key: {
                remoteJid: formattedPhone,
                fromMe: true,
                id: Date.now().toString()
            },
            messageTimestamp: Date.now()
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== SERVER START ====================

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════╗
║   🚀 WhatsApp Bulk Sender Pro Started     ║
║   📡 Server: http://localhost:${PORT}     ║
║   ⚡ Status: Ready                         ║
╚════════════════════════════════════════════╝
    `);
});

// Create uploads directory if not exists
if (!fs.existsSync('./public/uploads')) {
    fs.mkdirSync('./public/uploads', { recursive: true });
}

// Create database directory if not exists
if (!fs.existsSync('./database')) {
    fs.mkdirSync('./database');
}
